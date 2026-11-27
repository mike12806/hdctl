import type { Env, Identity } from "../env";
import { BadRequest, NotFound } from "../errors";
import { SEVERITY_RANK, type Observation, type Severity, type Source } from "./types";

/**
 * Incidents: hdctl's record of what it decided was wrong and what it told
 * whom. Each evaluation (the cron, every two minutes) applies one
 * Observation per feed, and every transition that should reach a phone is
 * returned as an event for deliver.ts.
 *
 *   pending   seen, but not for `threshold` consecutive evaluations yet
 *   open      notified (event "open"); a later rise in severity is pushed
 *             again ("escalate"), unless someone acknowledged it
 *   resolved  its feed says it's over (event "resolve", unless it was still
 *             pending: a flap that cleared before its threshold is deleted,
 *             since nobody was ever told about it)
 *
 * **Every transition is claimed by the statement that makes it.** At most one
 * row per key is open (a partial unique index), the open/escalate/resolve
 * UPDATEs only match a row still in the state they move it out of, and only a
 * statement that changed a row returns it. Two overlapping cron runs can both
 * decide the same thing; only one of them sends anything.
 */

export interface IncidentRow {
  id: number;
  key: string;
  source: Source;
  severity: Severity;
  subject: string;
  title: string;
  body: string;
  url: string;
  link: string | null;
  first_seen_at: number;
  last_seen_at: number;
  seen: number;
  notified_at: number | null;
  notified_severity: Severity | null;
  announced: number;
  acked_at: number | null;
  acked_by: string | null;
  resolved_at: number | null;
  resolution: string | null;
}

export type EventKind = "open" | "escalate" | "resolve";

export interface NotifyEvent {
  kind: EventKind;
  incident: IncidentRow;
}

/** An open incident its feed hasn't mentioned for this long is closed as no longer reported (see Observation.ageOut). */
export const STALE_MS = 3 * 24 * 3600_000;
/** Resolved incidents stay in the record this long. */
export const RETENTION_MS = 30 * 24 * 3600_000;
/** The page's "recent" list. */
const RECENT_MS = 7 * 24 * 3600_000;

const INSERT = `
INSERT INTO incidents (key, source, severity, subject, title, body, url, link, first_seen_at, last_seen_at, seen, notified_at, notified_severity)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1, ?10, ?11)
ON CONFLICT (key) WHERE resolved_at IS NULL DO NOTHING
RETURNING *`;

const SEEN_AGAIN = `
UPDATE incidents SET seen = seen + 1, last_seen_at = ?2, severity = ?3, subject = ?4, title = ?5, body = ?6, url = ?7, link = ?8
WHERE id = ?1 AND resolved_at IS NULL
RETURNING *`;

/** Apply one feed's observation. Returns what should be pushed. */
export async function applyObservation(env: Env, obs: Observation, now: number): Promise<NotifyEvent[]> {
  const { results: open } = await env.DB.prepare(
    "SELECT * FROM incidents WHERE source = ?1 AND resolved_at IS NULL AND substr(key, 1, length(?2)) = ?2",
  )
    .bind(obs.source, obs.prefix)
    .all<IncidentRow>();
  const openByKey = new Map(open.map((i) => [i.key, i]));
  const events: NotifyEvent[] = [];

  for (const p of obs.problems) {
    if (!openByKey.has(p.key)) {
      const now1 = p.threshold <= 1;
      const row = await env.DB.prepare(INSERT)
        .bind(p.key, p.source, p.severity, p.subject, p.title, p.body, p.url, p.link, now, now1 ? now : null, now1 ? p.severity : null)
        .first<IncidentRow>();
      if (row && row.notified_at !== null) events.push({ kind: "open", incident: row });
      continue;
    }
    const row = await env.DB.prepare(SEEN_AGAIN).bind(openByKey.get(p.key)!.id, now, p.severity, p.subject, p.title, p.body, p.url, p.link).first<IncidentRow>();
    if (!row) continue; // resolved by an overlapping run in the meantime
    if (row.notified_at === null) {
      if (row.seen < p.threshold) continue;
      const claimed = await env.DB.prepare("UPDATE incidents SET notified_at = ?2, notified_severity = severity WHERE id = ?1 AND notified_at IS NULL RETURNING *")
        .bind(row.id, now)
        .first<IncidentRow>();
      if (claimed) events.push({ kind: "open", incident: claimed });
    } else if (row.acked_at === null && SEVERITY_RANK[row.severity] > SEVERITY_RANK[row.notified_severity ?? row.severity]) {
      const claimed = await env.DB.prepare("UPDATE incidents SET notified_severity = severity WHERE id = ?1 AND notified_severity = ?2 RETURNING *")
        .bind(row.id, row.notified_severity)
        .first<IncidentRow>();
      if (claimed) events.push({ kind: "escalate", incident: claimed });
    }
  }

  const problemKeys = new Set(obs.problems.map((p) => p.key));
  for (const inc of open) {
    if (problemKeys.has(inc.key)) continue;
    const resolution = obs.resolution(inc.key) ?? (obs.ageOut && now - inc.last_seen_at > STALE_MS ? "no longer reported" : null);
    if (resolution === null) continue;
    if (inc.notified_at === null) {
      await env.DB.prepare("DELETE FROM incidents WHERE id = ?1 AND notified_at IS NULL AND resolved_at IS NULL").bind(inc.id).run();
      continue;
    }
    const row = await env.DB.prepare("UPDATE incidents SET resolved_at = ?2, resolution = ?3 WHERE id = ?1 AND resolved_at IS NULL RETURNING *")
      .bind(inc.id, now, resolution)
      .first<IncidentRow>();
    if (row) events.push({ kind: "resolve", incident: row });
  }
  return events;
}

/** Note how a feed's evaluation went: when it last ran, last succeeded, and why it failed. */
export async function recordFeed(env: Env, feed: string, now: number, outcome: { error: string | null } | "skipped"): Promise<void> {
  if (outcome === "skipped") {
    await env.DB.prepare("DELETE FROM notify_sources WHERE feed = ?1").bind(feed).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO notify_sources (feed, checked_at, ok_at, error) VALUES (?1, ?2, CASE WHEN ?3 IS NULL THEN ?2 END, ?3)
     ON CONFLICT (feed) DO UPDATE SET checked_at = excluded.checked_at, ok_at = COALESCE(excluded.ok_at, notify_sources.ok_at), error = excluded.error`,
  )
    .bind(feed, now, outcome.error)
    .run();
}

/** Open, notified, unacknowledged incidents: the badge on the tab and the app icon. */
export async function openCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL AND notified_at IS NOT NULL AND acked_at IS NULL").first<{ n: number }>();
  return row?.n ?? 0;
}

// --- Mutes -------------------------------------------------------------------------

export interface MuteRow {
  id: number;
  key: string;
  label: string;
  until: number;
  actor: string;
  created_at: number;
}

/** Mutes in force now. '*' is "pause everything". */
export async function activeMutes(env: Env, now: number): Promise<MuteRow[]> {
  return (await env.DB.prepare("SELECT * FROM notify_mutes WHERE until > ?1 ORDER BY until").bind(now).all<MuteRow>()).results;
}

export const isMuted = (mutes: MuteRow[], key: string) => mutes.some((m) => m.key === "*" || m.key === key);

/** 5 minutes to a week: a mute that outlives the problem by months is a notification nobody gets. */
export function parseMinutes(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 5 || n > 7 * 24 * 60) throw new BadRequest("minutes must be a whole number from 5 to 10080");
  return n;
}

async function mute(env: Env, who: Identity, key: string, label: string, minutes: number, now: number): Promise<MuteRow> {
  return (await env.DB.prepare(
    `INSERT INTO notify_mutes (key, label, until, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (key) DO UPDATE SET label = excluded.label, until = excluded.until, actor = excluded.actor, created_at = excluded.created_at
     RETURNING *`,
  )
    .bind(key, label, now + minutes * 60_000, who.email, now)
    .first<MuteRow>())!;
}

export function parseId(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequest("bad id");
  return n;
}

async function incident(env: Env, id: number): Promise<IncidentRow> {
  const row = await env.DB.prepare("SELECT * FROM incidents WHERE id = ?1").bind(id).first<IncidentRow>();
  if (!row) throw new NotFound("no such incident");
  return row;
}

/** Stop telling anyone about this thing (this incident's key) for a while. */
export async function muteIncident(env: Env, who: Identity, id: number, minutes: number, now = Date.now()) {
  const inc = await incident(env, id);
  return toMute(await mute(env, who, inc.key, inc.subject, minutes, now));
}

export async function pauseAll(env: Env, who: Identity, minutes: number, now = Date.now()) {
  return toMute(await mute(env, who, "*", "everything", minutes, now));
}

export async function unmute(env: Env, id: number): Promise<{ ok: true }> {
  await env.DB.prepare("DELETE FROM notify_mutes WHERE id = ?1").bind(id).run();
  return { ok: true };
}

/**
 * "I've seen it." Stops escalations, drops it from the badge, and lets every
 * other device take its notification down the next time it refreshes. Its
 * recovery is still pushed. Acknowledging twice, or something already over,
 * changes nothing.
 */
export async function ack(env: Env, who: Identity, id: number, now = Date.now()) {
  await incident(env, id);
  await env.DB.prepare("UPDATE incidents SET acked_at = ?2, acked_by = ?3 WHERE id = ?1 AND acked_at IS NULL AND resolved_at IS NULL AND notified_at IS NOT NULL")
    .bind(id, now, who.email)
    .run();
  return { incident: toIncident(await incident(env, id), []), open: await openCount(env) };
}

/** Most incidents one "Acknowledge all" covers: far more than are ever open at once. */
const ACK_MANY_MAX = 1000;

/**
 * Acknowledge all at once: the incidents the page showed, by id, never "every
 * open one now", so one raised between rendering the page and the tap isn't
 * acknowledged unseen. Ids that are no longer open, were already
 * acknowledged, or don't exist are skipped. The ids go in as one JSON
 * parameter, since D1 caps the parameters a statement may bind.
 */
export async function ackMany(env: Env, who: Identity, raw: unknown, now = Date.now()) {
  if (!Array.isArray(raw) || !raw.length || raw.length > ACK_MANY_MAX || raw.some((id) => !Number.isSafeInteger(id) || (id as number) <= 0)) {
    throw new BadRequest(`ids must be a list of 1 to ${ACK_MANY_MAX} incident ids`);
  }
  const result = await env.DB.prepare(
    `UPDATE incidents SET acked_at = ?1, acked_by = ?2
      WHERE id IN (SELECT value FROM json_each(?3))
        AND acked_at IS NULL AND resolved_at IS NULL AND notified_at IS NOT NULL`,
  )
    .bind(now, who.email, JSON.stringify([...new Set(raw as number[])]))
    .run();
  return { acked: result.meta?.changes ?? 0, open: await openCount(env) };
}

// --- The page ------------------------------------------------------------------------

function toIncident(i: IncidentRow, mutes: MuteRow[]) {
  const muted = mutes.find((m) => m.key === "*" || m.key === i.key);
  return {
    id: i.id,
    key: i.key,
    source: i.source,
    severity: i.severity,
    subject: i.subject,
    title: i.title,
    body: i.body,
    url: i.url,
    link: i.link,
    firstSeenAt: i.first_seen_at,
    lastSeenAt: i.last_seen_at,
    seen: i.seen,
    notifiedAt: i.notified_at,
    /** False for one that opened while muted: nobody was told. */
    pushed: i.announced === 1,
    ackedAt: i.acked_at,
    ackedBy: i.acked_by,
    resolvedAt: i.resolved_at,
    resolution: i.resolution,
    mutedUntil: i.resolved_at === null && muted ? muted.until : null,
  };
}

const toMute = (m: MuteRow) => ({ id: m.id, key: m.key, label: m.label, until: m.until, actor: m.actor, createdAt: m.created_at });

interface FeedRow {
  feed: string;
  checked_at: number;
  ok_at: number | null;
  error: string | null;
}

/**
 * The Notifications page: open incidents (most severe, then newest, first),
 * the ones still being watched before anyone is told, the last week's
 * resolved ones, mutes in force, and how current each feed's evaluation is.
 */
export async function feed(env: Env, now = Date.now()) {
  const [open, pending, recent, mutes, feeds] = (await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM incidents WHERE resolved_at IS NULL AND notified_at IS NOT NULL
       ORDER BY acked_at IS NOT NULL, CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_seen_at DESC`,
    ),
    env.DB.prepare("SELECT * FROM incidents WHERE resolved_at IS NULL AND notified_at IS NULL ORDER BY first_seen_at DESC"),
    env.DB.prepare("SELECT * FROM incidents WHERE resolved_at > ?1 ORDER BY resolved_at DESC LIMIT 100").bind(now - RECENT_MS),
    env.DB.prepare("SELECT * FROM notify_mutes WHERE until > ?1 ORDER BY until").bind(now),
    env.DB.prepare("SELECT * FROM notify_sources ORDER BY feed"),
  ])) as [D1Result<IncidentRow>, D1Result<IncidentRow>, D1Result<IncidentRow>, D1Result<MuteRow>, D1Result<FeedRow>];
  return {
    asOf: now,
    open: open.results.map((i) => toIncident(i, mutes.results)),
    pending: pending.results.map((i) => toIncident(i, mutes.results)),
    recent: recent.results.map((i) => toIncident(i, [])),
    mutes: mutes.results.map(toMute),
    feeds: feeds.results.map((f) => ({ feed: f.feed, checkedAt: f.checked_at, okAt: f.ok_at, error: f.error })),
  };
}

/** Run from the cron, off its critical path. */
export async function pruneNotifications(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?1").bind(now - RETENTION_MS),
    env.DB.prepare("DELETE FROM notify_mutes WHERE until <= ?1").bind(now),
    env.DB.prepare("DELETE FROM push_retries WHERE incident_id NOT IN (SELECT id FROM incidents) OR subscription_id NOT IN (SELECT id FROM push_subscriptions)"),
  ]);
}
