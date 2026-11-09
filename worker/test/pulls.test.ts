import { describe, expect, it } from "vitest";
import { action, call, healthy, testEnv, type Upstream } from "./helpers/worker";

/** Pull requests on GitHub and Gitea: listed live, merged pinned to the commit shown, closed, all audited. */

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

// --- GitHub ------------------------------------------------------------------------------

const REPOS = [
  { full_name: "mike12806/hdctl", owner: { login: "mike12806" }, archived: false },
  { full_name: "mike12806/old", owner: { login: "mike12806" }, archived: true },
];

const gqlPull = (repo: string, number: number, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, isDraft: false,
  createdAt: "2026-11-09T20:00:00Z", updatedAt: `2026-11-09T2${number % 10}:00:00Z`, mergeable: "MERGEABLE", reviewDecision: null,
  headRefName: "feat/x", headRefOid: SHA, baseRefName: "main", author: { login: "mike12806" },
  labels: { nodes: [{ name: "dependencies" }] }, repository: { nameWithOwner: repo },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...extra,
});

function githubFake(opts: { allowMergeCommit?: boolean } = {}) {
  const sent: { method: string; path: string; body: string }[] = [];
  const internet = async (req: Request) => {
    const url = new URL(req.url);
    const body = req.method === "GET" ? "" : await req.text();
    sent.push({ method: req.method, path: url.pathname, body });
    if (url.pathname === "/user/repos") return Response.json(REPOS);
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          search: {
            nodes: [
              gqlPull("mike12806/hdctl", 3, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] }, mergeable: "CONFLICTING" }),
              gqlPull("mike12806/hdctl", 4, { reviewDecision: "APPROVED", isDraft: true }),
              gqlPull("someone/else", 9),
              {},
            ],
          },
        },
      });
    }
    if (url.pathname === "/repos/mike12806/hdctl") return Response.json({ allow_merge_commit: opts.allowMergeCommit ?? true, allow_squash_merge: true, allow_rebase_merge: false });
    if (req.method === "PUT" && url.pathname === "/repos/mike12806/hdctl/pulls/4/merge") {
      return JSON.parse(body).sha === SHA ? Response.json({ merged: true, sha: "c".repeat(40), message: "merged" }) : Response.json({ message: "Head branch was modified" }, { status: 409 });
    }
    if (req.method === "PATCH" && url.pathname === "/repos/mike12806/hdctl/pulls/4") return Response.json({ state: "closed" });
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return { sent, internet };
}

describe("GitHub pull requests", () => {
  it("lists every open pull request in the owner's repositories, with checks, conflicts, drafts and reviews", async () => {
    const f = githubFake();
    const t = testEnv({ vars: { GITHUB_TOKEN: "gh" }, internet: f.internet });
    const res = await call(t.env, "/api/pulls/github");
    expect(res.status).toBe(200);
    const pulls = (await res.json()) as Record<string, unknown>[];
    expect(pulls.map((p) => [p.repo, p.number, p.checks, p.mergeable, p.draft, p.review])).toEqual([
      ["mike12806/hdctl", 4, "success", "yes", true, "approved"],
      ["mike12806/hdctl", 3, "failure", "conflict", false, null],
    ]);
    expect(pulls[0]).toMatchObject({ forge: "github", headSha: SHA, head: "feat/x", base: "main", labels: ["dependencies"] });
    const q = JSON.parse(f.sent.find((s) => s.path === "/graphql")!.body) as { variables: { q: string } };
    expect(q.variables.q).toBe("is:pr is:open archived:false user:mike12806");
  });

  it("merges with the repository's merge method, pinned to the head commit shown, and records it", async () => {
    const f = githubFake();
    const t = testEnv({ vars: { GITHUB_TOKEN: "gh" }, internet: f.internet });
    const res = await action(t.env, "/api/pulls/github/mike12806/hdctl/4/merge", { sha: SHA });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ method: "merge", merged: true });
    const put = f.sent.find((s) => s.method === "PUT")!;
    expect(JSON.parse(put.body)).toEqual({ sha: SHA, merge_method: "merge" });
    expect(t.audit()).toMatchObject([{ action: "github.pr.merge", target: "github/mike12806/hdctl#4", params: JSON.stringify({ sha: SHA }), status: "ok" }]);
  });

  it("squashes where merge commits are turned off", async () => {
    const f = githubFake({ allowMergeCommit: false });
    const t = testEnv({ vars: { GITHUB_TOKEN: "gh" }, internet: f.internet });
    await action(t.env, "/api/pulls/github/mike12806/hdctl/4/merge", { sha: SHA });
    expect(JSON.parse(f.sent.find((s) => s.method === "PUT")!.body).merge_method).toBe("squash");
  });

  it("shows GitHub refusing a branch that moved since the page loaded, and records the failure", async () => {
    const f = githubFake();
    const t = testEnv({ vars: { GITHUB_TOKEN: "gh" }, internet: f.internet });
    const res = await action(t.env, "/api/pulls/github/mike12806/hdctl/4/merge", { sha: OTHER_SHA });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("HTTP 409");
    expect(t.audit()).toMatchObject([{ action: "github.pr.merge", status: "error" }]);
  });

  it("closes, and records it", async () => {
    const f = githubFake();
    const t = testEnv({ vars: { GITHUB_TOKEN: "gh" }, internet: f.internet });
    const res = await action(t.env, "/api/pulls/github/mike12806/hdctl/4/close");
    expect(await res.json()).toEqual({ repo: "mike12806/hdctl", number: 4, state: "closed" });
    expect(JSON.parse(f.sent.find((s) => s.method === "PATCH")!.body)).toEqual({ state: "closed" });
    expect(t.audit()).toMatchObject([{ action: "github.pr.close", target: "github/mike12806/hdctl#4", status: "ok" }]);
  });

  it.each([
    ["a merge without the head commit", "/api/pulls/github/mike12806/hdctl/4/merge", {}],
    ["another account's repository", "/api/pulls/github/someone/else/9/merge", { sha: SHA }],
    ["an archived repository", "/api/pulls/github/mike12806/old/1/close", undefined],
    ["a bad number", "/api/pulls/github/mike12806/hdctl/0x4/close", undefined],
    ["an action hdctl doesn't offer", "/api/pulls/github/mike12806/hdctl/4/approve", undefined],
    ["an unknown forge", "/api/pulls/gitlab/mike12806/hdctl/4/close", undefined],
  ])("refuses %s without changing anything", async (_, path, body) => {
    const f = githubFake();
    const t = testEnv({ vars: { GITHUB_TOKEN: "gh" }, internet: f.internet });
    expect((await action(t.env, path, body)).status).toBe(400);
    expect(f.sent.filter((s) => s.method === "PUT" || s.method === "PATCH")).toEqual([]);
  });
});

// --- Gitea -------------------------------------------------------------------------------

const GITEA_REPOS = [{ full_name: "mike12806/hdc", archived: false, has_actions: true, default_branch: "main", default_merge_style: "squash" }];

function giteaFake(): Upstream {
  return async (t, req) => {
    if (t.id !== "gitea") return healthy(t, req);
    const p = new URL(req.url).pathname;
    if (p === "/api/v1/repos/search") return Response.json({ ok: true, data: GITEA_REPOS });
    if (p === "/api/v1/repos/mike12806/hdc/pulls" && req.method === "GET") {
      return Response.json([
        {
          number: 7517, title: "chore(deps): update x", html_url: "http://192.168.9.3:3000/mike12806/hdc/pulls/7517", user: { login: "Renovate-Bot" },
          draft: false, created_at: "2026-11-09T17:00:00-05:00", updated_at: "2026-11-09T17:10:00-05:00", mergeable: true,
          head: { ref: "renovate/x", sha: SHA }, base: { ref: "main" }, labels: [{ name: "renovate" }],
        },
      ]);
    }
    if (p === `/api/v1/repos/mike12806/hdc/commits/${SHA}/status`) return Response.json({ state: "pending" });
    if (req.method === "POST" && p === "/api/v1/repos/mike12806/hdc/pulls/7517/merge") return new Response(null, { status: 200 });
    if (req.method === "PATCH" && p === "/api/v1/repos/mike12806/hdc/pulls/7517") return Response.json({ state: "closed" });
    return Response.json({ message: "not found" }, { status: 404 });
  };
}

describe("Gitea pull requests", () => {
  it("lists open pull requests with their commit status, in UTC, linked to git.mfaherty.net", async () => {
    const t = testEnv({ vars: { GITEA_TOKEN: "g" }, upstream: giteaFake() });
    expect(await (await call(t.env, "/api/pulls/gitea")).json()).toEqual([
      {
        forge: "gitea", repo: "mike12806/hdc", number: 7517, title: "chore(deps): update x", url: "https://git.mfaherty.net/mike12806/hdc/pulls/7517",
        author: "Renovate-Bot", draft: false, createdAt: "2026-11-09T22:00:00.000Z", updatedAt: "2026-11-09T22:10:00.000Z",
        head: "renovate/x", headSha: SHA, base: "main", labels: ["renovate"], checks: "pending", mergeable: "yes", review: null,
      },
    ]);
  });

  it("merges with the repository's default style, pinned to the head commit, and records it", async () => {
    const t = testEnv({ vars: { GITEA_TOKEN: "g" }, upstream: giteaFake() });
    const res = await action(t.env, "/api/pulls/gitea/mike12806/hdc/7517/merge", { sha: SHA });
    expect(res.status).toBe(200);
    const post = t.calls.find((c) => c.target === "gitea" && c.method === "POST")!;
    expect(JSON.parse(post.body)).toEqual({ Do: "squash", head_commit_id: SHA });
    expect(t.audit()).toMatchObject([{ action: "gitea.pr.merge", target: "gitea/mike12806/hdc#7517", status: "ok" }]);
  });

  it("closes, and records it", async () => {
    const t = testEnv({ vars: { GITEA_TOKEN: "g" }, upstream: giteaFake() });
    expect(await (await action(t.env, "/api/pulls/gitea/mike12806/hdc/7517/close")).json()).toEqual({ repo: "mike12806/hdc", number: 7517, state: "closed" });
    expect(t.audit()).toMatchObject([{ action: "gitea.pr.close", status: "ok" }]);
  });

  it("refuses a repository that isn't on Gitea without changing anything", async () => {
    const t = testEnv({ vars: { GITEA_TOKEN: "g" }, upstream: giteaFake() });
    expect((await action(t.env, "/api/pulls/gitea/someone/else/1/merge", { sha: SHA })).status).toBe(400);
    expect(t.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});
