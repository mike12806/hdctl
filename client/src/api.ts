/** Typed calls to the Worker's /api. */

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly setup = false) {
    super(message);
  }
}

/** Fired when the Worker reports a different build than this bundle: a deploy happened. */
export const NEW_BUILD_EVENT = "hdctl:new-build";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // Never answered from the browser's HTTP cache (the Worker also sends no-store).
      cache: "no-store",
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
  const build = res.headers.get("X-Hdctl-Build");
  if (build && build !== __HDCTL_BUILD__) window.dispatchEvent(new CustomEvent(NEW_BUILD_EVENT, { detail: build }));
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
  /** Live: probed by the Worker for this very response. */
  state: State;
  checkedAt: number;
  code: number | null;
  latencyMs: number | null;
  detail: string | null;
  /** Recorded: when the target entered its live state, if the cron saw that. */
  since: number | null;
  /** Recorded: the live state differs from the last recorded check, so it changed after this. */
  changedAfter: number | null;
  uptime24h: number | null;
  history: { at: number; state: State }[];
}

export interface StatusSummary {
  asOf: number;
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

export type Forge = "github" | "gitea";

export interface WorkflowRun {
  forge: Forge;
  id: number;
  repo: string;
  workflow: string;
  workflowId: number | string;
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
  forge: Forge;
  repo: string;
  id: number | string;
  name: string;
  file: string;
  /** Where the file lives: .github/workflows/… or .gitea/workflows/… */
  path: string;
  url: string;
}

/** An open pull request on GitHub or Gitea, in one shape. */
export interface PullRequest {
  forge: Forge;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  head: string;
  headSha: string;
  base: string;
  labels: string[];
  checks: "success" | "failure" | "pending" | "none";
  mergeable: "yes" | "conflict" | "unknown";
  review: "approved" | "changes_requested" | "review_required" | null;
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
  path: string;
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

// --- /api/metrics: Prometheus and Alertmanager --------------------------------

/** One part of the Metrics page: its data, or the error that stopped it. Never both. */
export interface Section<T> {
  data: T | null;
  error: string | null;
}

export interface Alert {
  name: string;
  severity: string;
  state: "firing" | "silenced" | "inhibited";
  summary: string | null;
  description: string | null;
  where: string | null;
  startsAt: string;
}

export interface Machine {
  name: string;
  kind: "host" | "k8s";
  instance: string;
  up: boolean;
  ready: boolean | null;
  cpu: number | null;
  cores: number | null;
  mem: number | null;
  memTotal: number | null;
  disk: number | null;
  diskTotal: number | null;
  load5: number | null;
  uptime: number | null;
}

export interface Workloads {
  podsRunning: number | null;
  podsTotal: number | null;
  problems: { kind: string; namespace: string; name: string; detail: string }[];
  restarts: { namespace: string; pod: string; container: string; count: number }[];
}

export interface Volumes {
  count: number;
  fullest: { namespace: string; claim: string; used: number; capacity: number | null }[];
}

// --- /api/dns: each Pi-hole's own API ---------------------------------------------

export interface PiHole {
  host: string;
  link: string | null;
  /** Why this Pi-hole has no numbers; never set together with them. */
  error: string | null;
  enabled: boolean | null;
  queriesToday: number | null;
  blockedToday: number | null;
  blockedPercent: number | null;
  clients: number | null;
}

export interface DnsOverview {
  asOf: number;
  hosts: PiHole[];
}

export interface MetricsOverview {
  asOf: number;
  alerts: Section<Alert[]>;
  machines: Section<Machine[]>;
  workloads: Section<Workloads>;
  volumes: Section<Volumes>;
  scrape: Section<{ total: number | null; down: { job: string; instance: string }[] }>;
}

// --- /api/unifi: the UDM's own Network API --------------------------------------

export interface UnifiHealth {
  subsystems: { name: string; status: string }[];
  wan: { ip: string | null; isp: string | null; downloadBps: number | null; uploadBps: number | null; availability: number | null };
  gateway: { name: string | null; version: string | null; cpu: number | null; mem: number | null; uptime: number | null };
  internet: { latencyMs: number | null; drops: number | null };
  speedtest: { downMbps: number | null; upMbps: number | null; pingMs: number | null; lastRunAt: number | null; running: boolean };
  clients: { wifi: number | null; wired: number | null; guests: number | null; vpn: number | null };
  devices: { accessPoints: number | null; switches: number | null; disconnected: number | null; pending: number | null };
}

export interface UnifiPort {
  idx: number;
  name: string;
  up: boolean;
  speedMbps: number | null;
  poe: boolean;
  poeWatts: number | null;
}

export interface UnifiDevice {
  mac: string;
  name: string;
  model: string;
  kind: "gateway" | "switch" | "ap" | "other";
  ip: string | null;
  state: string;
  online: boolean;
  version: string | null;
  upgradeTo: string | null;
  uptime: number | null;
  cpu: number | null;
  mem: number | null;
  clients: number | null;
  locating: boolean;
  ports: UnifiPort[];
}

export interface UnifiClient {
  mac: string;
  name: string;
  ip: string | null;
  wired: boolean;
  guest: boolean;
  network: string | null;
  via: string | null;
  ssid: string | null;
  signal: number | null;
  satisfaction: number | null;
  uptime: number | null;
  rateBps: number | null;
}

export interface UnifiOverview {
  asOf: number;
  health: Section<UnifiHealth>;
  devices: Section<UnifiDevice[]>;
  clients: Section<UnifiClient[]>;
}

// --- /api/kuma/live: Uptime Kuma, pushed over a WebSocket ------------------------

export type MonitorStatus = "up" | "down" | "pending" | "maintenance" | "paused" | "unknown";

export interface Beat {
  at: number;
  status: MonitorStatus;
  pingMs: number | null;
}

export interface LiveMonitor {
  id: number;
  name: string;
  type: string | null;
  target: string | null;
  status: MonitorStatus;
  msg: string | null;
  lastBeatAt: number | null;
  pingMs: number | null;
  avgPing24hMs: number | null;
  uptime24h: number | null;
  uptime30d: number | null;
  cert: { valid: boolean; daysRemaining: number | null; validTo: string | null } | null;
  beats: Beat[];
}

export interface Incident {
  monitorId: number;
  status: MonitorStatus;
  at: number;
  msg: string;
}

export type LiveMessage =
  | { type: "connecting" }
  | { type: "snapshot"; asOf: number; monitors: LiveMonitor[]; incidents: Incident[] }
  | { type: "update"; asOf: number; monitors: LiveMonitor[]; removed: number[]; incidents: Incident[] }
  | { type: "alive"; asOf: number }
  | { type: "error"; error: string; setup?: boolean };
