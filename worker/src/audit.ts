import type { Env, Identity } from "./env";

/**
 * Run an action against another system with an audit trail in D1: a
 * 'started' row first, then 'ok' or 'error' with the outcome. If the
 * Worker dies part-way, the 'started' row is still there.
 */
export async function audited<T>(
  env: Env,
  who: Identity,
  action: string,
  target: string,
  params: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const row = await env.DB.prepare(
    "INSERT INTO audit_log (at, actor, action, target, params, status) VALUES (?1, ?2, ?3, ?4, ?5, 'started') RETURNING id",
  )
    .bind(Date.now(), who.email, action, target, params === undefined ? null : JSON.stringify(params))
    .first<{ id: number }>();
  const id = row?.id;

  const finish = (status: "ok" | "error", result: unknown) =>
    env.DB.prepare("UPDATE audit_log SET status = ?1, result = ?2, finished_at = ?3 WHERE id = ?4")
      .bind(status, typeof result === "string" ? result : JSON.stringify(result ?? null), Date.now(), id)
      .run();

  try {
    const out = await run();
    await finish("ok", out);
    return out;
  } catch (err) {
    await finish("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function recentAudit(env: Env, limit = 200) {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1").bind(limit).all();
  return results;
}
