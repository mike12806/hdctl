import { describe, expect, it } from "vitest";
import { action, call, testEnv, type Upstream } from "./helpers/worker";
import { healthy } from "./helpers/worker";
import { targetById } from "../src/targets";

/** Gitea Actions: every repository on the instance, from Gitea's own API through the GITEA VPC Service. */

const TOKEN = "gitea-token";

const WORKFLOW = `
on:
  workflow_dispatch:
    inputs:
      target:
        type: choice
        options: [staging, prod]
        default: staging
jobs: {}
`;

const REPOS = [
  { full_name: "mike12806/hdc", archived: false, has_actions: true, default_branch: "main" },
  { full_name: "mike12806/notes", archived: false, has_actions: false, default_branch: "main" },
  { full_name: "mike12806/old", archived: true, has_actions: true, default_branch: "main" },
];

const run = (id: number, file: string, created: string) => ({
  id, path: `${file}@refs/heads/main`, display_title: `run ${id}`, event: "schedule", status: "completed", conclusion: "success",
  head_branch: "main", run_number: id, run_attempt: 1, created_at: created, updated_at: created,
  html_url: `http://192.168.9.3:3000/mike12806/hdc/actions/runs/${id}`, actor: { login: "gitea-actions" },
});

/** A fake Gitea 28.3.0: the right token only, and the Actions API for mike12806/hdc. */
const giteaUp: Upstream = (t, req) => {
  if (t.id !== "gitea") return healthy(t, req);
  const url = new URL(req.url);
  if (req.headers.get("Authorization") !== `token ${TOKEN}`) return Response.json({ message: "token is required" }, { status: 401 });
  const p = url.pathname;
  if (p === "/api/v1/repos/search") return Response.json({ ok: true, data: REPOS });
  if (p === "/api/v1/repos/mike12806/hdc/actions/workflows") {
    return Response.json({
      total_count: 2,
      workflows: [
        { id: "deploy.yml", name: "Deploy", path: ".gitea/workflows/deploy.yml", state: "active", html_url: "http://192.168.9.3:3000/mike12806/hdc/src/branch/main/.gitea/workflows/deploy.yml" },
        { id: "old.yml", name: "Old", path: ".gitea/workflows/old.yml", state: "disabled_manually", html_url: "http://192.168.9.3:3000/x" },
      ],
    });
  }
  if (p === "/api/v1/repos/mike12806/hdc/actions/runs") return Response.json({ total_count: 2, workflow_runs: [run(2, "deploy.yml", "2026-11-09T17:20:01-05:00"), run(1, "renovate.yml", "2026-11-09T17:00:01-05:00")] });
  if (p === "/api/v1/repos/mike12806/hdc/raw/.gitea/workflows/deploy.yml") return new Response(WORKFLOW);
  if (req.method === "POST" && p === "/api/v1/repos/mike12806/hdc/actions/workflows/deploy.yml/dispatches") return new Response(null, { status: 204 });
  return Response.json({ message: "not found" }, { status: 404 });
};

const gitea = (upstream: Upstream = giteaUp) => testEnv({ vars: { GITEA_TOKEN: TOKEN }, upstream });
const giteaCalls = (t: ReturnType<typeof testEnv>) => t.calls.filter((c) => c.target === "gitea");

describe("Gitea Actions", () => {
  it("reaches Gitea through its pinned VPC Service", () => {
    expect(targetById("gitea")).toMatchObject({ binding: "GITEA", address: { ipv4: "192.168.9.3" }, port: 3000, link: "https://git.mfaherty.net" });
  });

  it("lists recent runs from every active repository, named after their workflows, in UTC, linked to git.mfaherty.net", async () => {
    const t = gitea();
    const res = await call(t.env, "/api/gitea/runs");
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Record<string, unknown>[];
    expect(runs.map((r) => [r.forge, r.repo, r.workflow, r.createdAt])).toEqual([
      ["gitea", "mike12806/hdc", "Deploy", "2026-11-09T22:20:01.000Z"],
      ["gitea", "mike12806/hdc", "renovate.yml", "2026-11-09T22:00:01.000Z"],
    ]);
    expect(runs[0]!.url).toBe("https://git.mfaherty.net/mike12806/hdc/actions/runs/2");
    // Archived repositories and ones with Actions turned off aren't asked for runs.
    const paths = giteaCalls(t).map((c) => c.path.split("?")[0]);
    expect(paths.some((p) => p!.includes("/notes/") || p!.includes("/old/"))).toBe(false);
    expect(giteaCalls(t)[0]!.headers.get("Authorization")).toBe(`token ${TOKEN}`);
  });

  it("lists active workflows only, with where each file lives", async () => {
    const t = gitea();
    expect(await (await call(t.env, "/api/gitea/workflows")).json()).toEqual([
      { forge: "gitea", repo: "mike12806/hdc", id: "deploy.yml", name: "Deploy", file: "deploy.yml", path: ".gitea/workflows/deploy.yml", url: "https://git.mfaherty.net/mike12806/hdc/src/branch/main/.gitea/workflows/deploy.yml" },
    ]);
  });

  it("dispatches on the default branch with the workflow's own inputs, and records it", async () => {
    const t = gitea();
    const res = await action(t.env, "/api/gitea/workflows/mike12806/hdc/deploy.yml/dispatch", { inputs: { target: "prod" } });
    expect(res.status).toBe(200);
    const post = giteaCalls(t).find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/v1/repos/mike12806/hdc/actions/workflows/deploy.yml/dispatches");
    expect(JSON.parse(post.body)).toEqual({ ref: "main", inputs: { target: "prod" } });
    expect(t.audit()).toMatchObject([{ action: "gitea.dispatch", target: "gitea/mike12806/hdc/deploy.yml", status: "ok" }]);
  });

  it.each([
    ["a repository that isn't on Gitea", "/api/gitea/workflows/someone/else/deploy.yml/dispatch", {}],
    ["an archived repository", "/api/gitea/workflows/mike12806/old/deploy.yml/dispatch", {}],
    ["a workflow the repository doesn't have", "/api/gitea/workflows/mike12806/hdc/nope.yml/dispatch", {}],
    ["a value that isn't one of the choices", "/api/gitea/workflows/mike12806/hdc/deploy.yml/dispatch", { inputs: { target: "everywhere" } }],
  ])("refuses %s without dispatching", async (_, path, body) => {
    const t = gitea();
    expect((await action(t.env, path, body)).status).toBe(400);
    expect(giteaCalls(t).filter((c) => c.method === "POST")).toEqual([]);
  });

  it("says how to set it up while GITEA_TOKEN is missing, without calling Gitea", async () => {
    const t = testEnv({ upstream: giteaUp });
    const res = await call(t.env, "/api/gitea/runs");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ setup: true, error: expect.stringContaining("GITEA_TOKEN") });
    expect(giteaCalls(t)).toEqual([]);
  });

  it("shows Gitea refusing the token as Gitea's error, with no data", async () => {
    const t = testEnv({ vars: { GITEA_TOKEN: "wrong" }, upstream: giteaUp });
    const res = await call(t.env, "/api/gitea/runs");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("HTTP 401");
  });
});
