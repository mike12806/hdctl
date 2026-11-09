import { describe, expect, it } from "vitest";
import { BUILD, ORIGIN, OWNER, accessToken, action, call, testEnv } from "./helpers/worker";
import { newKeyPair } from "./helpers/access";

/** The Worker's outer layer: who gets in, which calls are allowed, and what the browser may cache. */

describe("Cloudflare Access check", () => {
  it.each(["/api/me", "/api/status", "/api/audit", "/", "/proxmox", "/assets/index-abc123.js"])(
    "refuses %s without a token, before serving or calling anything",
    async (path) => {
      const t = testEnv();
      const res = await call(t.env, path, { token: null });
      expect(res.status).toBe(401);
      expect(t.assetRequests).toEqual([]);
      expect(t.calls).toEqual([]);
    },
  );

  it("knows the owner from the Access header or the CF_Authorization cookie", async () => {
    const t = testEnv();
    expect(await (await call(t.env, "/api/me")).json()).toEqual({ email: OWNER });
    const viaCookie = await call(t.env, "/api/me", { token: null, headers: { Cookie: `a=b; CF_Authorization=${await accessToken()}` } });
    expect(await viaCookie.json()).toEqual({ email: OWNER });
  });

  it.each([
    ["another identity", { email: "someone@example.com" }],
    ["another Access application", { aud: ["another-app"] }],
    ["another team", { iss: "https://evil.cloudflareaccess.com" }],
    ["an expired session", { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])("refuses a token for %s", async (_, claims) => {
    const t = testEnv();
    expect((await call(t.env, "/api/me", { token: await accessToken(claims) })).status).toBe(401);
  });

  it("refuses a token signed by a key Access didn't publish", async () => {
    const t = testEnv();
    const forged = await accessToken({}, (await newKeyPair()).privateKey);
    expect((await call(t.env, "/api/me", { token: forged })).status).toBe(401);
  });

  it("serves nothing while CF_ACCESS_AUD is still the placeholder", async () => {
    const t = testEnv({ vars: { CF_ACCESS_AUD: "REPLACE_WITH_ACCESS_AUD" } });
    const res = await call(t.env, "/api/me", { token: await accessToken({ aud: ["REPLACE_WITH_ACCESS_AUD"] }) });
    expect(res.status).toBe(401);
  });

  it("lets DEV_MODE skip the check only for requests to localhost", async () => {
    const t = testEnv({ vars: { DEV_MODE: "true" } });
    expect((await call(t.env, "/api/me", { token: null })).status).toBe(401);
    const local = await call(t.env, "/api/me", { token: null, origin: "http://localhost:8787" });
    expect(await local.json()).toEqual({ email: "dev@localhost" });
  });

  it("answers the API with JSON and a page with a pointer to sign in", async () => {
    const t = testEnv();
    expect(await (await call(t.env, "/api/me", { token: null })).json()).toEqual({ error: "unauthorised" });
    expect(await (await call(t.env, "/", { token: null })).text()).toContain("sign in through Cloudflare Access");
  });
});

describe("state-changing calls", () => {
  const sync = "/api/argo/apps/cert-manager/sync";
  const argoOk = () => Response.json({ status: { operationState: { phase: "Running" } } });

  it.each([
    ["without the X-Hdctl header", { Origin: ORIGIN }],
    ["from another origin", { "X-Hdctl": "1", Origin: "https://evil.example" }],
  ])("are refused %s, before anything is sent or recorded", async (_, headers) => {
    const t = testEnv({ vars: { ARGOCD_TOKEN: "argo-token" }, upstream: argoOk });
    const res = await call(t.env, sync, { method: "POST", headers });
    expect(res.status).toBe(403);
    expect(t.calls).toEqual([]);
    expect(t.audit()).toEqual([]);
  });

  it("go through when made the way the app makes them", async () => {
    const t = testEnv({ vars: { ARGOCD_TOKEN: "argo-token" }, upstream: argoOk });
    expect((await action(t.env, sync)).status).toBe(200);
    expect(t.calls).toHaveLength(1);
  });
});

describe("caching headers", () => {
  it("never lets an API response be stored, and names the build", async () => {
    const t = testEnv();
    const res = await call(t.env, "/api/me");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Hdctl-Build")).toBe(BUILD);
  });

  it("marks API errors no-store too", async () => {
    const t = testEnv();
    for (const res of [await call(t.env, "/api/me", { token: null }), await call(t.env, "/api/nope"), await call(t.env, "/api/argo/apps")]) {
      expect(res.ok).toBe(false);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("has the browser revalidate the app shell on every load", async () => {
    const t = testEnv();
    for (const path of ["/", "/proxmox"]) {
      const res = await call(t.env, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(res.headers.get("X-Hdctl-Build")).toBe(BUILD);
    }
  });

  it("caches content-hashed assets for good, but not a missing one", async () => {
    const t = testEnv();
    expect((await call(t.env, "/assets/index-abc123.js")).headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    const missing = await call(t.env, "/assets/index-gone.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sets the security headers on everything", async () => {
    const t = testEnv();
    for (const res of [await call(t.env, "/api/me"), await call(t.env, "/"), await call(t.env, "/", { token: null })]) {
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });
});

describe("errors", () => {
  it("answers 503 with a setup hint while an integration's secret is missing, without calling out", async () => {
    const t = testEnv();
    for (const path of ["/api/argo/apps", "/api/proxmox", "/api/github/runs", "/api/unifi"]) {
      const res = await call(t.env, path);
      expect(res.status, path).toBe(503);
      expect(await res.json(), path).toMatchObject({ setup: true });
    }
    expect(t.calls).toEqual([]);
    expect(t.internetCalls).toEqual([]);
  });

  it("answers an unknown API path with a JSON 404 rather than the app", async () => {
    const t = testEnv();
    const res = await call(t.env, "/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(t.assetRequests).toEqual([]);
  });
});
