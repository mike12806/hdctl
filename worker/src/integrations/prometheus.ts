import type { Env } from "../env";
import { TARGETS, targetById, targetFetch } from "../targets";
import { UpstreamError } from "../errors";

/**
 * The lab as Prometheus and Alertmanager see it (Rancher Monitoring in
 * cattle-monitoring-system, reached through their own VPC Services).
 *
 * Every request asks both, live: Prometheus sends no validators, so there is
 * nothing a cache could safely revalidate. Each page section is one PromQL
 * query (sub-expressions tagged with an `m` label and joined with `or`), so a
 * refresh is five Prometheus calls plus one to Alertmanager. A section whose
 * query fails comes back as its error with no data; the others still render.
 */

const PROMETHEUS = targetById("prometheus")!;
const ALERTMANAGER = targetById("alertmanager")!;
const TIMEOUT_MS = 10_000;

export interface Sample {
  metric: Record<string, string>;
  value: number;
}

export interface Section<T> {
  data: T | null;
  error: string | null;
}

/** One instant query. */
export async function query(env: Env, expr: string): Promise<Sample[]> {
  const res = await targetFetch(env, PROMETHEUS, `/api/v1/query?query=${encodeURIComponent(expr)}`, { headers: { Accept: "application/json" } }, TIMEOUT_MS);
  const body = (await res.json().catch(() => null)) as {
    status?: string;
    error?: string;
    data?: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] };
  } | null;
  if (!res.ok || body?.status !== "success" || !body.data) throw new UpstreamError(`Prometheus: ${body?.error ?? `HTTP ${res.status}`}`);
  if (body.data.resultType !== "vector") throw new UpstreamError(`Prometheus: expected a vector, got ${body.data.resultType}`);
  return body.data.result.map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
}

async function section<T>(run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { data: await run(), error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Tag a sub-expression so its samples can be told apart after `or`. */
const tag = (m: string, expr: string) => `label_replace(${expr}, "m", "${m}", "", "")`;
const by = (samples: Sample[], m: string) => samples.filter((s) => s.metric.m === m);
const finite = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : v);
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// --- Machines: every node exporter (k3s nodes, Proxmox, PBS, PDM) ------------

const NODE_JOBS = `job=~"node-exporter|proxmox-node-exporter"`;
const ROOT_FS = `mountpoint="/",fstype!~"tmpfs|overlay|rootfs"`;

export const MACHINES_QUERY = [
  tag("up", `up{${NODE_JOBS}}`),
  tag("info", `node_uname_info{${NODE_JOBS}}`),
  tag("cpu", `1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))`),
  tag("cores", `count by (instance) (node_cpu_seconds_total{mode="idle"})`),
  tag("mem", `1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes`),
  tag("memTotal", `node_memory_MemTotal_bytes`),
  tag("disk", `1 - node_filesystem_avail_bytes{${ROOT_FS}} / node_filesystem_size_bytes{${ROOT_FS}}`),
  tag("diskTotal", `node_filesystem_size_bytes{${ROOT_FS}}`),
  tag("load5", `node_load5`),
  tag("uptime", `time() - node_boot_time_seconds`),
  tag("ready", `kube_node_status_condition{condition="Ready",status="true"}`),
].join(" or ");

export interface Machine {
  name: string;
  kind: "host" | "k8s";
  instance: string;
  up: boolean;
  /** Kubernetes Ready condition; null for machines that aren't k3s nodes. */
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

export function parseMachines(samples: Sample[]): Machine[] {
  const byInstance = (m: string) => new Map(by(samples, m).map((s) => [s.metric.instance, s]));
  const info = byInstance("info");
  const metric = Object.fromEntries(["cpu", "cores", "mem", "memTotal", "disk", "diskTotal", "load5", "uptime"].map((m) => [m, byInstance(m)]));
  const ready = new Map(by(samples, "ready").map((s) => [s.metric.node, s.value === 1]));
  // Proxmox hosts are named after their hdctl target (pve4's own hostname is "pve").
  const targetByIp = new Map(TARGETS.filter((t) => t.address.ipv4).map((t) => [t.address.ipv4!, t.name]));

  return by(samples, "up")
    .map((s): Machine => {
      const instance = s.metric.instance ?? "";
      const nodename = info.get(instance)?.metric.nodename;
      const kind = s.metric.job === "proxmox-node-exporter" ? "host" : "k8s";
      const v = (m: string) => finite(metric[m]!.get(instance)?.value);
      return {
        name: targetByIp.get(instance.split(":")[0] ?? "") ?? nodename ?? instance,
        kind,
        instance,
        up: s.value === 1,
        ready: kind === "k8s" && nodename !== undefined ? (ready.get(nodename) ?? false) : null,
        cpu: v("cpu"),
        cores: v("cores"),
        mem: v("mem"),
        memTotal: v("memTotal"),
        disk: v("disk"),
        diskTotal: v("diskTotal"),
        load5: v("load5"),
        uptime: v("uptime"),
      };
    })
    .sort((a, b) => (a.kind === b.kind ? natural(a.name, b.name) : a.kind === "host" ? -1 : 1));
}

// --- Kubernetes workloads -------------------------------------------------------

export const WORKLOADS_QUERY = [
  tag("waiting", `kube_pod_container_status_waiting_reason{reason!~"ContainerCreating|PodInitializing"} == 1`),
  tag("notReady", `(kube_pod_status_ready{condition="false"} == 1) and on (namespace, pod) (kube_pod_status_phase{phase="Running"} == 1)`),
  tag("pending", `kube_pod_status_phase{phase="Pending"} == 1`),
  tag("deployment", `kube_deployment_status_replicas_unavailable > 0`),
  tag("statefulset", `kube_statefulset_status_replicas - kube_statefulset_status_replicas_ready > 0`),
  tag("daemonset", `kube_daemonset_status_number_unavailable > 0`),
  tag("failedJob", `(kube_job_status_failed > 0) and on (namespace, job_name) (time() - kube_job_status_start_time < 86400)`),
  tag("restarts", `increase(kube_pod_container_status_restarts_total[1h]) >= 1`),
  tag("running", `sum(kube_pod_status_phase{phase="Running"})`),
  tag("pods", `count(kube_pod_info)`),
].join(" or ");

export type ProblemKind = "waiting" | "notReady" | "pending" | "deployment" | "statefulset" | "daemonset" | "failedJob";

export interface Workloads {
  podsRunning: number | null;
  podsTotal: number | null;
  problems: { kind: ProblemKind; namespace: string; name: string; detail: string }[];
  /** Containers that restarted in the last hour, most first (top 10). */
  restarts: { namespace: string; pod: string; container: string; count: number }[];
}

export function parseWorkloads(samples: Sample[]): Workloads {
  const ns = (s: Sample) => s.metric.namespace ?? "";
  const n = (v: number) => Math.round(v);
  const problems: Workloads["problems"] = [
    ...by(samples, "waiting").map((s) => ({ kind: "waiting" as const, namespace: ns(s), name: s.metric.pod ?? "", detail: `${s.metric.reason} (${s.metric.container})` })),
    ...by(samples, "notReady").map((s) => ({ kind: "notReady" as const, namespace: ns(s), name: s.metric.pod ?? "", detail: "running, not ready" })),
    ...by(samples, "pending").map((s) => ({ kind: "pending" as const, namespace: ns(s), name: s.metric.pod ?? "", detail: "pending" })),
    ...by(samples, "deployment").map((s) => ({ kind: "deployment" as const, namespace: ns(s), name: s.metric.deployment ?? "", detail: `${n(s.value)} unavailable` })),
    ...by(samples, "statefulset").map((s) => ({ kind: "statefulset" as const, namespace: ns(s), name: s.metric.statefulset ?? "", detail: `${n(s.value)} not ready` })),
    ...by(samples, "daemonset").map((s) => ({ kind: "daemonset" as const, namespace: ns(s), name: s.metric.daemonset ?? "", detail: `${n(s.value)} unavailable` })),
    ...by(samples, "failedJob").map((s) => ({ kind: "failedJob" as const, namespace: ns(s), name: s.metric.job_name ?? "", detail: "failed in the last 24 h" })),
  ];
  // A container waiting on a crash also shows as a not-ready pod; keep the more specific one.
  const waitingPods = new Set(problems.filter((p) => p.kind === "waiting").map((p) => `${p.namespace}/${p.name}`));
  const unique = problems.filter((p) => p.kind !== "notReady" || !waitingPods.has(`${p.namespace}/${p.name}`));
  unique.sort((a, b) => natural(a.namespace, b.namespace) || natural(a.name, b.name));

  const restarts = by(samples, "restarts")
    .map((s) => ({ namespace: ns(s), pod: s.metric.pod ?? "", container: s.metric.container ?? "", count: n(s.value) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { podsRunning: finite(by(samples, "running")[0]?.value), podsTotal: finite(by(samples, "pods")[0]?.value), problems: unique, restarts };
}

// --- Volumes ----------------------------------------------------------------------

export const VOLUMES_QUERY = [
  tag("ratio", `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes`),
  tag("capacity", `kubelet_volume_stats_capacity_bytes`),
].join(" or ");

export interface Volumes {
  count: number;
  /** The fullest volumes, most full first (top 8). */
  fullest: { namespace: string; claim: string; used: number; capacity: number | null }[];
}

export function parseVolumes(samples: Sample[]): Volumes {
  const key = (s: Sample) => `${s.metric.namespace}/${s.metric.persistentvolumeclaim}`;
  const capacity = new Map(by(samples, "capacity").map((s) => [key(s), s.value]));
  const used = new Map<string, Sample>();
  for (const s of by(samples, "ratio")) if (Number.isFinite(s.value) && (used.get(key(s))?.value ?? -1) < s.value) used.set(key(s), s);
  const fullest = [...used.values()]
    .map((s) => ({ namespace: s.metric.namespace ?? "", claim: s.metric.persistentvolumeclaim ?? "", used: s.value, capacity: finite(capacity.get(key(s))) }))
    .sort((a, b) => b.used - a.used)
    .slice(0, 8);
  return { count: used.size, fullest };
}

// --- DNS: the Pi-holes, through pihole-exporter ---------------------------------------

export const DNS_QUERY = `{__name__=~"pihole_(dns_queries_today|ads_blocked_today|ads_percentage_today|status|unique_clients)"}`;

export interface PiHole {
  host: string;
  enabled: boolean | null;
  queriesToday: number | null;
  blockedToday: number | null;
  blockedPercent: number | null;
  clients: number | null;
}

export function parseDns(samples: Sample[]): PiHole[] {
  const hosts = new Map<string, Record<string, number>>();
  for (const s of samples) {
    const host = s.metric.hostname ?? s.metric.instance ?? "?";
    const values = hosts.get(host) ?? {};
    values[(s.metric.__name__ ?? "").replace(/^pihole_/, "")] = s.value;
    hosts.set(host, values);
  }
  return [...hosts.entries()]
    .map(([host, v]) => ({
      host,
      enabled: v.status === undefined ? null : v.status === 1,
      queriesToday: finite(v.dns_queries_today),
      blockedToday: finite(v.ads_blocked_today),
      blockedPercent: finite(v.ads_percentage_today),
      clients: finite(v.unique_clients),
    }))
    .sort((a, b) => natural(a.host, b.host));
}

// --- Scrape targets ---------------------------------------------------------------

export const SCRAPE_QUERY = [tag("down", `up == 0`), tag("total", `count(up)`)].join(" or ");

export interface Scrape {
  total: number | null;
  down: { job: string; instance: string }[];
}

export function parseScrape(samples: Sample[]): Scrape {
  return {
    total: finite(by(samples, "total")[0]?.value),
    down: by(samples, "down")
      .map((s) => ({ job: s.metric.job ?? "", instance: s.metric.instance ?? "" }))
      .sort((a, b) => natural(a.job, b.job) || natural(a.instance, b.instance)),
  };
}

// --- Alerts, from Alertmanager --------------------------------------------------------

export interface Alert {
  name: string;
  severity: string;
  /** firing, or held back by a silence or an inhibition rule. */
  state: "firing" | "silenced" | "inhibited";
  summary: string | null;
  description: string | null;
  where: string | null;
  startsAt: string;
}

interface AmAlert {
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt: string;
  status?: { state?: string; silencedBy?: string[]; inhibitedBy?: string[] };
}

/** Alerts that always fire by design, to prove the pipeline works. */
const PLUMBING = new Set(["Watchdog", "InfoInhibitor"]);
const SEVERITY_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 };

export function parseAlerts(alerts: AmAlert[]): Alert[] {
  return alerts
    .filter((a) => !PLUMBING.has(a.labels.alertname ?? "") && a.labels.severity !== "none")
    .map((a): Alert => {
      const l = a.labels;
      const state = a.status?.silencedBy?.length ? "silenced" : a.status?.inhibitedBy?.length ? "inhibited" : "firing";
      // The workload the alert is about. `pod` comes last: on kube-state-metrics
      // alerts about a Job or Deployment it names the exporter's own pod.
      const object = l.job_name ?? l.deployment ?? l.statefulset ?? l.daemonset ?? l.persistentvolumeclaim ?? l.pod;
      const where = l.namespace && object ? `${l.namespace}/${object}` : (l.namespace ?? l.node ?? l.instance ?? l.job ?? null);
      // Rancher's rules end with "on cluster {{ $labels.cluster }}", and there's no cluster label.
      const tidy = (s: string | undefined) => (s ? s.replace(/\s+on cluster\s*\.?\s*$/, ".") : null);
      return {
        name: l.alertname ?? "alert",
        severity: l.severity ?? "none",
        state,
        summary: tidy(a.annotations?.summary),
        description: tidy(a.annotations?.description ?? a.annotations?.message),
        where,
        startsAt: a.startsAt,
      };
    })
    .sort(
      (a, b) =>
        Number(a.state !== "firing") - Number(b.state !== "firing") ||
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        b.startsAt.localeCompare(a.startsAt),
    );
}

async function alertmanagerAlerts(env: Env): Promise<Alert[]> {
  const res = await targetFetch(env, ALERTMANAGER, "/api/v2/alerts?active=true", { headers: { Accept: "application/json" } }, TIMEOUT_MS);
  if (!res.ok) throw new UpstreamError(`Alertmanager: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parseAlerts((await res.json()) as AmAlert[]);
}

// --- The page --------------------------------------------------------------------------

export async function overview(env: Env) {
  const q = <T>(expr: string, parse: (s: Sample[]) => T) => section(async () => parse(await query(env, expr)));
  // The network isn't here: it comes from the UDM's own API (integrations/unifi.ts), not unpoller.
  const [alerts, machines, workloads, volumes, dns, scrape] = await Promise.all([
    section(() => alertmanagerAlerts(env)),
    q(MACHINES_QUERY, parseMachines),
    q(WORKLOADS_QUERY, parseWorkloads),
    q(VOLUMES_QUERY, parseVolumes),
    q(DNS_QUERY, parseDns),
    q(SCRAPE_QUERY, parseScrape),
  ]);
  return { asOf: Date.now(), alerts, machines, workloads, volumes, dns, scrape };
}
