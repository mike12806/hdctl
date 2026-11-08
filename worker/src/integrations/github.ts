import { parse as parseYaml } from "yaml";
import type { Env } from "../env";
import { BadRequest, NotConfigured, UpstreamError } from "../errors";

/**
 * GitHub Actions for the repositories in GITHUB_REPOS: recent runs, the
 * workflow list, and workflow_dispatch with the workflow's own inputs. This is
 * the one integration that goes over the public internet (api.github.com),
 * not through the tunnel.
 */

export function repos(env: Env): string[] {
  return env.GITHUB_REPOS.split(",").map((r) => r.trim()).filter(Boolean);
}

export function assertRepo(env: Env, repo: string): string {
  if (!repos(env).includes(repo)) throw new BadRequest(`repository ${repo} is not in GITHUB_REPOS`);
  return repo;
}

async function gh<T>(env: Env, path: string, init: RequestInit = {}, as: "json" | "text" = "json"): Promise<T> {
  if (!env.GITHUB_TOKEN) throw new NotConfigured("GITHUB_TOKEN is not set; the deploy workflow copies it from Vault kv/ci/github.");
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hdctl",
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new UpstreamError(`GitHub ${init.method ?? "GET"} ${path} -> HTTP ${res.status} ${text}`);
  }
  if (res.status === 204) return null as T;
  return (as === "text" ? await res.text() : await res.json()) as T;
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

export async function recentRuns(env: Env, perRepo = 15) {
  const lists = await Promise.all(
    repos(env).map(async (repo) => {
      const body = await gh<{ workflow_runs: Run[] }>(env, `/repos/${repo}/actions/runs?per_page=${perRepo}`);
      return body.workflow_runs.map((r) => ({
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

export async function listWorkflows(env: Env) {
  const lists = await Promise.all(
    repos(env).map(async (repo) => {
      const body = await gh<{ workflows: Workflow[] }>(env, `/repos/${repo}/actions/workflows?per_page=100`);
      return body.workflows
        .filter((w) => w.state === "active" && w.path.startsWith(".github/workflows/"))
        .map((w) => ({ repo, id: w.id, name: w.name, file: w.path.replace(".github/workflows/", ""), url: w.html_url }));
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

async function defaultBranch(env: Env, repo: string): Promise<string> {
  return (await gh<{ default_branch: string }>(env, `/repos/${repo}`)).default_branch;
}

/** The workflow's dispatch inputs as defined on the default branch, which is what a dispatch runs. */
export async function workflowInputs(env: Env, repo: string, file: string) {
  assertRepo(env, repo);
  assertWorkflowFile(file);
  const ref = await defaultBranch(env, repo);
  const source = await gh<string>(
    env,
    `/repos/${repo}/contents/.github/workflows/${file}?ref=${encodeURIComponent(ref)}`,
    { headers: { Accept: "application/vnd.github.raw+json" } },
    "text",
  );
  const inputs = dispatchInputs(source);
  return { repo, file, ref, dispatchable: inputs !== null, inputs: inputs ?? [] };
}

/** Run a workflow on its default branch. Input values are sent as strings, as GitHub expects. */
export async function dispatch(env: Env, repo: string, file: string, values: Record<string, unknown>) {
  const { ref, dispatchable, inputs } = await workflowInputs(env, repo, file);
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
  await gh<null>(env, `/repos/${repo}/actions/workflows/${file}/dispatches`, { method: "POST", body: JSON.stringify({ ref, inputs: body }) });
  return { repo, file, ref, inputs: body };
}
