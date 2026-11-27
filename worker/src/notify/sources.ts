import type { Env, Runtime } from "../env";
import type { CheckResult } from "../health";
import { GROUP_LABELS, TARGETS, targetById, type Target } from "../targets";
import { alertmanagerAlerts } from "../integrations/prometheus";
import * as argo from "../integrations/argo";
import * as github from "../integrations/github";
import * as gitea from "../integrations/gitea";
import type { Observation, Problem, Severity } from "./types";

/**
 * What is wrong right now, per feed, each read from its own system of record:
 *
 *   endpoint  hdctl's own probes (the cron's, the same ones the Status page makes)
 *   alert     Alertmanager, the system of record for alerts
 *   argo      Argo CD's API: apps that are degraded or whose last sync failed
 *   github    GitHub's API: workflows whose latest run on the default branch failed
 *   gitea     Gitea's API: the same
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
