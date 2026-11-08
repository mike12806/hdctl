import { describe, expect, it } from "vitest";
import { OWNER, action, call, testEnv, type Upstream } from "./helpers/worker";
import { TARGETS } from "../src/targets";

/** What each action actually sends to the system it acts on, and what it records. */

describe("Argo CD", () => {
  const argo = (upstream?: Upstream) => testEnv({ vars: { ARGOCD_TOKEN: "argo-token" }, upstream });
  const running = () => Response.json({ status: { operationState: { phase: "Running" }, sync: { status: "OutOfSync" }, health: { status: "Healthy" } } });

  it("syncs without pruning, as the hdctl account, and records who did it", async () => {
    const t = argo(running);
    const res = await action(t.env, "/api/argo/apps/cert-manager/sync");
    expect(await res.json()).toEqual({ name: "cert-manager", operation: "Running" });
    expect(t.calls).toHaveLength(1);
    const [sent] = t.calls;
    expect(sent).toMatchObject({ target: "argo", method: "POST", path: "/api/v1/applications/cert-manager/sync" });
    expect(JSON.parse(sent!.body)).toEqual({ prune: false, dryRun: false });
    expect(sent!.headers.get("Authorization")).toBe("Bearer argo-token");
    expect(t.audit()).toMatchObject([{ actor: OWNER, action: "argo.sync", target: "argo/cert-manager", params: '{"prune":false}', status: "ok" }]);
  });

  it("records a refused sync as an error and reports it as Argo's (502)", async () => {
    const t = argo(() => new Response("permission denied", { status: 403 }));
    const res = await action(t.env, "/api/argo/apps/cert-manager/sync");
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("HTTP 403") });
    expect(t.audit()).toMatchObject([{ action: "argo.sync", status: "error", result: expect.stringContaining("HTTP 403") }]);
  });

  it("refreshes with a GET, never a write", async () => {
    const t = argo(running);
    await action(t.env, "/api/argo/apps/cert-manager/refresh?hard=true");
    expect(t.calls).toMatchObject([{ method: "GET", path: "/api/v1/applications/cert-manager?refresh=hard" }]);
    expect(t.audit()).toMatchObject([{ action: "argo.hard-refresh", status: "ok" }]);
  });

  it("refuses a malformed application name without calling Argo", async () => {
    const t = argo(running);
    expect((await action(t.env, "/api/argo/apps/Not_An_App/sync")).status).toBe(400);
    expect(t.calls).toEqual([]);
  });

  it("asks Argo again on every request, nothing cached", async () => {
    const t = argo(() => Response.json({ items: [{ metadata: { name: "a" }, spec: {}, status: { sync: { status: "Synced" } } }] }));
    await call(t.env, "/api/argo/apps");
    const res = await call(t.env, "/api/argo/apps");
    expect((await res.json()) as unknown[]).toMatchObject([{ name: "a", sync: "Synced", health: "Unknown" }]);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.path).toMatch(/^\/api\/v1\/applications\?fields=/);
  });
});

describe("Proxmox", () => {
  const hosts = TARGETS.filter((t) => t.group === "proxmox").map((t) => t.id);
  const PVE_TOKENS = JSON.stringify(Object.fromEntries(hosts.map((id) => [id, `hdctl@pve!test=${id}-secret`])));
  const pve = (upstream: Upstream) => testEnv({ vars: { PVE_TOKENS }, upstream });

  it("sends a guest action to that host only, with that host's token, and records it", async () => {
    const t = pve(() => Response.json({ data: "UPID:pve:0001" }));
    const res = await action(t.env, "/api/proxmox/pve4/pve/qemu/101/reboot");
    expect(await res.json()).toEqual({ upid: "UPID:pve:0001" });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ target: "pve4", method: "POST", path: "/api2/json/nodes/pve/qemu/101/status/reboot" });
    expect(t.calls[0]!.headers.get("Authorization")).toBe("PVEAPIToken=hdctl@pve!test=pve4-secret");
    expect(t.audit()).toMatchObject([{ actor: OWNER, action: "proxmox.reboot", target: "pve4/pve/qemu/101", status: "ok" }]);
  });

  it.each([
    ["an action hdctl doesn't offer", "/api/proxmox/pve4/pve/qemu/101/stop"],
    ["a destructive action", "/api/proxmox/pve4/pve/qemu/101/destroy"],
    ["a host that isn't a Proxmox host", "/api/proxmox/harbor/pve/qemu/101/reboot"],
    ["a guest type that isn't one", "/api/proxmox/pve4/pve/storage/101/reboot"],
  ])("refuses %s before sending or recording anything", async (_, path) => {
    const t = pve(() => Response.json({ data: "UPID" }));
    expect((await action(t.env, path)).status).toBe(400);
    expect(t.calls).toEqual([]);
    expect(t.audit()).toEqual([]);
  });

  it("shows a host that doesn't answer as failed, beside the hosts that do", async () => {
    const t = pve((target) => {
      if (target.id === "pve3") throw new TypeError("connection refused");
      return Response.json({
        data: [
          { type: "node", node: "pve", status: "online", cpu: 0.1, maxcpu: 8 },
          { type: "qemu", node: "pve", vmid: 101, name: "web", status: "running", tags: "k8s;prod" },
          { type: "qemu", node: "pve", vmid: 9000, name: "template", template: 1 },
          { type: "storage", node: "pve" },
        ],
      });
    });
    const body = (await (await call(t.env, "/api/proxmox")).json()) as { id: string; error: string | null; guests: { vmid: number; tags: string[] }[] }[];
    expect(body.map((h) => h.id)).toEqual(hosts);
    expect(body.find((h) => h.id === "pve3")).toMatchObject({ error: "connection refused", guests: [] });
    expect(body.find((h) => h.id === "pve")).toMatchObject({ error: null, guests: [{ vmid: 101, tags: ["k8s", "prod"] }] });
  });
});

describe("GitHub Actions", () => {
  const WORKFLOW = `
on:
  workflow_dispatch:
    inputs:
      action:
        type: choice
        options: [plan, apply]
        default: plan
      note:
        required: true
jobs: {}
`;
  const dispatchPath = "/api/github/workflows/mike12806/gh_hdc/terraform.yml/dispatch";

  /** A fake api.github.com with one dispatchable workflow. */
  const github = (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === "/repos/mike12806/gh_hdc") return Response.json({ default_branch: "main" });
    if (path === "/repos/mike12806/gh_hdc/contents/.github/workflows/terraform.yml") return new Response(WORKFLOW);
    if (req.method === "POST" && path === "/repos/mike12806/gh_hdc/actions/workflows/terraform.yml/dispatches") return new Response(null, { status: 204 });
    return new Response("{}", { status: 404 });
  };
  const dispatches = (t: ReturnType<typeof testEnv>) => t.internetCalls.filter((r) => r.method === "POST");

  it("dispatches on the default branch with the inputs as strings, and records it", async () => {
    const t = testEnv({ vars: { GITHUB_TOKEN: "gh-token" }, internet: github });
    const res = await action(t.env, dispatchPath, { inputs: { action: "apply", note: 42 } });
    expect(res.status).toBe(200);
    const [post] = dispatches(t);
    expect(await post!.json()).toEqual({ ref: "main", inputs: { action: "apply", note: "42" } });
    expect(post!.headers.get("Authorization")).toBe("Bearer gh-token");
    expect(t.audit()).toMatchObject([{ action: "github.dispatch", target: "mike12806/gh_hdc/terraform.yml", status: "ok" }]);
  });

  it.each([
    ["a repository outside GITHUB_REPOS", "/api/github/workflows/someone/else/deploy.yml/dispatch", {}],
    ["an input the workflow doesn't have", dispatchPath, { inputs: { action: "plan", note: "x", extra: "1" } }],
    ["a value that isn't one of the choices", dispatchPath, { inputs: { action: "destroy", note: "x" } }],
    ["a missing required input", dispatchPath, { inputs: { action: "plan" } }],
  ])("refuses %s without dispatching", async (_, path, body) => {
    const t = testEnv({ vars: { GITHUB_TOKEN: "gh-token" }, internet: github });
    expect((await action(t.env, path, body)).status).toBe(400);
    expect(dispatches(t)).toEqual([]);
  });

  it("uses KV only when GitHub confirms the copy, and shows an outage as an outage", async () => {
    const run = (repo: string) => ({
      id: 1, name: "Deploy", display_title: `cached run in ${repo}`, path: ".github/workflows/deploy.yml", event: "push",
      status: "completed", conclusion: "success", head_branch: "main", run_number: 7, run_attempt: 1,
      created_at: "2026-11-07T12:00:00Z", updated_at: "2026-11-07T12:05:00Z", html_url: "https://github.com/x", workflow_id: 3,
    });
    let githubUp = true;
    const t = testEnv({
      vars: { GITHUB_TOKEN: "gh-token" },
      internet: (req) => {
        if (!githubUp) throw new TypeError("fetch failed");
        if (req.headers.get("If-None-Match") === '"v1"') return new Response(null, { status: 304 });
        const repo = new URL(req.url).pathname.split("/").slice(2, 4).join("/");
        return Response.json({ workflow_runs: [run(repo)] }, { headers: { ETag: '"v1"' } });
      },
    });

    const first = await call(t.env, "/api/github/runs");
    expect((await first.json()) as unknown[]).toHaveLength(2);
    expect(t.cache.size).toBe(2);

    const second = await call(t.env, "/api/github/runs");
    expect((await second.json()) as unknown[]).toMatchObject([{ title: expect.stringContaining("cached run") }, {}]);
    expect(t.internetCalls.slice(2).map((r) => r.headers.get("If-None-Match"))).toEqual(['"v1"', '"v1"']);

    githubUp = false;
    const third = await call(t.env, "/api/github/runs");
    expect(third.status).toBeGreaterThanOrEqual(500);
    expect(await third.text()).not.toContain("cached run");
  });
});

describe("audit log", () => {
  it("lists actions newest first", async () => {
    const t = testEnv({ vars: { ARGOCD_TOKEN: "argo-token" }, upstream: () => Response.json({ status: {} }) });
    await action(t.env, "/api/argo/apps/one/sync");
    await action(t.env, "/api/argo/apps/two/refresh");
    const rows = (await (await call(t.env, "/api/audit")).json()) as { target: string }[];
    expect(rows.map((r) => r.target)).toEqual(["argo/two", "argo/one"]);
  });
});
