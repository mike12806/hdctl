import { Hono } from "hono";
import type { AppEnv, Env, Identity, Runtime } from "./env";
import { AuthError, accessKeyFetcher, allowedEmails, tokenFrom, verifyAccessJwt } from "./auth";
import { BadRequest, NotConfigured, UpstreamError } from "./errors";
import { MissingBindingError } from "./targets";
import { pruneChecks, recordChecks, statusSummary } from "./health";
import { audited, recentAudit } from "./audit";
import * as argo from "./integrations/argo";
import * as pve from "./integrations/proxmox";
import * as github from "./integrations/github";
import * as gitea from "./integrations/gitea";
import * as prometheus from "./integrations/prometheus";
import * as unifi from "./integrations/unifi";
import * as pihole from "./integrations/pihole";
import * as kuma from "./integrations/kuma";

const app = new Hono<AppEnv>();

// --- Every response: security and caching headers ---------------------------
// Browser caching, so nothing shown is ever an old copy:
//   /api/*     no-store: never kept anywhere; the client also fetches with
//              cache: "no-store".
//   /assets/*  Vite's content-hashed files: a changed file gets a new name,
//              so a year-long immutable cache can't serve a stale one.
//   the rest   index.html (the SPA shell) and the favicon: no-cache, i.e.
//              revalidated on every load, so a deploy is picked up at once.
// X-Hdctl-Build lets an already-open tab notice a deploy and reload itself.
app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  h.set("X-Hdctl-Build", c.env.BUILD_ID ?? "dev");
  const path = c.req.path;
  if (path.startsWith("/api/")) h.set("Cache-Control", "no-store");
  else if (path.startsWith("/assets/") && c.res.ok) h.set("Cache-Control", "private, max-age=31536000, immutable");
  else h.set("Cache-Control", "no-cache");
});

// --- Every request, assets included: a valid Access JWT ------------------
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (c.env.DEV_MODE === "true" && local) {
    c.set("identity", { email: "dev@localhost" });
    return next();
  }
  const token = tokenFrom(c.req.raw);
  if (!token) throw new AuthError("no Access token");
  if (!c.env.CF_ACCESS_AUD || c.env.CF_ACCESS_AUD.startsWith("REPLACE_")) throw new AuthError("CF_ACCESS_AUD is not configured");
  const claims = await verifyAccessJwt(token, {
    audience: c.env.CF_ACCESS_AUD,
    teamDomain: c.env.CF_ACCESS_TEAM_DOMAIN,
    allowedEmails: allowedEmails(c.env.ALLOWED_EMAILS),
    keyFor: accessKeyFetcher(c.env.CF_ACCESS_TEAM_DOMAIN),
  });
  c.set("identity", { email: claims.email!.toLowerCase() });
  return next();
});

// --- State-changing calls: same-origin only --------------------------------
// The Access cookie rides along on cross-site requests too. Requiring a custom
// header means a cross-site form or fetch can't make one of these calls: a
// custom header forces a CORS preflight, which this Worker never approves.
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (c.req.header("X-Hdctl") !== "1" || (origin && origin !== new URL(c.req.url).origin)) {
      return c.json({ error: "cross-site request refused" }, 403);
    }
  }
  return next();
});

const who = (c: { get: (k: "identity") => Identity }) => c.get("identity");
const runtime = (c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }): Runtime => ({
  env: c.env,
  waitUntil: (p) => c.executionCtx.waitUntil(p),
});

app.get("/api/me", (c) => c.json({ email: who(c).email }));

// Status board: probed live on every request; D1 adds only recorded history.
app.get("/api/status", async (c) => c.json(await statusSummary(c.env)));

// Metrics: Prometheus and Alertmanager, queried live; each section succeeds or fails on its own.
app.get("/api/metrics", async (c) => c.json(await prometheus.overview(c.env)));

// DNS: each Pi-hole's own API, live, one short session per read. Read-only.
app.get("/api/dns", async (c) => c.json(await pihole.overview(c.env)));

// Argo CD
app.get("/api/argo/apps", async (c) => c.json(await argo.listApps(c.env)));
app.post("/api/argo/apps/:name/refresh", async (c) => {
  const name = c.req.param("name");
  const hard = c.req.query("hard") === "true";
  return c.json(await audited(c.env, who(c), hard ? "argo.hard-refresh" : "argo.refresh", `argo/${name}`, undefined, () => argo.refreshApp(c.env, name, hard)));
});
app.post("/api/argo/apps/:name/sync", async (c) => {
  const name = c.req.param("name");
  return c.json(await audited(c.env, who(c), "argo.sync", `argo/${name}`, { prune: false }, () => argo.syncApp(c.env, name)));
});

// Proxmox
app.get("/api/proxmox", async (c) => c.json(await pve.overview(c.env)));
app.post("/api/proxmox/:host/:node/:type/:vmid/:action", async (c) => {
  const g = pve.parseGuestRef(c.req.param() as unknown as pve.GuestRef);
  const upid = await audited(c.env, who(c), `proxmox.${g.action}`, `${g.host.id}/${g.node}/${g.type}/${g.vmid}`, undefined, () => pve.guestAction(c.env, g));
  return c.json({ upid });
});

// UniFi: the UDM's own Network API, live. Actions are checked against what the UDM reports first.
app.get("/api/unifi", async (c) => c.json(await unifi.overview(c.env)));
app.post("/api/unifi/devices/:mac/ports/:idx/power-cycle", async (c) => {
  const mac = unifi.parseMac(c.req.param("mac"));
  const idx = c.req.param("idx");
  return c.json(await audited(c.env, who(c), "unifi.power-cycle", `unifi/${mac}/port/${idx}`, undefined, () => unifi.powerCycle(c.env, mac, idx)));
});
app.post("/api/unifi/devices/:mac/:action", async (c) => {
  const mac = unifi.parseMac(c.req.param("mac"));
  const action = unifi.parseDeviceAction(c.req.param("action"));
  return c.json(await audited(c.env, who(c), `unifi.${action}`, `unifi/${mac}`, undefined, () => unifi.deviceAction(c.env, mac, action)));
});
app.post("/api/unifi/clients/:mac/reconnect", async (c) => {
  const mac = unifi.parseMac(c.req.param("mac"));
  return c.json(await audited(c.env, who(c), "unifi.reconnect", `unifi/client/${mac}`, undefined, () => unifi.reconnectClient(c.env, mac)));
});
app.post("/api/unifi/speedtest", async (c) => c.json(await audited(c.env, who(c), "unifi.speedtest", "unifi/gateway", undefined, () => unifi.speedTest(c.env))));

// Uptime Kuma, pushed live: a WebSocket to the one Durable Object that holds
// Kuma's Socket.IO connection while anyone is watching. Read-only.
app.get("/api/kuma/live", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected a WebSocket upgrade" }, 426);
  // The Access cookie can ride along on a WebSocket opened from another site.
  if (c.req.header("Origin") !== new URL(c.req.url).origin) return c.json({ error: "cross-site request refused" }, 403);
  const res = await c.env.KUMA_LIVE.getByName("kuma").fetch(c.req.raw);
  // Re-wrapped so the header middleware can set its headers.
  return res.webSocket ? new Response(null, { status: 101, webSocket: res.webSocket }) : new Response(res.body, res);
});

// GitHub Actions
app.get("/api/github/runs", async (c) => c.json(await github.recentRuns(runtime(c))));
app.get("/api/github/workflows", async (c) => c.json(await github.listWorkflows(runtime(c))));
app.get("/api/github/workflows/:owner/:repo/:file", async (c) => {
  const { owner, repo, file } = c.req.param();
  return c.json(await github.workflowInputs(runtime(c), `${owner}/${repo}`, file));
});
app.post("/api/github/workflows/:owner/:repo/:file/dispatch", async (c) => {
  const { owner, repo, file } = c.req.param();
  const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
  const full = await github.assertRepo(runtime(c), `${owner}/${repo}`);
  return c.json(await audited(c.env, who(c), "github.dispatch", `${full}/${file}`, body.inputs ?? {}, () => github.dispatch(runtime(c), full, file, body.inputs ?? {})));
});

// Gitea Actions: every repository on the Gitea instance, from Gitea's own API.
app.get("/api/gitea/runs", async (c) => c.json(await gitea.recentRuns(c.env)));
app.get("/api/gitea/workflows", async (c) => c.json(await gitea.listWorkflows(c.env)));
app.get("/api/gitea/workflows/:owner/:repo/:file", async (c) => {
  const { owner, repo, file } = c.req.param();
  return c.json(await gitea.workflowInputs(c.env, `${owner}/${repo}`, file));
});
app.post("/api/gitea/workflows/:owner/:repo/:file/dispatch", async (c) => {
  const { owner, repo, file } = c.req.param();
  const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
  const full = `${owner}/${repo}`;
  return c.json(await audited(c.env, who(c), "gitea.dispatch", `gitea/${full}/${file}`, body.inputs ?? {}, () => gitea.dispatch(c.env, full, file, body.inputs ?? {})));
});

// Pull requests: open ones on GitHub (GITHUB_OWNER's repositories) and Gitea, each forge on its own.
// Merge and close are audited; a merge is pinned to the head commit the page showed.
app.get("/api/pulls/github", async (c) => c.json(await github.openPulls(runtime(c))));
app.get("/api/pulls/gitea", async (c) => c.json(await gitea.openPulls(c.env)));
app.post("/api/pulls/:forge/:owner/:repo/:number/:action", async (c) => {
  const { forge, owner, repo, action } = c.req.param();
  if (forge !== "github" && forge !== "gitea") throw new BadRequest("unknown forge");
  if (action !== "merge" && action !== "close") throw new BadRequest("unknown action");
  const number = github.parsePullNumber(c.req.param("number"));
  const full = `${owner}/${repo}`;
  const target = `${forge}/${full}#${number}`;
  if (action === "close") {
    return c.json(await audited(c.env, who(c), `${forge}.pr.close`, target, undefined, () => (forge === "github" ? github.closePull(runtime(c), full, number) : gitea.closePull(c.env, full, number))));
  }
  const body = (await c.req.json().catch(() => ({}))) as { sha?: unknown };
  const sha = github.parseSha(body.sha);
  return c.json(await audited(c.env, who(c), `${forge}.pr.merge`, target, { sha }, () => (forge === "github" ? github.mergePull(runtime(c), full, number, sha) : gitea.mergePull(c.env, full, number, sha))));
});

// Audit log
app.get("/api/audit", async (c) => c.json(await recentAudit(c.env)));

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// Everything else is the React app (SPA fallback is handled by the assets config).
// Re-wrapped because the asset response's headers are immutable, and the
// security-header middleware above needs to set them.
app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(res.body, res);
});

app.onError((err, c) => {
  if (err instanceof AuthError) {
    console.warn(JSON.stringify({ msg: "auth refused", reason: err.message, path: c.req.path }));
    return c.req.path.startsWith("/api/")
      ? c.json({ error: "unauthorised" }, 401)
      : c.text("hdctl: sign in through Cloudflare Access at https://hdctl.mfaherty.net", 401);
  }
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  if (err instanceof NotConfigured || err instanceof MissingBindingError) return c.json({ error: err.message, setup: true }, 503);
  if (err instanceof UpstreamError) return c.json({ error: err.message }, 502);
  // VPC fetch failures (tunnel down, connection refused, timeout) land here too.
  console.error(JSON.stringify({ msg: "unhandled", path: c.req.path, error: err instanceof Error ? err.stack ?? err.message : String(err) }));
  return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
});

export { KumaLive } from "./integrations/kuma";

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const results = await recordChecks(env);
    const down = results.filter((r) => r.state !== "up").map((r) => `${r.targetId}=${r.state}`);
    console.log(JSON.stringify({ msg: "health checks", total: results.length, notUp: down }));
    // Pruning is cheap but needn't hold up the run.
    ctx.waitUntil(pruneChecks(env));
  },
} satisfies ExportedHandler<Env>;
