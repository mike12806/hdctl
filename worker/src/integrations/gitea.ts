import type { Env } from "../env";
import { BadRequest, NotConfigured, UpstreamError } from "../errors";
import { targetById, targetFetch } from "../targets";
import { dispatchInputs } from "./github";

/**
 * Gitea Actions for every repository on the Gitea instance: recent runs, the
 * workflow list, and workflow_dispatch with the workflow's own inputs. Read
 * from Gitea's own API (/api/v1), through the GITEA VPC Service pinned to
 * 192.168.9.3:3000, with a token from Vault (GITEA_TOKEN, an admin's, so it
 * sees every repository). Nothing is cached: every request asks Gitea.
 *
 * Gitea's Actions API follows GitHub's, so runs and workflows come out in
 * the same shape as github.ts's, tagged forge: "gitea".
 */

const GITEA = targetById("gitea")!;
/** Gitea builds links from the address it was reached on (the LAN IP); show its public one. */
const PUBLIC = GITEA.link ?? "https://git.mfaherty.net";
const PAGE = 50;

function token(env: Env): string {
  if (!env.GITEA_TOKEN) throw new NotConfigured("GITEA_TOKEN is not set. Create a Gitea access token and store it at Vault kv/github/hdctl/gitea (see docs/operations.md).");
  return env.GITEA_TOKEN;
}

async function gitea(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await targetFetch(env, GITEA, `/api/v1${path}`, {
    ...init,
    headers: { Authorization: `token ${token(env)}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) throw new UpstreamError(`Gitea ${init.method ?? "GET"} ${path} -> HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

const json = async <T>(env: Env, path: string) => (await (await gitea(env, path)).json()) as T;

/** Gitea's own page URL, on its public address. */
export function publicUrl(url: string | null | undefined): string {
  if (!url) return PUBLIC;
  try {
    const u = new URL(url);
    return `${PUBLIC}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return PUBLIC;
  }
}

interface Repo {
  full_name: string;
  archived: boolean;
  has_actions?: boolean;
  default_branch: string;
}

/** Every repository on the instance the token can see, archived ones left out. Sorted by name. */
export async function repos(env: Env): Promise<Repo[]> {
  const found: Repo[] = [];
  for (let page = 1; page <= 20; page++) {
    const body = await json<{ ok: boolean; data: Repo[] }>(env, `/repos/search?limit=${PAGE}&page=${page}&sort=alpha&order=asc`);
    found.push(...body.data.filter((r) => !r.archived));
    if (body.data.length < PAGE) break;
  }
  return found.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function repoNamed(env: Env, repo: string): Promise<Repo> {
  const r = (await repos(env)).find((x) => x.full_name === repo);
  if (!r) throw new BadRequest(`repository ${repo} isn't an active repository on Gitea`);
  return r;
}

interface GiteaWorkflow {
  id: string;
  name: string;
  path: string;
  state: string;
  html_url: string;
}

/** "deploy.yml@refs/heads/main" or ".gitea/workflows/deploy.yml" -> "deploy.yml". */
const fileOf = (path: string) => path.split("@")[0]!.split("/").pop()!;

async function workflowsOf(env: Env, repo: Repo): Promise<GiteaWorkflow[]> {
  if (repo.has_actions === false) return [];
  const body = await json<{ workflows: GiteaWorkflow[] | null }>(env, `/repos/${repo.full_name}/actions/workflows`);
  return body.workflows ?? [];
}

interface GiteaRun {
  id: number;
  path: string;
  display_title: string;
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
}

/** UTC ISO time; Gitea sends local times with an offset, GitHub sends UTC. */
const iso = (t: string) => new Date(t).toISOString();

export async function recentRuns(env: Env, perRepo = 15) {
  const lists = await Promise.all(
    (await repos(env))
      .filter((r) => r.has_actions !== false)
      .map(async (repo) => {
        const [wfs, body] = await Promise.all([workflowsOf(env, repo), json<{ workflow_runs: GiteaRun[] | null }>(env, `/repos/${repo.full_name}/actions/runs?limit=${perRepo}`)]);
        const names = new Map(wfs.map((w) => [fileOf(w.path), w.name]));
        return (body.workflow_runs ?? []).map((r) => {
          const file = fileOf(r.path);
          return {
            forge: "gitea" as const,
            id: r.id,
            repo: repo.full_name,
            workflow: names.get(file) ?? file,
            workflowId: file,
            title: r.display_title,
            event: r.event,
            status: r.status,
            conclusion: r.conclusion || null,
            branch: r.head_branch,
            runNumber: r.run_number,
            attempt: r.run_attempt,
            createdAt: iso(r.created_at),
            updatedAt: iso(r.updated_at),
            url: publicUrl(r.html_url),
            actor: r.actor?.login ?? null,
          };
        });
      }),
  );
  return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listWorkflows(env: Env) {
  const lists = await Promise.all(
    (await repos(env)).map(async (repo) =>
      (await workflowsOf(env, repo))
        .filter((w) => w.state === "active")
        .map((w) => ({ forge: "gitea" as const, repo: repo.full_name, id: w.id, name: w.name, file: fileOf(w.path), path: w.path, url: publicUrl(w.html_url) })),
    ),
  );
  return lists.flat().sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
}

function assertWorkflowFile(file: string): string {
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(file)) throw new BadRequest("bad workflow file name");
  return file;
}

/** The workflow's dispatch inputs as defined on the default branch, which is what a dispatch runs. */
export async function workflowInputs(env: Env, repoName: string, file: string) {
  assertWorkflowFile(file);
  const repo = await repoNamed(env, repoName);
  const wf = (await workflowsOf(env, repo)).find((w) => fileOf(w.path) === file);
  if (!wf) throw new BadRequest(`${repoName} has no workflow ${file}`);
  const ref = repo.default_branch;
  const source = await (await gitea(env, `/repos/${repo.full_name}/raw/${wf.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, { headers: { Accept: "text/plain" } })).text();
  const inputs = dispatchInputs(source);
  return { repo: repo.full_name, file, path: wf.path, ref, dispatchable: inputs !== null, inputs: inputs ?? [] };
}

/** Run a workflow on its default branch. Input values are sent as strings, as Gitea expects. */
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
  await gitea(env, `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { method: "POST", body: JSON.stringify({ ref, inputs: body }) });
  return { repo, file, ref, inputs: body };
}
