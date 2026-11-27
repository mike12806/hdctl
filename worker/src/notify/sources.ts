import type { Env, Runtime } from "../env";
import type { CheckResult } from "../health";
import { GROUP_LABELS, TARGETS, targetById, type Target } from "../targets";
import { alertmanagerAlerts } from "../integrations/prometheus";
import * as argo from "../integrations/argo";
import * as github from "../integrations/github";
import * as gitea from "../integrations/gitea";
import * as pve from "../integrations/proxmox";
import * as unifi from "../integrations/unifi";
import * as pihole from "../integrations/pihole";
import type { LiveMonitor, Snapshot } from "../integrations/kuma";
import { UpstreamError } from "../errors";
import type { Observation, Problem, Severity } from "./types";

/**
 * What is wrong right now, per feed, each read from its own system of record:
 *
 *   endpoint  hdctl's own probes (the cron's, the same ones the Status page makes)
 *   alert     Alertmanager, the system of record for alerts
 *   argo      Argo CD's API: apps that are degraded or whose last sync failed
 *   github    GitHub's API: workflows whose latest run on the default branch failed
 *   gitea     Gitea's API: the same
 *   kuma      Uptime Kuma's own (Socket.IO) API: monitors down, certificates expiring
 *   proxmox   each Proxmox host's API: guests set to start at boot that aren't running
 *   backup    the same API: nodes whose latest backup (vzdump) run failed
 *   unifi     the UDM's own API: devices offline, WAN or internet trouble
 *   pihole    each Pi-hole's own API: blocking switched off
 *
 * Each is a pure translation of that system's answer into problems, so the
 * rules (thresholds, grouping, what counts as recovered) are unit-tested here.
 */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- Endpoints ------------------------------------------------------------------

/** Two consecutive cron runs, two to four minutes: a single failed probe is noise. */
export const ENDPOINT_THRESHOLD = 2;
/** Groups this size or larger collapse into one incident when every member is down. */
export const GROUP_MIN = 3;
/** When this share of every endpoint is down at once, it's the path to the lab, not the lab. */
export const LAB_SHARE = 0.8;

const where = (t: Target) => `${t.address.ipv4 ?? t.address.hostname}:${t.port}`;
const why = (r: CheckResult) => r.detail ?? (r.code !== null ? `HTTP ${r.code}` : "no answer");

/** The most common failure among several, so a group's message names the likely cause. */
function commonCause(results: CheckResult[]): string {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(why(r), (counts.get(why(r)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "no answer";
}

const names = (ts: Target[], max = 4) => (ts.length > max ? `${ts.slice(0, max).map((t) => t.name).join(", ")} and ${ts.length - max} more` : ts.map((t) => t.name).join(", "));

/**
 * The cron's probe results as problems. Three levels, so an outage is one
 * notification rather than dozens:
 *   - most of the lab down at once (the tunnel, or its connector in k3s): one "lab" incident;
 *   - every member of a group of three or more down: one "group:<id>" incident;
 *   - otherwise one "target:<id>" incident per endpoint that isn't up.
 * A target folded into a lab or group incident keeps any incident of its own
 * open, untouched: it isn't known to be fine, only reported together.
 */
export function observeEndpoints(results: CheckResult[], targets: readonly Target[] = TARGETS): Observation {
  const byId = new Map(results.map((r) => [r.targetId, r]));
  const known = targets.filter((t) => byId.has(t.id));
  const state = (t: Target) => byId.get(t.id)!.state;
  const down = known.filter((t) => state(t) === "down");
  const problems: Problem[] = [];
  const folded = new Set<string>();

  const labDown = known.length >= GROUP_MIN && down.length >= Math.max(GROUP_MIN, Math.ceil(LAB_SHARE * known.length));
  const groups = new Map<string, Target[]>();
  for (const t of known) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);

  if (labDown) {
    problems.push({
      key: "lab",
      source: "endpoint",
      severity: "critical",
      subject: "The lab",
      title: "hdctl can't reach the lab",
      body: `${down.length} of ${known.length} endpoints are down (${commonCause(down.map((t) => byId.get(t.id)!))}). The tunnel or its connector in k3s is the likely cause.`,
      url: "/",
      link: null,
      threshold: ENDPOINT_THRESHOLD,
    });
    for (const t of known) folded.add(t.id);
  } else {
    for (const [group, members] of groups) {
      if (members.length < GROUP_MIN || !members.every((t) => state(t) === "down")) continue;
      const label = GROUP_LABELS[group as keyof typeof GROUP_LABELS] ?? group;
      problems.push({
        key: `group:${group}`,
        source: "endpoint",
        severity: "critical",
        subject: label,
        title: `${label}: all ${members.length} down`,
        body: clip(`${names(members)}: ${commonCause(members.map((t) => byId.get(t.id)!))}`, 300),
        url: "/",
        link: null,
        threshold: ENDPOINT_THRESHOLD,
      });
      for (const t of members) folded.add(t.id);
    }
  }

  for (const t of known) {
    const r = byId.get(t.id)!;
    if (folded.has(t.id) || r.state === "up") continue;
    problems.push({
      key: `target:${t.id}`,
      source: "endpoint",
      severity: r.state === "down" ? "critical" : "warning",
      subject: t.name,
      title: `${t.name} is ${r.state}`,
      body: clip(`${why(r)} · ${where(t)}`, 300),
      url: "/",
      link: t.link ?? null,
      threshold: ENDPOINT_THRESHOLD,
    });
  }

  return {
    feed: "endpoint",
    source: "endpoint",
    prefix: "",
    problems,
    resolution(key) {
      if (key === "lab") return labDown ? null : "reachable again";
      if (key.startsWith("group:")) {
        const members = groups.get(key.slice(6));
        if (!members) return "no longer monitored";
        if (labDown) return null;
        const up = members.filter((t) => state(t) === "up").length;
        return up === members.length ? "all back up" : `${up} of ${members.length} back up`;
      }
      if (key.startsWith("target:")) {
        const id = key.slice(7);
        const r = byId.get(id);
        if (!r) return targetById(id) ? null : "no longer monitored";
        return r.state === "up" ? `back up${r.code !== null ? ` (HTTP ${r.code})` : ""}` : null;
      }
      return null;
    },
  };
}

// --- Alertmanager ---------------------------------------------------------------

const ALERT_SEVERITY: Record<string, Severity> = { critical: "critical", error: "critical", warning: "warning" };

/**
 * Firing alerts, as Alertmanager holds them. Told at once: alert rules carry
 * their own `for:` delay, so a second one here would only add latency.
 * Alertmanager's active list is complete, so an alert that left it, or was
 * silenced or inhibited there, is over.
 */
export async function observeAlerts(env: Env): Promise<Observation> {
  const alerts = await alertmanagerAlerts(env);
  const silenced = new Set(alerts.filter((a) => a.state === "silenced").map((a) => a.fingerprint));
  const inhibited = new Set(alerts.filter((a) => a.state === "inhibited").map((a) => a.fingerprint));
  return {
    feed: "alert",
    source: "alert",
    prefix: "",
    problems: alerts
      .filter((a) => a.state === "firing")
      .map((a) => ({
        key: `alert:${a.fingerprint}`,
        source: "alert" as const,
        severity: ALERT_SEVERITY[a.severity] ?? "info",
        subject: a.name,
        title: clip(a.where ? `${a.name} on ${a.where}` : a.name, 120),
        body: clip(a.summary ?? a.description ?? `${a.severity} alert, firing in Alertmanager.`, 300),
        url: "/metrics",
        link: null,
        threshold: 1,
      })),
    resolution(key) {
      const fp = key.slice(6);
      if (silenced.has(fp)) return "silenced in Alertmanager";
      if (inhibited.has(fp)) return "inhibited by another alert";
      return "no longer firing";
    },
  };
}

// --- Argo CD --------------------------------------------------------------------

const BAD_HEALTH = new Set(["Degraded", "Missing"]);
const FINE_HEALTH = new Set(["Healthy", "Suspended"]);
const FAILED_SYNC = new Set(["Failed", "Error"]);
/** Degraded for two runs: a rollout can be briefly degraded and heal on its own. */
export const ARGO_HEALTH_THRESHOLD = 2;

type ArgoApp = Awaited<ReturnType<typeof argo.listApps>>[number];

export function argoObservation(apps: ArgoApp[]): Observation {
  const byName = new Map(apps.map((a) => [a.name, a]));
  const link = (name: string) => `${targetById("argo")?.link ?? "https://argo.mfaherty.net"}/applications/${encodeURIComponent(name)}`;
  const problems: Problem[] = [];
  for (const a of apps) {
    if (BAD_HEALTH.has(a.health)) {
      problems.push({
        key: `argo:${a.name}:health`,
        source: "argo",
        severity: "warning",
        subject: a.name,
        title: `${a.name} is ${a.health.toLowerCase()} in Argo CD`,
        body: clip(a.healthMessage ?? `Argo CD reports the app as ${a.health}.`, 300),
        url: "/argo",
        link: link(a.name),
        threshold: ARGO_HEALTH_THRESHOLD,
      });
    }
    if (a.operation && FAILED_SYNC.has(a.operation)) {
      problems.push({
        key: `argo:${a.name}:sync`,
        source: "argo",
        severity: "warning",
        subject: a.name,
        title: `Sync failed: ${a.name}`,
        body: clip(a.operationMessage ?? `The last sync ended in ${a.operation}.`, 300),
        url: "/argo",
        link: link(a.name),
        threshold: 1,
      });
    }
  }
  return {
    feed: "argo",
    source: "argo",
    prefix: "",
    problems,
    resolution(key) {
      const m = /^argo:(.+):(health|sync)$/.exec(key);
      if (!m) return null;
      const app = byName.get(m[1]!);
      if (!app) return "no longer in Argo CD";
      if (m[2] === "health") return FINE_HEALTH.has(app.health) ? `${app.health.toLowerCase()} again` : null;
      // Running: a retry is under way, so neither failed nor fixed yet.
      return app.operation === null || app.operation === "Succeeded" ? "synced" : null;
    },
  };
}

/** Null when Argo CD isn't set up: nothing to say, which is different from failing to say it. */
export async function observeArgo(env: Env): Promise<Observation | null> {
  if (!env.ARGOCD_TOKEN) return null;
  return argoObservation(await argo.listApps(env));
}

// --- Workflows (GitHub, Gitea) ---------------------------------------------------

/** Runs that are the default branch's own: merges, schedules, manual runs. Not pull requests. */
const BRANCH_EVENTS = new Set(["push", "schedule", "workflow_dispatch", "workflow_run", "repository_dispatch", "release"]);
const FAILED_RUN = new Set(["failure", "timed_out", "startup_failure"]);

export interface RunLike {
  repo: string;
  workflow: string;
  workflowId: number | string;
  title: string;
  event: string;
  status: string;
  conclusion: string | null;
  branch: string;
  runNumber: number;
  createdAt: string;
  url: string;
}

/**
 * A workflow whose latest finished run on the repository's default branch
 * failed: with gitops, that's main not deploying. Fixed when a later run of
 * it there succeeds. Runs this read doesn't include (an older window, a
 * cancelled retry) say nothing either way.
 */
export function workflowObservation(forge: "github" | "gitea", runs: RunLike[], defaultBranch: Map<string, string | null>): Observation {
  const latest = new Map<string, RunLike>();
  for (const r of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (r.status !== "completed" || !BRANCH_EVENTS.has(r.event) || r.branch !== defaultBranch.get(r.repo)) continue;
    const key = `${forge}:${r.repo}:${r.workflowId}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  const problems: Problem[] = [];
  for (const [key, r] of latest) {
    if (!r.conclusion || !FAILED_RUN.has(r.conclusion)) continue;
    const short = r.repo.split("/").pop() ?? r.repo;
    problems.push({
      key,
      source: "workflow",
      severity: "warning",
      subject: `${short} · ${r.workflow}`,
      title: clip(`${r.workflow} failed in ${short}`, 120),
      body: clip(`Run #${r.runNumber} on ${r.branch} (${r.event}${r.conclusion === "failure" ? "" : `, ${r.conclusion.replace(/_/g, " ")}`}): ${r.title}`, 300),
      url: "/actions",
      link: r.url,
      threshold: 1,
    });
  }
  return {
    feed: forge,
    source: "workflow",
    prefix: `${forge}:`,
    problems,
    ageOut: true,
    resolution(key) {
      const rest = key.slice(forge.length + 1);
      const repo = rest.slice(0, rest.lastIndexOf(":"));
      if (!defaultBranch.has(repo)) return "repository no longer active";
      const r = latest.get(key);
      return r?.conclusion === "success" ? `fixed by run #${r.runNumber}` : null;
    },
  };
}

export async function observeGithub(rt: Runtime): Promise<Observation | null> {
  if (!rt.env.GITHUB_TOKEN) return null;
  const list = await github.activeRepos(rt);
  const runs = await github.recentRuns(rt, 15, list.map((r) => r.name));
  return workflowObservation("github", runs, new Map(list.map((r) => [r.name, r.defaultBranch])));
}

export async function observeGitea(env: Env): Promise<Observation | null> {
  if (!env.GITEA_TOKEN) return null;
  const list = await gitea.repos(env);
  const runs = await gitea.recentRuns(env, 15, list);
  return workflowObservation("gitea", runs, new Map(list.map((r) => [r.full_name, r.default_branch])));
}

// --- Uptime Kuma ------------------------------------------------------------------

/** A certificate this close to expiring wasn't renewed when it should have been (cert-manager renews at 30 days). */
export const CERT_WARN_DAYS = 14;
export const CERT_CRITICAL_DAYS = 3;

/**
 * Kuma's monitors as Kuma reports them. Told at once: Kuma has its own retries
 * before it calls a monitor down. Group monitors are left out (their children
 * are each reported), and so are paused ones. A TLS certificate that's
 * invalid, or within CERT_WARN_DAYS of expiring, is its own incident.
 */
export function kumaObservation(monitors: LiveMonitor[]): Observation {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const link = (id: number) => `${targetById("kuma")?.link ?? "https://health.mfaherty.net"}/dashboard/${id}`;
  const problems: Problem[] = [];
  for (const m of monitors) {
    if (m.type === "group" || m.status === "paused") continue;
    if (m.status === "down") {
      problems.push({
        key: `kuma:${m.id}`,
        source: "kuma",
        severity: "critical",
        subject: m.name,
        title: clip(`${m.name} is down`, 120),
        body: clip([m.msg, m.target].filter(Boolean).join(" · ") || "Down in Uptime Kuma.", 300),
        url: "/uptime",
        link: link(m.id),
        threshold: 1,
      });
    }
    const c = m.cert;
    if (!c) continue;
    const days = c.daysRemaining;
    if (!c.valid || (days !== null && days <= CERT_WARN_DAYS)) {
      problems.push({
        key: `kuma:${m.id}:cert`,
        source: "kuma",
        severity: !c.valid || (days !== null && days <= CERT_CRITICAL_DAYS) ? "critical" : "warning",
        subject: `${m.name}'s certificate`,
        title: clip(!c.valid ? `Certificate invalid: ${m.name}` : `Certificate for ${m.name} expires in ${days} day${days === 1 ? "" : "s"}`, 120),
        body: clip([m.target, c.validTo ? `valid to ${c.validTo.slice(0, 10)}` : null].filter(Boolean).join(" · ") || "From Uptime Kuma's TLS check.", 300),
        url: "/uptime",
        link: link(m.id),
        threshold: 1,
      });
    }
  }
  return {
    feed: "kuma",
    source: "kuma",
    prefix: "",
    problems,
    resolution(key) {
      const match = /^kuma:(\d+)(:cert)?$/.exec(key);
      if (!match) return null;
      const m = byId.get(Number(match[1]));
      if (!m || m.type === "group") return "no longer monitored";
      if (m.status === "paused") return "paused in Uptime Kuma";
      if (match[2]) {
        const c = m.cert;
        if (!c) return null;
        return c.valid && (c.daysRemaining === null || c.daysRemaining > CERT_WARN_DAYS) ? `renewed${c.daysRemaining !== null ? ` (${c.daysRemaining} days left)` : ""}` : null;
      }
      if (m.status === "up") return "back up";
      if (m.status === "maintenance") return "in maintenance";
      return null; // pending (retrying) or unknown: not over yet
    },
  };
}

/** Through the KumaLive Durable Object, which reuses a tab's open connection or opens one briefly. */
export async function observeKuma(env: Env): Promise<Observation | null> {
  if (!env.KUMA_TOKEN) return null;
  const res = await env.KUMA_LIVE.getByName("kuma").fetch("https://kuma/snapshot");
  const body = (await res.json().catch(() => null)) as Snapshot | null;
  if (!body || !("monitors" in body)) throw new UpstreamError(body && "error" in body ? body.error : `Uptime Kuma snapshot: HTTP ${res.status}`);
  return kumaObservation(body.monitors);
}

// --- Proxmox guests ---------------------------------------------------------------------

export interface GuestState {
  host: { id: string; name: string; link: string | null; error: string | null };
  guests: { node: string; vmid: number; type: "qemu" | "lxc"; name: string; status: string; startsAtBoot: boolean | null }[];
}

/** Two runs: a reboot passes through "stopped". */
export const GUEST_THRESHOLD = 2;

/**
 * A guest set to start at boot that isn't running: it crashed, was killed,
 * or was stopped and left that way. One that isn't set to start at boot is
 * off on purpose. `startsAtBoot` is only read for guests that aren't running.
 */
export function guestObservation(hosts: GuestState[]): Observation {
  const byKey = new Map<string, { host: GuestState["host"]; guest: GuestState["guests"][number] }>();
  for (const h of hosts) for (const g of h.guests) byKey.set(`pve:${h.host.id}:${g.vmid}`, { host: h.host, guest: g });
  const failed = hosts.filter((h) => h.host.error);
  const problems: Problem[] = [];
  for (const [key, { host, guest: g }] of byKey) {
    if (g.status === "running" || g.startsAtBoot !== true) continue;
    problems.push({
      key,
      source: "proxmox",
      severity: "warning",
      subject: `${g.name} (#${g.vmid})`,
      title: clip(`${g.name} isn't running`, 120),
      body: `${g.type === "qemu" ? "VM" : "Container"} ${g.vmid} on ${host.name} is ${g.status}, and it's set to start at boot.`,
      url: "/proxmox",
      link: host.link,
      threshold: GUEST_THRESHOLD,
    });
  }
  return {
    feed: "proxmox",
    source: "proxmox",
    prefix: "pve:",
    problems,
    partial: failed.length ? failed.map((h) => `${h.host.id}: ${h.host.error}`).join("; ").slice(0, 300) : null,
    resolution(key) {
      const hostId = key.split(":")[1];
      const host = hosts.find((h) => h.host.id === hostId);
      if (!host) return "no longer monitored";
      if (host.host.error) return null;
      const g = byKey.get(key)?.guest;
      if (!g) return `no longer on ${host.host.name}`;
      if (g.status === "running") return "running again";
      return g.startsAtBoot === false ? "no longer set to start at boot" : null;
    },
  };
}

export async function observeGuests(env: Env): Promise<Observation | null> {
  if (!env.PVE_TOKENS) return null;
  const hosts = await pve.overview(env);
  const states = await Promise.all(
    hosts.map(async (h): Promise<GuestState> => ({
      host: { id: h.id, name: h.name, link: h.link, error: h.error },
      guests: await Promise.all(
        h.guests.map(async (g) => ({
          node: g.node,
          vmid: g.vmid,
          type: g.type,
          name: g.name,
          status: g.status,
          // Only asked of a guest that isn't running; a failed read is "can't say", not "no".
          startsAtBoot: g.status === "running" ? null : await pve.guestStartsAtBoot(env, h.id, g.node, g.type, g.vmid).catch(() => null),
        })),
      ),
    })),
  );
  return guestObservation(states);
}

// --- Proxmox backups --------------------------------------------------------------------

const BACKUP_OK = (status: string) => status === "OK" || /^WARNINGS?:/i.test(status);

/** A node whose latest backup run failed. Fixed when a later run succeeds. */
export function backupObservation(hosts: pve.HostBackups[]): Observation {
  const latest = new Map<string, { host: pve.HostBackups; run: { status: string; startedAt: number } | null }>();
  for (const h of hosts) for (const n of h.nodes) latest.set(`backup:${h.id}:${n.node}`, { host: h, run: n.latest });
  const problems: Problem[] = [];
  for (const [key, { host, run }] of latest) {
    if (!run || BACKUP_OK(run.status)) continue;
    problems.push({
      key,
      source: "proxmox",
      severity: "warning",
      subject: `Backups on ${host.name}`,
      title: `Backup failed on ${host.name}`,
      body: clip(`The latest backup run (started ${new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC) ended with: ${run.status}`, 300),
      url: "/proxmox",
      link: host.link,
      threshold: 1,
    });
  }
  const failed = hosts.filter((h) => h.error);
  return {
    feed: "backup",
    source: "proxmox",
    prefix: "backup:",
    problems,
    partial: failed.length ? failed.map((h) => `${h.id}: ${h.error}`).join("; ").slice(0, 300) : null,
    resolution(key) {
      const host = hosts.find((h) => h.id === key.split(":")[1]);
      if (!host) return "no longer monitored";
      if (host.error) return null;
      const entry = latest.get(key);
      if (!entry) return "node no longer there";
      return entry.run && BACKUP_OK(entry.run.status) ? "the next backup run succeeded" : null;
    },
  };
}

export async function observeBackups(env: Env): Promise<Observation | null> {
  if (!env.PVE_TOKENS) return null;
  return backupObservation(await pve.latestBackups(env));
}

// --- UniFi ------------------------------------------------------------------------------

const DEVICE_DOWN = new Set(["offline", "heartbeat missed", "isolated", "adoption failed"]);
export const UNIFI_THRESHOLD = 2;

/**
 * From the UDM's own API: an adopted gateway, switch or access point that has
 * dropped off, and the WAN or internet subsystem reporting trouble. A device
 * upgrading or provisioning is neither down nor back yet.
 */
export function unifiObservation(devices: unifi.Device[], health: unifi.Health): Observation {
  const byMac = new Map(devices.map((d) => [d.mac, d]));
  const sub = new Map(health.subsystems.map((x) => [x.name, x.status]));
  const problems: Problem[] = [];
  for (const d of devices) {
    if (!DEVICE_DOWN.has(d.state)) continue;
    problems.push({
      key: `unifi:${d.mac}`,
      source: "network",
      severity: d.kind === "ap" || d.kind === "other" ? "warning" : "critical",
      subject: d.name,
      title: clip(`${d.name} is ${d.state}`, 120),
      body: clip([d.model, d.ip ?? d.mac].filter(Boolean).join(" · "), 300),
      url: "/unifi",
      link: targetById("unifi")?.link ?? null,
      threshold: UNIFI_THRESHOLD,
    });
  }
  const wan = sub.get("wan");
  if (wan === "error" || wan === "warning") {
    problems.push({
      key: "unifi:wan",
      source: "network",
      severity: wan === "error" ? "critical" : "warning",
      subject: "The WAN",
      title: wan === "error" ? "WAN is down" : "WAN is degraded",
      body: clip([health.wan.isp, health.wan.availability !== null ? `${health.wan.availability.toFixed(1)}% available` : null].filter(Boolean).join(" · ") || "As the UniFi gateway reports it.", 300),
      url: "/unifi",
      link: targetById("unifi")?.link ?? null,
      threshold: UNIFI_THRESHOLD,
    });
  }
  const www = sub.get("www");
  if (www === "error" || www === "warning") {
    problems.push({
      key: "unifi:www",
      source: "network",
      severity: www === "error" ? "critical" : "warning",
      subject: "The internet",
      title: www === "error" ? "Internet is unreachable" : "Internet is degraded",
      body: clip([health.internet.latencyMs !== null ? `${health.internet.latencyMs} ms latency` : null, health.internet.drops !== null ? `${health.internet.drops} drops` : null].filter(Boolean).join(" · ") || "As the UniFi gateway reports it.", 300),
      url: "/unifi",
      link: targetById("unifi")?.link ?? null,
      threshold: UNIFI_THRESHOLD,
    });
  }
  return {
    feed: "unifi",
    source: "network",
    prefix: "unifi:",
    problems,
    resolution(key) {
      if (key === "unifi:wan" || key === "unifi:www") return sub.get(key.slice(6)) === "ok" ? "back to normal" : null;
      const d = byMac.get(key.slice(6));
      if (!d) return "no longer adopted";
      return d.online ? "back online" : null;
    },
  };
}

export async function observeUnifi(env: Env): Promise<Observation | null> {
  if (!env.UNIFI_API_KEY) return null;
  const [devices, health] = await Promise.all([unifi.network<Record<string, unknown>>(env, "stat/device"), unifi.network<Record<string, unknown>>(env, "stat/health")]);
  return unifiObservation(unifi.parseDevices(devices), unifi.parseHealth(health));
}

// --- Pi-hole ----------------------------------------------------------------------------

/** Read every ten minutes, so two reads is ten to twenty minutes off: past a "disable for 5 minutes". */
export const PIHOLE_THRESHOLD = 2;

export function piholeObservation(hosts: pihole.PiHole[]): Observation {
  const byHost = new Map(hosts.map((h) => [h.host, h]));
  const failed = hosts.filter((h) => h.error);
  return {
    feed: "pihole",
    source: "dns",
    prefix: "",
    problems: hosts
      .filter((h) => h.enabled === false)
      .map((h) => ({
        key: `dns:${h.host}`,
        source: "dns" as const,
        severity: "warning" as const,
        subject: `Pi-hole ${h.host}`,
        title: `Pi-hole ${h.host} isn't blocking`,
        body: "Ad and tracker blocking is switched off.",
        url: "/dns",
        link: h.link,
        threshold: PIHOLE_THRESHOLD,
      })),
    partial: failed.length ? failed.map((h) => `${h.host}: ${h.error}`).join("; ").slice(0, 300) : null,
    resolution(key) {
      const h = byHost.get(key.slice(4));
      if (!h) return "no longer monitored";
      return h.enabled === true ? "blocking again" : null;
    },
  };
}

export async function observePihole(env: Env): Promise<Observation | null> {
  if (!env.PIHOLE_PASSWORDS) return null;
  return piholeObservation((await pihole.overview(env)).hosts);
}
