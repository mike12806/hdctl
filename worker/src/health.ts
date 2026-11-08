import type { Env } from "./env";
import { GROUP_LABELS, TARGETS, targetFetch, type Target } from "./targets";

export type State = "up" | "degraded" | "down";

export interface CheckResult {
  targetId: string;
  at: number;
  state: State;
  code: number | null;
  latencyMs: number | null;
  detail: string | null;
}

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_MS = 2 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 8_000;

/** Vault's /v1/sys/health status codes, which say more than up or down. */
const VAULT_CODES: Record<number, [State, string]> = {
  200: ["up", "active"],
  429: ["up", "standby"],
  472: ["degraded", "DR secondary"],
  473: ["up", "performance standby"],
  501: ["down", "not initialised"],
  503: ["down", "sealed"],
};

/** Turn one probe's outcome into a state. Pure, so it is unit-tested. */
export function classify(target: Target, outcome: { code: number } | { error: string }, latencyMs: number): Omit<CheckResult, "targetId" | "at"> {
  if ("error" in outcome) {
    return { state: "down", code: null, latencyMs: null, detail: outcome.error };
  }
  const { code } = outcome;
  if (target.kind === "vault" && VAULT_CODES[code]) {
    const [state, detail] = VAULT_CODES[code];
    return { state, code, latencyMs, detail };
  }
  if (target.check.expect.includes(code)) {
    // Reachable and answering as expected, but slow enough to notice.
    return latencyMs > 3_000
      ? { state: "degraded", code, latencyMs, detail: `slow (${latencyMs} ms)` }
      : { state: "up", code, latencyMs, detail: null };
  }
  const state: State = code >= 500 ? "down" : "degraded";
  return { state, code, latencyMs, detail: `HTTP ${code}, expected ${target.check.expect.join("/")}` };
}

async function probe(env: Env, target: Target): Promise<CheckResult> {
  const at = Date.now();
  const started = performance.now();
  try {
    const res = await targetFetch(env, target, target.check.path, { method: "GET" }, CHECK_TIMEOUT_MS);
    // Drain the body so the connection is released; the contents don't matter.
    await res.body?.cancel();
    return { targetId: target.id, at, ...classify(target, { code: res.status }, Math.round(performance.now() - started)) };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "TimeoutError" ? `no answer in ${CHECK_TIMEOUT_MS / 1000}s` : err.message) : String(err);
    return { targetId: target.id, at, ...classify(target, { error: msg.slice(0, 300) }, 0) };
  }
}

const UPSERT_STATE = `
INSERT INTO target_state (target_id, state, since, checked_at, code, latency_ms, detail)
VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
ON CONFLICT (target_id) DO UPDATE SET
  since      = CASE WHEN target_state.state = excluded.state THEN target_state.since ELSE excluded.since END,
  state      = excluded.state,
  checked_at = excluded.checked_at,
  code       = excluded.code,
  latency_ms = excluded.latency_ms,
  detail     = excluded.detail`;

/** Probe every target (or the given ones) in parallel and record the results in one D1 batch. */
export async function runChecks(env: Env, targets: readonly Target[] = TARGETS): Promise<CheckResult[]> {
  const results = await Promise.all(targets.map((t) => probe(env, t)));
  const stmts = results.flatMap((r) => [
    env.DB.prepare("INSERT INTO checks (target_id, at, state, code, latency_ms, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(
      r.targetId, r.at, r.state, r.code, r.latencyMs, r.detail,
    ),
    env.DB.prepare(UPSERT_STATE).bind(r.targetId, r.state, r.at, r.code, r.latencyMs, r.detail),
  ]);
  await env.DB.batch(stmts);
  return results;
}

export async function pruneChecks(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM checks WHERE at < ?1").bind(Date.now() - RETENTION_MS).run();
}

interface StateRow { target_id: string; state: State; since: number; checked_at: number; code: number | null; latency_ms: number | null; detail: string | null }
interface UptimeRow { target_id: string; n: number; ok: number }
interface HistoryRow { target_id: string; at: number; state: State }

/** Everything the Status page shows, in one D1 round trip. */
export async function statusSummary(env: Env) {
  const now = Date.now();
  const [states, uptime, history] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM target_state"),
    env.DB.prepare("SELECT target_id, COUNT(*) AS n, SUM(state != 'down') AS ok FROM checks WHERE at > ?1 GROUP BY target_id").bind(now - 24 * 3600_000),
    env.DB.prepare("SELECT target_id, at, state FROM checks WHERE at > ?1 ORDER BY at").bind(now - HISTORY_MS),
  ]) as [D1Result<StateRow>, D1Result<UptimeRow>, D1Result<HistoryRow>];

  const stateBy = new Map(states.results.map((r) => [r.target_id, r]));
  const uptimeBy = new Map(uptime.results.map((r) => [r.target_id, r]));
  const historyBy = new Map<string, { at: number; state: State }[]>();
  for (const r of history.results) {
    const list = historyBy.get(r.target_id) ?? [];
    list.push({ at: r.at, state: r.state });
    historyBy.set(r.target_id, list);
  }

  return {
    generatedAt: now,
    groups: GROUP_LABELS,
    targets: TARGETS.map((t) => {
      const s = stateBy.get(t.id);
      const u = uptimeBy.get(t.id);
      return {
        id: t.id,
        name: t.name,
        group: t.group,
        link: t.link ?? null,
        endpoint: `${t.address.ipv4 ?? t.address.hostname}:${t.port}`,
        state: s?.state ?? null,
        since: s?.since ?? null,
        checkedAt: s?.checked_at ?? null,
        code: s?.code ?? null,
        latencyMs: s?.latency_ms ?? null,
        detail: s?.detail ?? null,
        uptime24h: u && u.n > 0 ? u.ok / u.n : null,
        history: historyBy.get(t.id) ?? [],
      };
    }),
  };
}
