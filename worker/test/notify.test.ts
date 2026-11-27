import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGIN, action, call, cron, healthy, testEnv, type Internet, type TestEnv, type Upstream } from "./helpers/worker";
import { fakeDevice, vapidKeys, type FakeDevice } from "./helpers/push";
import { TARGETS } from "../src/targets";
import type { Env } from "../src/env";
import type { PushPayload } from "../src/notify/deliver";

/**
 * Push notifications end to end: the real cron and routes, against fake
 * targets and a fake push service, with every push decrypted the way the
 * device would decrypt it. So these say what a phone would actually show.
 */

const T0 = Date.UTC(2026, 10, 7, 12, 1, 0); // an odd minute: the forges aren't due
const MIN = 60_000;

const refused: Upstream = () => {
  throw new TypeError("connection refused");
};
const http = (code: number): Upstream => () => new Response(null, { status: code });
/** Every target healthy except `ids`, which answer as `outcome` says. */
const allBut =
  (ids: string[], outcome: Upstream, rest: Upstream = healthy): Upstream =>
  (t, req) =>
    ids.includes(t.id) ? outcome(t, req) : rest(t, req);

const accept: Internet = () => new Response(null, { status: 201 });

let now = T0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  now = T0;
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

/** One cron run, then two minutes pass. */
async function tick(t: TestEnv, times = 1) {
  for (let i = 0; i < times; i++) {
    await cron(t.env);
    now += 2 * MIN;
    vi.setSystemTime(now);
  }
}

async function setup(opts: { upstream?: Upstream; internet?: Internet; vars?: Partial<Env> } = {}) {
  return testEnv({ upstream: opts.upstream, internet: opts.internet ?? accept, vars: { ...(await vapidKeys()), ...opts.vars } });
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "X-Hdctl": "1", Origin: ORIGIN, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

type Device = FakeDevice & { id: number };

async function enable(t: TestEnv, name = "phone", prefs?: Record<string, unknown>): Promise<Device> {
  const device = await fakeDevice(name);
  const res = await action(t.env, "/api/notify/devices", { subscription: device.subscription, label: name });
  expect(res.status, await res.clone().text()).toBe(200);
  const { device: row } = (await res.json()) as { device: { id: number } };
  if (prefs) expect((await call(t.env, `/api/notify/devices/${row.id}`, json("PATCH", prefs))).status).toBe(200);
  return { ...device, id: row.id };
}

/** Everything the push service was asked to deliver to this device, decrypted, in order. */
async function received(t: TestEnv, d: FakeDevice): Promise<PushPayload[]> {
  const out: PushPayload[] = [];
  for (const req of t.internetCalls) {
    if (req.url !== d.subscription.endpoint) continue;
    out.push((await d.decrypt(new Uint8Array(await req.clone().arrayBuffer()))) as PushPayload);
  }
  return out;
}
const alarms = async (t: TestEnv, d: FakeDevice) => (await received(t, d)).filter((p) => p.kind !== "test");
const requestsTo = (t: TestEnv, d: FakeDevice) => t.internetCalls.filter((r) => r.url === d.subscription.endpoint);
const incidents = (t: TestEnv) => t.d1.query<{ key: string; notified_at: number | null; resolved_at: number | null; seen: number }>("SELECT key, notified_at, resolved_at, seen FROM incidents ORDER BY id");

describe("endpoint notifications", () => {
  it("waits for a second failed check, then pushes once to every device", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t, "phone");
    const laptop = await enable(t, "laptop");

    await tick(t);
    expect(await alarms(t, phone)).toEqual([]);
    expect(incidents(t)).toMatchObject([{ key: "target:harbor", notified_at: null, seen: 1 }]);

    await tick(t);
    for (const d of [phone, laptop]) {
      const pushes = await alarms(t, d);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ v: 1, kind: "open", tag: "hdctl:target:harbor", severity: "critical", title: "Harbor is down", url: "/", at: T0, open: 1 });
      expect(pushes[0]!.body).toMatch(/^connection refused · /);
    }

    await tick(t, 3);
    expect(await alarms(t, phone)).toHaveLength(1);
  });

  it("pushes the recovery under the same tag and topic, saying how long it lasted", async () => {
    const t = await setup({ upstream: allBut(["harbor"], http(502)) });
    const phone = await enable(t);
    await tick(t, 3);
    t.setUpstream(healthy);
    await tick(t);

    const [down, up] = await alarms(t, phone);
    expect(up).toMatchObject({ kind: "resolve", tag: down!.tag, title: "Resolved: Harbor", body: "Back up (HTTP 200) after 6 min.", at: T0 + 6 * MIN, open: 0 });
    const [downReq, upReq] = requestsTo(t, phone).slice(-2);
    expect(downReq!.headers.get("Urgency")).toBe("high");
    expect(upReq!.headers.get("Urgency")).toBe("normal");
    expect(upReq!.headers.get("Topic")).toBe(downReq!.headers.get("Topic"));
    expect(downReq!.headers.get("Topic")).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(incidents(t)).toMatchObject([{ key: "target:harbor", resolved_at: T0 + 6 * MIN }]);
  });

  it("forgets a failure that clears before anyone is told", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    await tick(t);
    t.setUpstream(healthy);
    await tick(t, 2);
    expect(await alarms(t, phone)).toEqual([]);
    expect(incidents(t)).toEqual([]);
  });

  it("sends one notification, not dozens, when the whole lab is unreachable", async () => {
    const t = await setup({ upstream: refused });
    const phone = await enable(t);
    await tick(t, 3);
    const pushes = await alarms(t, phone);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ tag: "hdctl:lab", title: "hdctl can't reach the lab", severity: "critical" });
    expect(pushes[0]!.body).toContain(`${TARGETS.length} of ${TARGETS.length} endpoints are down (connection refused)`);
    expect(incidents(t).map((i) => i.key)).toEqual(["lab"]);

    t.setUpstream(healthy);
    await tick(t);
    expect((await alarms(t, phone))[1]).toMatchObject({ kind: "resolve", title: "Resolved: The lab", body: "Reachable again after 6 min." });
  });

  it("folds a whole group that's down into one notification", async () => {
    const cluster = TARGETS.filter((x) => x.group === "cluster").map((x) => x.id);
    const t = await setup({ upstream: allBut(cluster, http(503)) });
    const phone = await enable(t);
    await tick(t, 2);
    const pushes = await alarms(t, phone);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ tag: "hdctl:group:cluster", title: `Cluster apps: all ${cluster.length} down` });
    expect(pushes[0]!.body).toContain("HTTP 503, expected");
  });

  it("keeps a target's own incident open while it's folded into a lab-wide one", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    await tick(t, 2); // harbor notified
    t.setUpstream(refused);
    await tick(t, 2); // the lab goes too
    expect(incidents(t).filter((i) => i.resolved_at === null).map((i) => i.key)).toEqual(["target:harbor", "lab"]);
    t.setUpstream(allBut(["harbor"], refused));
    await tick(t);
    // The lab is back; harbor never was, so no "Harbor recovered".
    expect((await alarms(t, phone)).map((p) => `${p.kind} ${p.tag}`)).toEqual(["open hdctl:target:harbor", "open hdctl:lab", "resolve hdctl:lab"]);
  });

  it("keeps a target folded into a days-long lab outage open, rather than calling it over", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    await tick(t, 2);
    t.setUpstream(refused);
    await tick(t, 2);
    vi.setSystemTime((now += 4 * 24 * 60 * MIN));
    await tick(t);
    expect(incidents(t).filter((i) => i.resolved_at === null).map((i) => i.key)).toEqual(["target:harbor", "lab"]);
    expect((await alarms(t, phone)).map((p) => p.kind)).toEqual(["open", "open"]);
  });

  it("escalates degraded to down, by each device's own minimum severity", async () => {
    const t = await setup({ upstream: allBut(["paperless"], http(404)) });
    const laptop = await enable(t, "laptop");
    const phone = await enable(t, "phone", { minSeverity: "critical" });
    await tick(t, 2);
    expect(await alarms(t, laptop)).toMatchObject([{ kind: "open", severity: "warning", title: "Paperless is degraded" }]);
    expect(requestsTo(t, laptop).at(-1)!.headers.get("Urgency")).toBe("normal");
    expect(await alarms(t, phone)).toEqual([]);

    t.setUpstream(allBut(["paperless"], refused));
    await tick(t);
    expect((await alarms(t, laptop))[1]).toMatchObject({ kind: "escalate", severity: "critical", title: "Now critical: Paperless is down" });
    expect(await alarms(t, phone)).toMatchObject([{ kind: "escalate", severity: "critical" }]);

    await tick(t, 2);
    expect(await alarms(t, laptop)).toHaveLength(2);
  });

  it("doesn't push a downgrade, and tells a critical-only device about recoveries only of what it was told", async () => {
    const t = await setup({ upstream: allBut(["paperless"], http(404)) });
    const phone = await enable(t, "phone", { minSeverity: "critical" });
    await tick(t, 2);
    t.setUpstream(healthy);
    await tick(t);
    expect(await alarms(t, phone)).toEqual([]);
  });
});

describe("acknowledging, muting and pausing", () => {
  it("acknowledging stops escalation and clears the badge; the recovery still comes", async () => {
    const t = await setup({ upstream: allBut(["paperless"], http(404)) });
    const phone = await enable(t);
    await tick(t, 2);
    const [{ id }] = (await alarms(t, phone)) as [PushPayload];
    const res = await action(t.env, `/api/notify/incidents/${id}/ack`);
    expect(await res.json()).toMatchObject({ incident: { ackedBy: "owner@example.com" }, open: 0 });

    t.setUpstream(allBut(["paperless"], refused));
    await tick(t);
    expect(await alarms(t, phone)).toHaveLength(1);
    t.setUpstream(healthy);
    await tick(t);
    expect((await alarms(t, phone))[1]).toMatchObject({ kind: "resolve", open: 0 });
  });

  it("muting a thing records it but pushes nothing about it until the mute ends", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    await tick(t, 2);
    const [{ id }] = (await alarms(t, phone)) as [PushPayload];
    expect((await action(t.env, `/api/notify/incidents/${id}/mute`, { minutes: 60 })).status).toBe(200);

    t.setUpstream(healthy);
    await tick(t);
    t.setUpstream(allBut(["harbor"], refused));
    await tick(t, 2);
    expect(await alarms(t, phone)).toHaveLength(1);
    // The first one resolved and a second opened, both while muted: recorded, not pushed.
    expect(incidents(t).map((i) => [i.key, i.resolved_at === null])).toEqual([
      ["target:harbor", false],
      ["target:harbor", true],
    ]);

    vi.setSystemTime((now += 61 * MIN));
    t.setUpstream(allBut(["harbor", "immich"], refused));
    await tick(t, 2);
    expect((await alarms(t, phone)).map((p) => p.tag)).toEqual(["hdctl:target:harbor", "hdctl:target:immich"]);
  });

  it("pausing everything holds every push, and shows on the page", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    expect((await action(t.env, "/api/notify/pause", { minutes: 240 })).status).toBe(200);
    await tick(t, 3);
    expect(await alarms(t, phone)).toEqual([]);
    const feed = (await (await call(t.env, "/api/notify/incidents")).json()) as { open: { mutedUntil: number | null }[]; mutes: { key: string; label: string; id: number }[] };
    expect(feed.mutes).toMatchObject([{ key: "*", label: "everything" }]);
    expect(feed.open[0]!.mutedUntil).toBe(T0 + 240 * MIN);

    // A test push is asked for, so it goes anyway.
    expect(await (await action(t.env, `/api/notify/devices/${phone.id}/test`)).json()).toMatchObject({ ok: true, status: 201 });
    expect((await call(t.env, `/api/notify/mutes/${feed.mutes[0]!.id}`, json("DELETE"))).status).toBe(200);
    t.setUpstream(allBut(["immich"], refused));
    await tick(t, 2);
    // Harbor came back while paused: nobody was told it went, so nobody is told it's back.
    expect((await alarms(t, phone)).map((p) => `${p.kind} ${p.tag}`)).toEqual(["open hdctl:target:immich"]);
  });

  it("refuses mutes of nothing, or for longer than a week", async () => {
    const t = await setup();
    expect((await action(t.env, "/api/notify/incidents/999/mute", { minutes: 60 })).status).toBe(404);
    expect((await action(t.env, "/api/notify/pause", { minutes: 60 * 24 * 8 })).status).toBe(400);
    expect((await action(t.env, "/api/notify/pause", { minutes: "soon" })).status).toBe(400);
    expect((await action(t.env, "/api/notify/incidents/abc/ack")).status).toBe(400);
  });
});

describe("Alertmanager", () => {
  const am = (alerts: unknown[] | (() => Response)): Upstream =>
    allBut(["alertmanager"], (t, req) => (new URL(req.url).pathname === "/api/v2/alerts" ? (typeof alerts === "function" ? alerts() : Response.json(alerts)) : healthy(t, req)));
  const firing = (fp: string, labels: Record<string, string>, status = { silencedBy: [] as string[], inhibitedBy: [] as string[] }) => ({
    fingerprint: fp,
    labels,
    annotations: { summary: "Disk will fill within 4 hours." },
    startsAt: "2026-11-07T11:00:00Z",
    status,
  });

  it("pushes a new firing alert at once, and its resolution when it leaves Alertmanager", async () => {
    const alert = firing("f1", { alertname: "NodeFilesystemAlmostOutOfSpace", severity: "critical", instance: "pve4:9100" });
    const t = await setup({ upstream: am([alert, firing("w", { alertname: "Watchdog", severity: "none" })]) });
    const phone = await enable(t);
    await tick(t);
    expect(await alarms(t, phone)).toMatchObject([
      { kind: "open", tag: "hdctl:alert:f1", severity: "critical", title: "NodeFilesystemAlmostOutOfSpace on pve4:9100", body: "Disk will fill within 4 hours.", url: "/metrics" },
    ]);
    t.setUpstream(am([]));
    await tick(t);
    expect((await alarms(t, phone))[1]).toMatchObject({ kind: "resolve", title: "Resolved: NodeFilesystemAlmostOutOfSpace", body: "No longer firing after 2 min." });
  });

  it("calls an alert silenced in Alertmanager over, and says so", async () => {
    const t = await setup({ upstream: am([firing("f1", { alertname: "KubeJobFailed", severity: "warning" })]) });
    const phone = await enable(t);
    await tick(t);
    t.setUpstream(am([firing("f1", { alertname: "KubeJobFailed", severity: "warning" }, { silencedBy: ["s1"], inhibitedBy: [] })]));
    await tick(t);
    expect((await alarms(t, phone))[1]).toMatchObject({ kind: "resolve", body: "Silenced in Alertmanager after 2 min." });
  });

  it("resolves nothing when Alertmanager can't be read, and the page says why", async () => {
    const t = await setup({ upstream: am([firing("f1", { alertname: "KubeJobFailed", severity: "warning" })]) });
    const phone = await enable(t);
    await tick(t);
    t.setUpstream(am(() => new Response("upstream connect error", { status: 503 })));
    await tick(t, 3);
    expect(await alarms(t, phone)).toHaveLength(1);
    const feed = (await (await call(t.env, "/api/notify/incidents")).json()) as { open: unknown[]; feeds: { feed: string; error: string | null; okAt: number | null }[] };
    expect(feed.open).toHaveLength(1);
    expect(feed.feeds.find((f) => f.feed === "alert")).toMatchObject({ error: expect.stringContaining("HTTP 503"), okAt: T0 });
    expect(feed.feeds.find((f) => f.feed === "endpoint")).toMatchObject({ error: null });
  });

  it("sends info alerts only to devices that asked for everything", async () => {
    const t = await setup({ upstream: am([firing("i1", { alertname: "CPUThrottlingHigh", severity: "info" })]) });
    const laptop = await enable(t, "laptop", { minSeverity: "info" });
    const phone = await enable(t, "phone");
    await tick(t);
    expect(await alarms(t, laptop)).toMatchObject([{ severity: "info" }]);
    expect(requestsTo(t, laptop).at(-1)!.headers.get("Urgency")).toBe("low");
    expect(await alarms(t, phone)).toEqual([]);
  });
});

describe("Argo CD", () => {
  const argo = (apps: () => unknown[]): Upstream =>
    allBut(["argo"], (t, req) => (new URL(req.url).pathname === "/api/v1/applications" ? Response.json({ items: apps() }) : healthy(t, req)));
  const app = (name: string, health: string, phase: string | null = "Succeeded", message?: string) => ({
    metadata: { name },
    spec: { project: "default" },
    status: { health: { status: health, message: `${name} health` }, sync: { status: "Synced" }, operationState: phase ? { phase, message } : undefined },
  });

  it("pushes an app degraded for two runs, and a failed sync at once", async () => {
    let apps = [app("immich", "Degraded"), app("harbor", "Healthy", "Failed", "one or more objects failed to apply")];
    const t = await setup({ upstream: argo(() => apps), vars: { ARGOCD_TOKEN: "argo-token" } });
    const phone = await enable(t);
    await tick(t);
    expect(await alarms(t, phone)).toMatchObject([{ tag: "hdctl:argo:harbor:sync", title: "Sync failed: harbor", body: "one or more objects failed to apply", url: "/argo" }]);
    await tick(t);
    expect((await alarms(t, phone))[1]).toMatchObject({ tag: "hdctl:argo:immich:health", title: "immich is degraded in Argo CD", severity: "warning" });

    apps = [app("immich", "Progressing"), app("harbor", "Healthy", "Running")];
    await tick(t);
    expect(await alarms(t, phone)).toHaveLength(2);
    apps = [app("immich", "Healthy"), app("harbor", "Healthy", "Succeeded")];
    await tick(t);
    expect((await alarms(t, phone)).slice(2).map((p) => p.body).sort()).toEqual(["Healthy again after 6 min.", "Synced after 6 min."]);
  });

  it("isn't evaluated without a token, and says nothing about it", async () => {
    const t = await setup();
    await tick(t);
    expect(t.calls.filter((c) => c.target === "argo" && c.path.startsWith("/api/"))).toEqual([]);
    const feed = (await (await call(t.env, "/api/notify/incidents")).json()) as { feeds: { feed: string }[] };
    expect(feed.feeds.map((f) => f.feed)).toEqual(["alert", "endpoint"]);
  });
});

describe("workflow failures", () => {
  const AT_TEN = Date.UTC(2026, 10, 7, 12, 10, 0);
  const run = (id: number, repo: string, conclusion: string, extra: Record<string, unknown> = {}) => ({
    id, name: "Deploy", display_title: `merge #${id}`, path: ".github/workflows/deploy.yml", event: "push", status: "completed", conclusion,
    head_branch: "main", run_number: id, run_attempt: 1, created_at: new Date(AT_TEN - (100 - id) * MIN).toISOString(), updated_at: "2026-11-07T12:00:00Z",
    html_url: `https://github.com/${repo}/actions/runs/${id}`, workflow_id: 42, ...extra,
  });
  function github(runs: () => Record<string, unknown[]>): Internet {
    return (req) => {
      const u = new URL(req.url);
      if (u.hostname !== "api.github.com") return accept(req);
      if (u.pathname === "/user/repos") {
        return Response.json([
          { full_name: "mike12806/hdctl", owner: { login: "mike12806" }, archived: false, default_branch: "main" },
          { full_name: "mike12806/gh_hdc", owner: { login: "mike12806" }, archived: false, default_branch: "main" },
        ]);
      }
      const m = /^\/repos\/(.+)\/actions\/runs$/.exec(u.pathname);
      return m ? Response.json({ workflow_runs: runs()[m[1]!] ?? [] }) : new Response("{}", { status: 404 });
    };
  }

  it("pushes when main's latest run of a workflow failed, ignores pull requests, and resolves on the fix", async () => {
    vi.setSystemTime((now = AT_TEN));
    let runs: Record<string, unknown[]> = {
      "mike12806/hdctl": [run(10, "mike12806/hdctl", "failure"), run(9, "mike12806/hdctl", "success")],
      "mike12806/gh_hdc": [run(11, "mike12806/gh_hdc", "failure", { event: "pull_request", head_branch: "renovate/x" })],
    };
    const t = await setup({ internet: github(() => runs), vars: { GITHUB_TOKEN: "gh" } });
    const phone = await enable(t);
    await tick(t);
    expect(await alarms(t, phone)).toMatchObject([
      { tag: "hdctl:github:mike12806/hdctl:42", title: "Deploy failed in hdctl", body: "Run #10 on main (push): merge #10", url: "/actions", severity: "warning" },
    ]);

    runs = { "mike12806/hdctl": [run(12, "mike12806/hdctl", "success"), ...runs["mike12806/hdctl"]!] };
    await tick(t, 4); // 12:12 to 12:18: not due, nothing read
    expect(await alarms(t, phone)).toHaveLength(1);
    await tick(t); // 12:20
    expect((await alarms(t, phone))[1]).toMatchObject({ kind: "resolve", title: "Resolved: hdctl · Deploy", body: "Fixed by run #12 after 10 min." });
  });
});

describe("workflow age-out", () => {
  it("closes a failed workflow nothing has been heard of for three days (deleted, renamed)", async () => {
    vi.setSystemTime((now = Date.UTC(2026, 10, 7, 12, 10, 0)));
    const runs = [{ id: 1, name: "Old", display_title: "x", path: ".github/workflows/old.yml", event: "push", status: "completed", conclusion: "failure", head_branch: "main", run_number: 1, run_attempt: 1, created_at: "2026-11-07T11:00:00Z", updated_at: "2026-11-07T11:00:00Z", html_url: "https://github.com/x", workflow_id: 9 }];
    let list = runs;
    const internet: Internet = (req) => {
      const u = new URL(req.url);
      if (u.hostname !== "api.github.com") return accept(req);
      if (u.pathname === "/user/repos") return Response.json([{ full_name: "mike12806/hdctl", owner: { login: "mike12806" }, archived: false, default_branch: "main" }]);
      return Response.json({ workflow_runs: list });
    };
    const t = await setup({ internet, vars: { GITHUB_TOKEN: "gh" } });
    const phone = await enable(t);
    await cron(t.env);
    list = [];
    vi.setSystemTime((now += 2 * 24 * 60 * MIN));
    await cron(t.env);
    expect(incidents(t)).toMatchObject([{ resolved_at: null }]);
    vi.setSystemTime((now += 2 * 24 * 60 * MIN));
    await cron(t.env);
    expect((await alarms(t, phone)).at(-1)).toMatchObject({ kind: "resolve", body: "No longer reported after 4 days." });
  });
});

describe("delivery", () => {
  it("forgets a device the push service says is gone", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    t.setInternet(() => new Response("expired", { status: 410 }));
    await tick(t, 2);
    expect(t.d1.query("SELECT id FROM push_subscriptions")).toEqual([]);
    expect(requestsTo(t, phone)).toHaveLength(2); // the confirmation, then the 410
  });

  it("retries a push the push service couldn't take, while it's still true", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    let answer = 503;
    t.setInternet(() => new Response(null, { status: answer }));
    await tick(t, 2);
    expect(t.d1.query("SELECT kind, attempts FROM push_retries")).toEqual([{ kind: "open", attempts: 1 }]);
    expect(t.d1.query("SELECT last_error FROM push_subscriptions")).toEqual([{ last_error: "push service answered HTTP 503" }]);
    answer = 201;
    await tick(t);
    expect((await alarms(t, phone)).map((p) => p.kind)).toEqual(["open", "open"]);
    expect(t.d1.query("SELECT * FROM push_retries")).toEqual([]);
    expect(t.d1.query("SELECT last_error, last_sent_at FROM push_subscriptions")).toEqual([{ last_error: null, last_sent_at: T0 + 4 * MIN }]);
  });

  it("drops a retry once it's no longer true", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    t.setInternet(() => new Response(null, { status: 503 }));
    await tick(t, 2);
    t.setUpstream(healthy);
    t.setInternet(accept);
    await tick(t);
    // The stale "down" isn't retried; the recovery goes out.
    expect((await alarms(t, phone)).map((p) => p.kind)).toEqual(["open", "resolve"]);
  });

  it("gives up after four attempts, and doesn't retry what can't succeed", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    t.setInternet(() => new Response(null, { status: 503 }));
    await tick(t, 2 + 8);
    expect(requestsTo(t, phone)).toHaveLength(1 + 4);
    expect(t.d1.query("SELECT * FROM push_retries")).toEqual([]);

    const t2 = await setup({ upstream: allBut(["harbor"], refused) });
    const tablet = await enable(t2, "tablet");
    t2.setInternet(() => new Response("bad jwt", { status: 403 }));
    await tick(t2, 4);
    expect(requestsTo(t2, tablet)).toHaveLength(2);
    expect(t2.d1.query("SELECT last_error FROM push_subscriptions")).toEqual([{ last_error: "push service answered HTTP 403: bad jwt" }]);
  });

  it("pushes once when two cron runs overlap", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t);
    await tick(t);
    await Promise.all([cron(t.env), cron(t.env)]);
    await Promise.all([cron(t.env), cron(t.env)]);
    expect(await alarms(t, phone)).toHaveLength(1);
    expect(incidents(t)).toHaveLength(1);
  });

  it("follows each device's sources and recovery preference", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    const phone = await enable(t, "phone", { sources: ["alert", "argo"] });
    const laptop = await enable(t, "laptop", { recoveries: false });
    await tick(t, 2);
    t.setUpstream(healthy);
    await tick(t);
    expect(await alarms(t, phone)).toEqual([]);
    expect((await alarms(t, laptop)).map((p) => p.kind)).toEqual(["open"]);
  });

  it("records incidents but pushes nothing until the VAPID keys are set", async () => {
    const t = testEnv({ upstream: allBut(["harbor"], refused), internet: accept });
    await tick(t, 2);
    expect(incidents(t)).toMatchObject([{ key: "target:harbor", notified_at: T0 + 2 * MIN }]);
    expect(t.internetCalls).toEqual([]);
  });
});

describe("the devices API", () => {
  it("registers a device, confirms it with a push, and lists it without its keys", async () => {
    const t = await setup();
    const phone = await fakeDevice("phone", "web.push.apple.com");
    const res = await action(t.env, "/api/notify/devices", { subscription: phone.subscription, label: "iPhone · Safari" });
    expect(await res.json()).toMatchObject({ created: true, confirmation: { ok: true }, device: { label: "iPhone · Safari", service: "Apple", minSeverity: "warning", recoveries: true } });
    expect(await received(t, phone)).toMatchObject([{ kind: "test", tag: "hdctl:test", body: expect.stringContaining("Notifications are on for iPhone · Safari") }]);

    const list = await (await call(t.env, "/api/notify/devices")).json();
    const text = JSON.stringify(list);
    expect(text).not.toContain(phone.subscription.keys.auth);
    expect(text).not.toContain(phone.subscription.endpoint);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(phone.subscription.endpoint)));
    expect(list).toMatchObject({ publicKey: t.env.VAPID_PUBLIC_KEY, devices: [{ actor: "owner@example.com", endpointHash: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""), sources: ["endpoint", "alert", "argo", "workflow"] }] });

    // Registering again refreshes it, keeps its preferences, and doesn't push again.
    const again = await action(t.env, "/api/notify/devices", { subscription: phone.subscription });
    expect(await again.json()).toMatchObject({ created: false, confirmation: null, device: { label: "iPhone · Safari" } });
    expect(await received(t, phone)).toHaveLength(1);
  });

  it("moves preferences to the subscription a browser swapped in, and drops the old one", async () => {
    const t = await setup();
    const old = await enable(t, "old", { minSeverity: "critical", sources: ["endpoint"] });
    const fresh = await fakeDevice("fresh");
    const res = await action(t.env, "/api/notify/devices", { subscription: fresh.subscription, replaces: old.subscription.endpoint });
    expect(await res.json()).toMatchObject({ created: true, confirmation: null, device: { label: "old", minSeverity: "critical", sources: ["endpoint"] } });
    expect(t.d1.query("SELECT label FROM push_subscriptions")).toEqual([{ label: "old" }]);
  });

  it("refuses an endpoint that isn't a push service, before anything is stored or sent", async () => {
    const t = await setup();
    const d = await fakeDevice();
    for (const endpoint of ["https://evil.example.com/push", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://192.168.1.1/x", "not a url"]) {
      const res = await action(t.env, "/api/notify/devices", { subscription: { ...d.subscription, endpoint } });
      expect(res.status, endpoint).toBe(400);
    }
    const res = await action(t.env, "/api/notify/devices", { subscription: { ...d.subscription, keys: { p256dh: "AAAA", auth: d.subscription.keys.auth } } });
    expect(res.status).toBe(400);
    expect(t.d1.query("SELECT * FROM push_subscriptions")).toEqual([]);
    expect(t.internetCalls).toEqual([]);
  });

  it("refuses a registration made cross-site", async () => {
    const t = await setup();
    const d = await fakeDevice();
    const res = await call(t.env, "/api/notify/devices", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ subscription: d.subscription }) });
    expect(res.status).toBe(403);
    expect(t.d1.query("SELECT * FROM push_subscriptions")).toEqual([]);
  });

  it("says it isn't set up until the deploy has created the VAPID keys", async () => {
    const t = testEnv();
    const res = await call(t.env, "/api/notify/devices");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ setup: true, error: expect.stringContaining("ensure-vapid-keys.mjs") });
    expect((await call(t.env, "/api/notify/incidents")).status).toBe(200);
  });

  it("validates preferences, and removes a device", async () => {
    const t = await setup();
    const phone = await enable(t);
    for (const bad of [{ sources: [] }, { sources: ["email"] }, { minSeverity: "loud" }, { recoveries: "yes" }]) {
      expect((await call(t.env, `/api/notify/devices/${phone.id}`, json("PATCH", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(t.env, "/api/notify/devices/999", json("PATCH", { recoveries: false }))).status).toBe(404);
    expect((await call(t.env, `/api/notify/devices/${phone.id}`, json("DELETE"))).status).toBe(200);
    expect(t.d1.query("SELECT * FROM push_subscriptions")).toEqual([]);
  });

  it("reports what the push service said to a test push", async () => {
    const t = await setup();
    const phone = await enable(t);
    t.setInternet(() => new Response("VapidPkHashMismatch", { status: 403 }));
    expect(await (await action(t.env, `/api/notify/devices/${phone.id}/test`)).json()).toEqual({ ok: false, status: 403, gone: false, error: "push service answered HTTP 403: VapidPkHashMismatch" });
    const { devices } = (await (await call(t.env, "/api/notify/devices")).json()) as { devices: { lastError: string; lastErrorAt: number }[] };
    expect(devices[0]).toMatchObject({ lastError: "push service answered HTTP 403: VapidPkHashMismatch", lastErrorAt: T0 });
  });
});

describe("the incidents feed", () => {
  it("lists open, pending and recently resolved incidents, most severe first", async () => {
    const t = await setup({ upstream: allBut(["paperless"], http(404), allBut(["harbor"], refused)) });
    await enable(t);
    await tick(t, 2);
    t.setUpstream(allBut(["harbor", "immich"], refused));
    await tick(t);
    const feed = (await (await call(t.env, "/api/notify/incidents")).json()) as Record<string, { key: string; resolution?: string }[]>;
    expect(feed.open!.map((i) => i.key)).toEqual(["target:harbor"]);
    expect(feed.pending!.map((i) => i.key)).toEqual(["target:immich"]);
    expect(feed.recent).toMatchObject([{ key: "target:paperless", resolution: "back up (HTTP 200)" }]);
  });

  it("prunes what's past retention", async () => {
    const t = await setup({ upstream: allBut(["harbor"], refused) });
    await tick(t, 2);
    t.setUpstream(healthy);
    await tick(t);
    vi.setSystemTime((now += 31 * 24 * 60 * MIN));
    await tick(t);
    expect(incidents(t)).toEqual([]);
  });
});
