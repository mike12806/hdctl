import type { Env } from "../env";
import { TARGETS, targetFetch, type Target } from "../targets";
import { NotConfigured, UpstreamError } from "../errors";

/**
 * The Pi-holes, each read from its own v6 API (FTL's REST API), live on every
 * request. Not pihole-exporter: hdctl reads a system's numbers from that
 * system.
 *
 * Every read is one session: log in with the host's app password (an app
 * password skips TOTP, which the Pi-holes have on), read the summary and the
 * blocking state, log out. Logging out matters: FTL has a fixed number of API
 * seats (16 on the k8s Pi-holes), and an abandoned session holds one until it
 * times out. Hosts are read in parallel; one that fails shows its error and
 * no numbers, and the others still render.
 */

export const PIHOLES: readonly Target[] = TARGETS.filter((t) => t.group === "dns");
const TIMEOUT_MS = 10_000;

export interface PiHole {
  /** The hdctl target id (dns7, k8s-dns2, ...). */
  host: string;
  link: string | null;
  /** Why this Pi-hole has no numbers. Never set together with any of them. */
  error: string | null;
  /** Whether it is blocking; null if it says neither enabled nor disabled. */
  enabled: boolean | null;
  /** FTL's summary covers the queries it holds in memory: the last 24 hours. */
  queriesToday: number | null;
  blockedToday: number | null;
  blockedPercent: number | null;
  /** Clients seen in the last 24 hours. */
  clients: number | null;
}

export interface DnsOverview {
  asOf: number;
  hosts: PiHole[];
}

/** PIHOLE_PASSWORDS is JSON keyed by target id: {"dns7": "<app password>"}. */
function passwords(env: Env): Record<string, string> {
  if (!env.PIHOLE_PASSWORDS) throw new NotConfigured("PIHOLE_PASSWORDS is not set; the deploy workflow builds it from Vault kv/github/hdctl/pihole.");
  try {
    return JSON.parse(env.PIHOLE_PASSWORDS) as Record<string, string>;
  } catch {
    throw new NotConfigured("PIHOLE_PASSWORDS is not valid JSON.");
  }
}

/** FTL's error body: {"error": {"key", "message", "hint"}}. */
async function ftlError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const e = (JSON.parse(text) as { error?: { message?: string; hint?: string | null } }).error;
    if (e?.message) return `HTTP ${res.status} ${e.message}${e.hint ? ` (${e.hint})` : ""}`;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status} ${text.slice(0, 200)}`.trim();
}

interface Session {
  valid?: boolean;
  sid?: string | null;
  message?: string | null;
}

/** POST /api/auth. Returns the session id, or null if this Pi-hole has no password set. */
async function login(env: Env, t: Target, password: string): Promise<string | null> {
  const res = await targetFetch(
    env,
    t,
    "/api/auth",
    { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ password }) },
    TIMEOUT_MS,
  );
  // A wrong password is 401 with a session body; seats exhausted is 429 with an error body.
  const body = res.status === 401 || res.ok ? ((await res.json().catch(() => null)) as { session?: Session } | null) : null;
  const session = body?.session;
  if (!res.ok || !session?.valid) {
    const why = session ? (session.message ?? "password refused") : await ftlError(res);
    throw new UpstreamError(`login refused: ${why}`);
  }
  return session.sid ?? null;
}

/** DELETE /api/auth. Failure is logged, not shown: the numbers already read are still current. */
async function logout(env: Env, t: Target, sid: string): Promise<void> {
  try {
    const res = await targetFetch(env, t, "/api/auth", { method: "DELETE", headers: { "X-FTL-SID": sid } }, TIMEOUT_MS);
    if (res.status !== 204 && !res.ok) throw new Error(await ftlError(res));
  } catch (err) {
    console.error(JSON.stringify({ msg: "pihole logout failed; the session holds an API seat until it times out", host: t.id, error: err instanceof Error ? err.message : String(err) }));
  }
}

async function get<T>(env: Env, t: Target, sid: string | null, path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (sid) headers["X-FTL-SID"] = sid;
  const res = await targetFetch(env, t, path, { headers }, TIMEOUT_MS);
  if (!res.ok) throw new UpstreamError(`GET ${path}: ${await ftlError(res)}`);
  return (await res.json()) as T;
}

interface Summary {
  queries?: { total?: number; blocked?: number; percent_blocked?: number };
  clients?: { active?: number; total?: number };
}

interface Blocking {
  blocking?: "enabled" | "disabled" | "failed" | "unknown" | string;
}

const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One Pi-hole, one session. */
export async function readPiHole(env: Env, t: Target, password: string): Promise<Omit<PiHole, "host" | "link" | "error">> {
  const sid = await login(env, t, password);
  try {
    const [summary, blocking] = await Promise.all([get<Summary>(env, t, sid, "/api/stats/summary"), get<Blocking>(env, t, sid, "/api/dns/blocking")]);
    return {
      enabled: blocking.blocking === "enabled" ? true : blocking.blocking === "disabled" ? false : null,
      queriesToday: finite(summary.queries?.total),
      blockedToday: finite(summary.queries?.blocked),
      blockedPercent: finite(summary.queries?.percent_blocked),
      clients: finite(summary.clients?.active),
    };
  } finally {
    if (sid) await logout(env, t, sid);
  }
}

const NO_NUMBERS = { enabled: null, queriesToday: null, blockedToday: null, blockedPercent: null, clients: null } as const;

export async function overview(env: Env): Promise<DnsOverview> {
  const pw = passwords(env);
  const hosts = await Promise.all(
    PIHOLES.map(async (t): Promise<PiHole> => {
      const base = { host: t.id, link: t.link ?? null };
      const password = pw[t.id];
      if (!password) return { ...base, error: `No app password for ${t.id} in PIHOLE_PASSWORDS.`, ...NO_NUMBERS };
      try {
        return { ...base, error: null, ...(await readPiHole(env, t, password)) };
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err), ...NO_NUMBERS };
      }
    }),
  );
  return { asOf: Date.now(), hosts };
}
