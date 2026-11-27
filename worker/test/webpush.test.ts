import { describe, expect, it, vi } from "vitest";
import { parseDeviceKeys, sendPush, topicFor, vapidJwt, base64UrlToBytes } from "../src/notify/webpush";
import { observeEndpoints, workflowObservation, argoObservation, GROUP_MIN } from "../src/notify/sources";
import { span } from "../src/notify/deliver";
import type { CheckResult } from "../src/health";
import type { Env } from "../src/env";
import type { Target } from "../src/targets";
import { fakeDevice, vapidKeys } from "./helpers/push";

const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));

describe("sendPush", () => {
  it("sends an encrypted body, a VAPID JWT that verifies against hdctl's public key, and the delivery headers", async () => {
    const vapid = await vapidKeys();
    const device = await fakeDevice();
    const seen: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(null, { status: 201 });
    });

    const keys = { endpoint: device.subscription.endpoint, ...device.subscription.keys };
    const outcome = await sendPush(vapid as unknown as Env, keys, { hello: "phone" }, { ttl: 3600, urgency: "high", topic: "abc" });
    expect(outcome).toEqual({ ok: true, status: 201 });

    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(req.headers.get("TTL")).toBe("3600");
    expect(req.headers.get("Urgency")).toBe("high");
    expect(req.headers.get("Topic")).toBe("abc");
    expect(await device.decrypt(new Uint8Array(await req.arrayBuffer()))).toEqual({ hello: "phone" });

    const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.get("Authorization") ?? "");
    expect(m?.[2]).toBe(vapid.VAPID_PUBLIC_KEY);
    const [h, c, s] = m![1]!.split(".") as [string, string, string];
    expect(decode(h)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decode(c)).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://hdctl.test" });
    expect(decode(c).exp).toBeGreaterThan(Date.now() / 1000);
    const key = await crypto.subtle.importKey("raw", base64UrlToBytes(vapid.VAPID_PUBLIC_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64UrlToBytes(s), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });

  it("sorts the push service's answers into keep, forget, retry and give up", async () => {
    const vapid = (await vapidKeys()) as unknown as Env;
    const d = await fakeDevice();
    const keys = { endpoint: d.subscription.endpoint, ...d.subscription.keys };
    const answer = async (res: () => Response) => {
      vi.stubGlobal("fetch", async () => res());
      return sendPush(vapid, keys, {}, { ttl: 60, urgency: "normal" });
    };
    expect(await answer(() => new Response(null, { status: 410 }))).toMatchObject({ ok: false, gone: true });
    expect(await answer(() => new Response(null, { status: 404 }))).toMatchObject({ ok: false, gone: true });
    expect(await answer(() => new Response(null, { status: 429 }))).toMatchObject({ ok: false, gone: false, retry: true });
    expect(await answer(() => new Response("oops", { status: 502 }))).toMatchObject({ retry: true, error: "push service answered HTTP 502: oops" });
    expect(await answer(() => new Response("too big", { status: 413 }))).toMatchObject({ retry: false, status: 413 });
    expect(
      await answer(() => {
        throw new TypeError("network down");
      }),
    ).toMatchObject({ retry: true, status: null, error: "push service unreachable: network down" });
  });

  it("refuses to sign without hdctl's keys", async () => {
    const d = await fakeDevice();
    expect(await sendPush({} as Env, { endpoint: d.subscription.endpoint, ...d.subscription.keys }, {}, { ttl: 60, urgency: "normal" })).toMatchObject({
      ok: false,
      retry: false,
      error: expect.stringContaining("VAPID keys aren't set"),
    });
  });

  it("makes a topic RFC 8030 accepts, the same one for the same key", async () => {
    const t = await topicFor("target:harbor");
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await topicFor("target:harbor")).toBe(t);
    expect(await topicFor("target:immich")).not.toBe(t);
  });

  it("signs JWTs that expire in twelve hours", async () => {
    const v = await vapidKeys();
    const jwt = await vapidJwt("https://web.push.apple.com", "https://hdctl.test", v.VAPID_PUBLIC_KEY, v.VAPID_PRIVATE_KEY, 1_000_000_000);
    expect(decode(jwt.split(".")[1]!).exp).toBe(1_000_000 + 12 * 3600);
  });
});

describe("parseDeviceKeys", () => {
  it("accepts each browser's push service", async () => {
    const d = await fakeDevice();
    for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "api.push.apple.com", "wns2-par02p.notify.windows.com"]) {
      expect(parseDeviceKeys({ ...d.subscription, endpoint: `https://${host}/x/y` }).endpoint).toBe(`https://${host}/x/y`);
    }
  });

  it("refuses everything else", async () => {
    const d = await fakeDevice();
    for (const endpoint of ["https://fcm.googleapis.com.evil.example/x", "https://evilpush.apple.com.example/x", "https://user:pw@fcm.googleapis.com/x", "ftp://fcm.googleapis.com/x", 42]) {
      expect(() => parseDeviceKeys({ ...d.subscription, endpoint }), String(endpoint)).toThrow();
    }
    expect(() => parseDeviceKeys({ endpoint: d.subscription.endpoint, keys: { p256dh: d.subscription.keys.p256dh, auth: "AAAA" } })).toThrow(/16 bytes/);
    expect(() => parseDeviceKeys(null)).toThrow();
    // Oversized keys are refused before any regular expression or decoding runs over them.
    expect(() => parseDeviceKeys({ endpoint: d.subscription.endpoint, keys: { p256dh: "A".repeat(100_000) + "=".repeat(100_000), auth: d.subscription.keys.auth } })).toThrow(/required/);
  });
});

describe("endpoint rules", () => {
  const target = (id: string, group: Target["group"]): Target =>
    ({ id, name: id.toUpperCase(), group, binding: id, service: id, address: { ipv4: "10.0.0.1" }, scheme: "https", port: 443, host: id, check: { path: "/", expect: [200] } }) as Target;
  const result = (id: string, state: CheckResult["state"], detail: string | null = null): CheckResult => ({ targetId: id, at: 0, state, code: state === "up" ? 200 : null, latencyMs: 1, detail });
  const lab = [...Array.from({ length: 6 }, (_, i) => target(`a${i}`, "apps")), ...Array.from({ length: 4 }, (_, i) => target(`v${i}`, "vault"))];

  it("calls it a lab-wide outage at 80% down, not below", () => {
    const at = (n: number) => observeEndpoints(lab.map((t, i) => result(t.id, i < n ? "down" : "up")), lab).problems.map((p) => p.key);
    expect(at(8)).toEqual(["lab"]);
    expect(at(7)).toEqual(["group:apps", "target:v0"]);
  });

  it("only folds groups of at least three", () => {
    const small = [target("x1", "network"), target("x2", "network"), ...lab];
    expect(GROUP_MIN).toBe(3);
    const keys = observeEndpoints(small.map((t) => result(t.id, t.group === "network" ? "down" : "up")), small).problems.map((p) => p.key);
    expect(keys).toEqual(["target:x1", "target:x2"]);
  });

  it("names the commonest cause for a group", () => {
    const obs = observeEndpoints(
      lab.map((t) => result(t.id, t.group === "vault" ? "down" : "up", t.id === "v0" ? "sealed" : "connection refused")),
      lab,
    );
    expect(obs.problems[0]).toMatchObject({ key: "group:vault", body: "V0, V1, V2, V3: connection refused" });
  });

  it("can't tell whether a folded target recovered, but knows one that's up has", () => {
    const obs = observeEndpoints(lab.map((t) => result(t.id, t.id === "v3" ? "up" : "down")), lab);
    expect(obs.problems.map((p) => p.key)).toEqual(["lab"]);
    expect(obs.resolution("target:a0")).toBeNull();
    expect(obs.resolution("target:v3")).toBe("back up (HTTP 200)");
    expect(obs.resolution("target:gone-from-targets-json")).toBe("no longer monitored");
  });
});

describe("Argo CD rules", () => {
  const app = (name: string, health: string, operation: string | null) => ({ name, health, operation, healthMessage: null, operationMessage: null }) as Parameters<typeof argoObservation>[0][number];
  it("waits out a rollout before calling it either way", () => {
    const obs = argoObservation([app("a", "Progressing", "Running"), app("b", "Healthy", "Succeeded")]);
    expect(obs.problems).toEqual([]);
    expect(obs.resolution("argo:a:health")).toBeNull();
    expect(obs.resolution("argo:a:sync")).toBeNull();
    expect(obs.resolution("argo:b:sync")).toBe("synced");
    expect(obs.resolution("argo:gone:health")).toBe("no longer in Argo CD");
  });
});

describe("workflow rules", () => {
  const run = (n: number, conclusion: string, over: Partial<Parameters<typeof workflowObservation>[1][number]> = {}) => ({
    repo: "o/r", workflow: "CI", workflowId: 1, title: `t${n}`, event: "push", status: "completed", conclusion, branch: "main", runNumber: n, createdAt: `2026-11-07T12:${String(n).padStart(2, "0")}:00Z`, url: "u", ...over,
  });
  const branches = new Map([["o/r", "main"]]);

  it("judges each workflow by its latest finished run on the default branch only", () => {
    const obs = workflowObservation("github", [run(1, "failure"), run(2, "success", { status: "in_progress", conclusion: null as never }), run(3, "failure", { branch: "feature" }), run(4, "failure", { event: "pull_request" })], branches);
    expect(obs.problems.map((p) => p.key)).toEqual(["github:o/r:1"]);
    expect(workflowObservation("github", [run(1, "failure"), run(2, "success")], branches).resolution("github:o/r:1")).toBe("fixed by run #2");
    expect(workflowObservation("github", [run(1, "failure"), run(2, "cancelled")], branches).problems).toEqual([]);
    expect(workflowObservation("github", [run(1, "failure"), run(2, "cancelled")], branches).resolution("github:o/r:1")).toBeNull();
    expect(workflowObservation("github", [], new Map()).resolution("github:o/r:1")).toBe("repository no longer active");
  });
});

describe("span", () => {
  it("reads like a person wrote it", () => {
    expect(span(30_000)).toBe("1 min");
    expect(span(12 * 60_000)).toBe("12 min");
    expect(span(125 * 60_000)).toBe("2 h 5 min");
    expect(span(3 * 3600_000)).toBe("3 h");
    expect(span(5 * 24 * 3600_000)).toBe("5 days");
  });
});
