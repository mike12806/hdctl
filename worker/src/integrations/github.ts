import { parse as parseYaml } from "yaml";
import type { Runtime } from "../env";
import { BadRequest, NotConfigured, UpstreamError } from "../errors";
import { revalidatingFetch } from "../cache";

/**
 * GitHub Actions for every repository GITHUB_OWNER owns: recent runs, the
 * workflow list, and workflow_dispatch with the workflow's own inputs. The
 * repository list itself comes from GitHub on every request, so a new repo
 * shows up without a deploy and an archived one drops off. This is
 * the one integration that goes over the public internet (api.github.com),
 * not through the tunnel.
 *
 * Every GET is answered by GitHub on every request. KV only spares the body
 * transfer: the cached copy is sent back as If-None-Match and used only on a
 * 304 (see cache.ts), which GitHub also doesn't count against the rate limit.
 */

interface Repo {
  full_name: string;
  owner: { login: string };
  archived: boolean;
}

/**
 * Every repository GITHUB_OWNER owns that the token can see, archived ones
 * left out (their workflows can't run). Sorted by name.
 */
export async function repos(rt: Runtime): Promise<string[]> {
  const owner = rt.env.GITHUB_OWNER.toLowerCase();
  const found: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh<Repo[]>(rt, `/user/repos?affiliation=owner,collaborator&sort=full_name&per_page=100&page=${page}`);
    for (const r of batch) if (r.owner.login.toLowerCase() === owner && !r.archived) found.push(r.full_name);
    if (batch.length < 100) break;
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/** Only GITHUB_OWNER's own, unarchived repositories, as GitHub lists them right now. */
export async function assertRepo(rt: Runtime, repo: string): Promise<string> {
  if (!(await repos(rt)).includes(repo)) throw new BadRequest(`repository ${repo} isn't one of ${rt.env.GITHUB_OWNER}'s active repositories`);
  return repo;
}

/** A repository with Actions turned off answers 404: it has no runs or workflows to show. */
async function orNone<T>(p: Promise<T>, none: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof UpstreamError && / -> HTTP 404 /.test(e.message)) return none;
    throw e;
  }
}

const JSON_ACCEPT = "application/vnd.github+json";

async function gh<T>(rt: Runtime, path: string, init: RequestInit & { accept?: string } = {}, as: "json" | "text" = "json"): Promise<T> {
  const { env } = rt;
  if (!env.GITHUB_TOKEN) throw new NotConfigured("GITHUB_TOKEN is not set; the deploy workflow copies it from Vault kv/ci/github.");
  const { accept: acceptOpt, ...rest } = init;
  const accept = acceptOpt ?? JSON_ACCEPT;
  const method = rest.method ?? "GET";
  const url = `https://api.github.com${path}`;
  const req: RequestInit = {
    ...rest,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hdctl",
      ...rest.headers,
    },
    signal: rest.signal ?? AbortSignal.timeout(10_000),
  };

  let status: number;
  let body: string;
  if (method === "GET") {
    // Keyed by URL and media type: the same URL answers differently per Accept.
    const r = await revalidatingFetch(env.CACHE, `gh:v1:${accept}:${path}`, url, req, { waitUntil: rt.waitUntil });
    ({ status, body } = r);
  } else {
    const res = await fetch(url, req);
    status = res.status;
    body = await res.text();
  }

  if (status < 200 || status >= 300) {
    throw new UpstreamError(`GitHub ${method} ${path} -> HTTP ${status} ${body.slice(0, 300)}`);
  }
  if (status === 204 || body === "") return null as T;
  return (as === "text" ? body : JSON.parse(body)) as T;
}

interface Run {
  id: number;
  name: string;
  display_title: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  run_number: number;
  run_attempt: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  actor?: { login: string };
  workflow_id: number;
}

export async function recentRuns(rt: Runtime, perRepo = 15) {
  const lists = await Promise.all(
    (await repos(rt)).map(async (repo) => {
      const body = await orNone(gh<{ workflow_runs: Run[] }>(rt, `/repos/${repo}/actions/runs?per_page=${perRepo}`), { workflow_runs: [] });
      return body.workflow_runs.map((r) => ({
        forge: "github" as const,
        id: r.id,
        repo,
        workflow: r.name,
        workflowId: r.workflow_id,
        title: r.display_title,
        event: r.event,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        runNumber: r.run_number,
        attempt: r.run_attempt,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        url: r.html_url,
        actor: r.actor?.login ?? null,
      }));
    }),
  );
  return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

interface Workflow { id: number; name: string; path: string; state: string; html_url: string }

export async function listWorkflows(rt: Runtime) {
  const lists = await Promise.all(
    (await repos(rt)).map(async (repo) => {
      const body = await orNone(gh<{ workflows: Workflow[] }>(rt, `/repos/${repo}/actions/workflows?per_page=100`), { workflows: [] });
      return body.workflows
        .filter((w) => w.state === "active" && w.path.startsWith(".github/workflows/"))
        .map((w) => ({ forge: "github" as const, repo, id: w.id, name: w.name, file: w.path.replace(".github/workflows/", ""), path: w.path, url: w.html_url }));
    }),
  );
  return lists.flat().sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
}

export interface DispatchInput {
  name: string;
  description: string | null;
  type: "string" | "boolean" | "choice" | "number" | "environment";
  required: boolean;
  default: string | boolean | number | null;
  options: string[];
}

/**
 * Pull workflow_dispatch's inputs out of a workflow file. Returns null when
 * the workflow can't be dispatched. Pure, so it is unit-tested.
 */
export function dispatchInputs(source: string): DispatchInput[] | null {
  const doc = parseYaml(source) as Record<string | number, unknown> | null;
  if (!doc || typeof doc !== "object") return null;
  // YAML 1.1 parsers read a bare `on:` key as boolean true; accept both.
  const on = (doc.on ?? (doc as Record<string, unknown>)["true"]) as unknown;
  let wd: unknown;
  if (typeof on === "string") wd = on === "workflow_dispatch" ? {} : undefined;
  else if (Array.isArray(on)) wd = on.includes("workflow_dispatch") ? {} : undefined;
  else if (on && typeof on === "object") wd = "workflow_dispatch" in on ? ((on as Record<string, unknown>).workflow_dispatch ?? {}) : undefined;
  if (wd === undefined) return null;

  const inputs = ((wd as { inputs?: Record<string, Record<string, unknown>> }).inputs ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(inputs).map(([name, spec]) => {
    const type = (["boolean", "choice", "number", "environment"].includes(String(spec?.type)) ? spec.type : "string") as DispatchInput["type"];
    const def = spec?.default;
    return {
      name,
      description: typeof spec?.description === "string" ? spec.description : null,
      type,
      required: spec?.required === true,
      default: typeof def === "string" || typeof def === "boolean" || typeof def === "number" ? def : null,
      options: Array.isArray(spec?.options) ? spec.options.map(String) : [],
    };
  });
}

function assertWorkflowFile(file: string): string {
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(file)) throw new BadRequest("bad workflow file name");
  return file;
}

async function defaultBranch(rt: Runtime, repo: string): Promise<string> {
  return (await gh<{ default_branch: string }>(rt, `/repos/${repo}`)).default_branch;
}

/** The workflow's dispatch inputs as defined on the default branch, which is what a dispatch runs. */
export async function workflowInputs(rt: Runtime, repo: string, file: string) {
  assertWorkflowFile(file);
  await assertRepo(rt, repo);
  const ref = await defaultBranch(rt, repo);
  const source = await gh<string>(
    rt,
    `/repos/${repo}/contents/.github/workflows/${file}?ref=${encodeURIComponent(ref)}`,
    { accept: "application/vnd.github.raw+json" },
    "text",
  );
  const inputs = dispatchInputs(source);
  return { repo, file, path: `.github/workflows/${file}`, ref, dispatchable: inputs !== null, inputs: inputs ?? [] };
}

/** Run a workflow on its default branch. Input values are sent as strings, as GitHub expects. */
export async function dispatch(rt: Runtime, repo: string, file: string, values: Record<string, unknown>) {
  const { ref, dispatchable, inputs } = await workflowInputs(rt, repo, file);
  if (!dispatchable) throw new BadRequest(`${file} has no workflow_dispatch trigger`);
  const known = new Map(inputs.map((i) => [i.name, i]));
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    const spec = known.get(k);
    if (!spec) throw new BadRequest(`unknown input "${k}"`);
    if (v === null || v === undefined || v === "") continue;
    const s = String(v);
    if (spec.type === "choice" && !spec.options.includes(s)) throw new BadRequest(`"${s}" is not an option for ${k}`);
    body[k] = s;
  }
  for (const i of inputs) if (i.required && !(i.name in body) && i.default === null) throw new BadRequest(`input "${i.name}" is required`);
  await gh<null>(rt, `/repos/${repo}/actions/workflows/${file}/dispatches`, { method: "POST", body: JSON.stringify({ ref, inputs: body }) });
  return { repo, file, ref, inputs: body };
}

// --- Pull requests ----------------------------------------------------------------------

export type ChecksState = "success" | "failure" | "pending" | "none";

/** An open pull request, as the Pull requests page shows it. Same shape for GitHub and Gitea. */
export interface PullRequest {
  forge: "github" | "gitea";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  head: string;
  /** The commit a merge is pinned to: if the branch moves, the merge is refused. */
  headSha: string;
  base: string;
  labels: string[];
  checks: ChecksState;
  mergeable: "yes" | "conflict" | "unknown";
  review: "approved" | "changes_requested" | "review_required" | null;
}

const PULLS_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt mergeable reviewDecision
        headRefName headRefOid baseRefName
        author { login }
        labels(first: 10) { nodes { name } }
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

interface GqlPull {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  repository: { nameWithOwner: string };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

const CHECKS: Record<string, ChecksState> = { SUCCESS: "success", FAILURE: "failure", ERROR: "failure", PENDING: "pending", EXPECTED: "pending" };

/**
 * Every open pull request in GITHUB_OWNER's own, unarchived repositories:
 * one GraphQL search, live, with each one's checks, mergeability and review.
 */
export async function openPulls(rt: Runtime): Promise<PullRequest[]> {
  const q = `is:pr is:open archived:false user:${rt.env.GITHUB_OWNER}`;
  const body = await gh<{ data?: { search: { nodes: (GqlPull | Record<string, never>)[] } }; errors?: { message: string }[] }>(rt, "/graphql", {
    method: "POST",
    body: JSON.stringify({ query: PULLS_QUERY, variables: { q } }),
  });
  if (body.errors?.length || !body.data) throw new UpstreamError(`GitHub GraphQL: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  const owner = rt.env.GITHUB_OWNER.toLowerCase();
  return body.data.search.nodes
    .filter((p): p is GqlPull => "number" in p && p.repository.nameWithOwner.split("/")[0]!.toLowerCase() === owner)
    .map((p): PullRequest => ({
      forge: "github",
      repo: p.repository.nameWithOwner,
      number: p.number,
      title: p.title,
      url: p.url,
      author: p.author?.login ?? null,
      draft: p.isDraft,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      head: p.headRefName,
      headSha: p.headRefOid,
      base: p.baseRefName,
      labels: p.labels.nodes.map((l) => l.name),
      checks: CHECKS[p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? ""] ?? "none",
      mergeable: p.mergeable === "MERGEABLE" ? "yes" : p.mergeable === "CONFLICTING" ? "conflict" : "unknown",
      review: p.reviewDecision ? (p.reviewDecision.toLowerCase() as PullRequest["review"]) : null,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function parsePullNumber(n: string): number {
  if (!/^[1-9]\d{0,9}$/.test(n)) throw new BadRequest("bad pull request number");
  return Number(n);
}

export function parseSha(sha: unknown): string {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new BadRequest("the merge needs the head commit (sha) you saw, so a branch that moved since isn't merged unseen");
  return sha;
}

/**
 * Merge with the first method the repository allows (merge commit, then
 * squash, then rebase), pinned to the head commit the page showed.
 */
export async function mergePull(rt: Runtime, repo: string, number: number, sha: string) {
  await assertRepo(rt, repo);
  const r = await gh<{ allow_merge_commit?: boolean; allow_squash_merge?: boolean; allow_rebase_merge?: boolean }>(rt, `/repos/${repo}`);
  const method = r.allow_merge_commit !== false ? "merge" : r.allow_squash_merge ? "squash" : "rebase";
  const res = await gh<{ merged: boolean; sha: string; message: string }>(rt, `/repos/${repo}/pulls/${number}/merge`, { method: "PUT", body: JSON.stringify({ sha, merge_method: method }) });
  return { repo, number, method, merged: res.merged, sha: res.sha };
}

export async function closePull(rt: Runtime, repo: string, number: number) {
  await assertRepo(rt, repo);
  const res = await gh<{ state: string }>(rt, `/repos/${repo}/pulls/${number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
  return { repo, number, state: res.state };
}
