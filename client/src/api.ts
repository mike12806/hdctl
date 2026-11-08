/** Typed calls to the Worker's /api. */

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly setup = false) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        // Required on every state-changing call; see the CSRF note in worker/src/index.ts.
        "X-Hdctl": "1",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    // An expired Access session answers API calls with a redirect to the
    // login page on another origin, which fetch reports as a network error.
    throw new ApiError("Can't reach hdctl. Your Access session may have expired: reload the page to sign in again.", 0);
  }
  const body = (await res.json().catch(() => null)) as { error?: string; setup?: boolean } | null;
  if (!res.ok) throw new ApiError(body?.error ?? res.statusText, res.status, body?.setup === true);
  return body as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

// --- Shapes returned by the Worker ------------------------------------------

export type State = "up" | "degraded" | "down";

export interface StatusTarget {
  id: string;
  name: string;
  group: string;
  link: string | null;
  endpoint: string;
  state: State | null;
  since: number | null;
  checkedAt: number | null;
  code: number | null;
  latencyMs: number | null;
  detail: string | null;
  uptime24h: number | null;
  history: { at: number; state: State }[];
}

export interface StatusSummary {
  generatedAt: number;
  groups: Record<string, string>;
  targets: StatusTarget[];
}

export interface ArgoApp {
  name: string;
  project: string;
  namespace: string | null;
  repo: string | null;
  path: string | null;
  sync: string;
  revision: string | null;
  health: string;
  healthMessage: string | null;
  operation: string | null;
  operationMessage: string | null;
  operationFinishedAt: string | null;
  reconciledAt: string | null;
}

export interface PveGuest {
  node: string;
  vmid: number;
  type: "qemu" | "lxc";
  name: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
  tags: string[];
}

export interface PveHost {
  id: string;
  name: string;
  link: string | null;
  error: string | null;
  nodes: { node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; uptime: number }[];
  guests: PveGuest[];
}

export interface WorkflowRun {
  id: number;
  repo: string;
  workflow: string;
  workflowId: number;
  title: string;
  event: string;
  status: string;
  conclusion: string | null;
  branch: string;
  runNumber: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  actor: string | null;
}

export interface Workflow {
  repo: string;
  id: number;
  name: string;
  file: string;
  url: string;
}

export interface DispatchInput {
  name: string;
  description: string | null;
  type: "string" | "boolean" | "choice" | "number" | "environment";
  required: boolean;
  default: string | boolean | number | null;
  options: string[];
}

export interface WorkflowInputs {
  repo: string;
  file: string;
  ref: string;
  dispatchable: boolean;
  inputs: DispatchInput[];
}

export interface AuditEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  params: string | null;
  status: "started" | "ok" | "error";
  result: string | null;
  finished_at: number | null;
}
