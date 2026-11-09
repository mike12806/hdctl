import type { Env } from "../env";
import { targetById, targetFetch } from "../targets";
import { NotConfigured, UpstreamError } from "../errors";

/**
 * Uptime Kuma, read from Kuma itself: its /metrics endpoint, through the
 * hdctl-kuma VPC Service, on every request. That's Kuma's own read-only
 * interface (an API key, sent as Basic auth with an empty username). It
 * isn't read from Prometheus or any other copy.
 *
 * Kuma's fuller API is Socket.IO, which needs an admin username and password
 * and a long-lived connection; /metrics needs neither and carries what this
 * page shows: each monitor's status, response time and certificate expiry.
 */

const KUMA = targetById("kuma")!;

export type MonitorStatus = "up" | "down" | "pending" | "maintenance" | "unknown";

export interface KumaMonitor {
  name: string;
  type: string | null;
  /** What it checks: the URL, or host[:port]. */
  target: string | null;
  status: MonitorStatus;
  responseTimeMs: number | null;
  certDaysRemaining: number | null;
  certValid: boolean | null;
}

export interface KumaOverview {
  asOf: number;
  counts: Record<MonitorStatus, number>;
  monitors: KumaMonitor[];
}

/** monitor_status values, as Kuma defines them. */
const STATUS: Record<number, MonitorStatus> = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };

// The labels that identify a monitor. Kuma adds others (its tags) as extra
// labels; those don't split one monitor into several.
const IDENTITY = ["monitor_id", "monitor_name", "monitor_type", "monitor_url", "monitor_hostname", "monitor_port"];

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parse one `{a="1",b="x\"y"}` label set, honouring the format's escapes. */
function parseLabels(s: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (s[i] === "," || s[i] === " ") i++;
    if (i >= s.length) break;
    const eq = s.indexOf("=", i);
    if (eq < 0 || s[eq + 1] !== '"') throw new Error(`bad label set: ${s.slice(0, 80)}`);
    const key = s.slice(i, eq).trim();
    let value = "";
    let j = eq + 2;
    for (; j < s.length && s[j] !== '"'; j++) {
      if (s[j] === "\\" && j + 1 < s.length) {
        j++;
        value += s[j] === "n" ? "\n" : s[j];
      } else value += s[j];
    }
    if (j >= s.length) throw new Error(`unterminated label value: ${s.slice(0, 80)}`);
    labels[key] = value;
    i = j + 1;
  }
  return labels;
}

/** The Prometheus text exposition format, only as much of it as Kuma emits. */
export function parseExposition(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    const brace = line.indexOf("{");
    const space = line.indexOf(" ");
    if (brace >= 0 && (space < 0 || brace < space)) {
      name = line.slice(0, brace);
      // The closing brace is the last one: values never contain braces, label values can.
      const close = line.lastIndexOf("}");
      labels = parseLabels(line.slice(brace + 1, close));
      rest = line.slice(close + 1).trim();
    } else {
      name = line.slice(0, space);
      rest = line.slice(space + 1).trim();
    }
    const value = Number(rest.split(/\s+/)[0]);
    out.push({ name, labels, value });
  }
  return out;
}

/** Kuma writes "null" for a label a monitor type doesn't have. */
const present = (v: string | undefined) => (v && v !== "null" ? v : null);
const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : null);

export function parseMonitors(text: string): KumaMonitor[] {
  const byKey = new Map<string, { labels: Record<string, string>; values: Record<string, number> }>();
  for (const s of parseExposition(text)) {
    if (!s.name.startsWith("monitor_") || s.labels.monitor_name === undefined) continue;
    const key = IDENTITY.map((k) => s.labels[k] ?? "").join("\u0000");
    const m = byKey.get(key) ?? { labels: s.labels, values: {} };
    m.values[s.name] = s.value;
    byKey.set(key, m);
  }
  const rank: Record<MonitorStatus, number> = { down: 0, pending: 1, unknown: 2, maintenance: 3, up: 4 };
  return [...byKey.values()]
    .map(({ labels, values }): KumaMonitor => {
      const url = present(labels.monitor_url);
      const host = present(labels.monitor_hostname);
      const port = present(labels.monitor_port);
      const rt = finite(values.monitor_response_time);
      const cert = finite(values.monitor_cert_is_valid);
      return {
        name: labels.monitor_name ?? "",
        type: present(labels.monitor_type),
        target: url ?? (host ? (port ? `${host}:${port}` : host) : null),
        status: STATUS[values.monitor_status ?? -1] ?? "unknown",
        // Kuma reports -1 before a monitor's first response.
        responseTimeMs: rt !== null && rt >= 0 ? rt : null,
        certDaysRemaining: finite(values.monitor_cert_days_remaining),
        certValid: cert === null ? null : cert === 1,
      };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

export async function overview(env: Env): Promise<KumaOverview> {
  if (!env.KUMA_API_KEY) {
    throw new NotConfigured("KUMA_API_KEY is not set. Create an API key in Uptime Kuma (Settings › API Keys) and store it at Vault kv/github/hdctl/kuma (see docs/operations.md).");
  }
  const res = await targetFetch(env, KUMA, "/metrics", {
    headers: { Authorization: `Basic ${btoa(`:${env.KUMA_API_KEY}`)}`, Accept: "text/plain" },
  });
  if (res.status === 401 || res.status === 403) throw new UpstreamError(`Uptime Kuma refused the API key (HTTP ${res.status}). It may be expired or deactivated.`);
  if (!res.ok) throw new UpstreamError(`Uptime Kuma GET /metrics -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const monitors = parseMonitors(await res.text());
  const counts: Record<MonitorStatus, number> = { up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0 };
  for (const m of monitors) counts[m.status]++;
  return { asOf: Date.now(), counts, monitors };
}
