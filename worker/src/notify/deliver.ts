import type { Env } from "../env";
import { activeMutes, isMuted, openCount, type EventKind, type IncidentRow, type MuteRow, type NotifyEvent } from "./incidents";
import { sendPush, topicFor, type PushOptions, type PushOutcome, type Urgency } from "./webpush";
import { SEVERITY_RANK, type Severity, type Source } from "./types";

/**
 * Who hears about what, and what their device is told.
 *
 * Each event goes to every device whose preferences take it (its sources and
 * its minimum severity; recoveries only for what it was told about), unless
 * the key, or everything, is muted. A push service that doesn't take a
 * message for a reason worth retrying (5xx, 429, no answer) gets it again on
 * a later cron run, but only if what it says is still true by then.
 */

export interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  actor: string;
  label: string;
  sources: string;
  min_severity: Severity;
  recoveries: number;
  created_at: number;
  updated_at: number;
  last_sent_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
}

/** What the service worker receives. Shared with client/src/notifications/payload.ts. */
export interface PushPayload {
  v: 1;
  kind: EventKind | "test";
  /** The incident, so Acknowledge and Mute know what to act on. */
  id: number | null;
  /** The notification tag: one per thing, so a recovery replaces the alarm it answers. */
  tag: string;
  severity: Severity | null;
  title: string;
  body: string;
  url: string;
  /** When it happened (epoch ms), not when it was delivered. */
  at: number;
  /** Open, unacknowledged incidents, for the app icon's badge. */
  open: number;
}

/** A queued message the device never collected is dropped after this: by then the page says more. */
const TTL_SECONDS = 12 * 3600;
const RETRY_BASE_MS = 2 * 60_000;
export const MAX_ATTEMPTS = 4;
/** A retry is abandoned once the news is this old. */
const RETRY_MAX_AGE_MS = 60 * 60_000;

const URGENCY: Record<Severity, Urgency> = { critical: "high", warning: "normal", info: "low" };

export const tagFor = (key: string) => `hdctl:${key}`;

/** 75_000 -> "1 min", 7_500_000 -> "2 h 5 min". */
export function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function payloadFor(ev: NotifyEvent, open: number, now: number): PushPayload {
  const i = ev.incident;
  const base = { v: 1 as const, kind: ev.kind, id: i.id, tag: tagFor(i.key), url: i.url, open };
  if (ev.kind === "resolve") {
    return {
      ...base,
      severity: i.notified_severity ?? i.severity,
      title: `Resolved: ${i.subject}`,
      body: `${capital(i.resolution ?? "resolved")} after ${span((i.resolved_at ?? now) - i.first_seen_at)}.`,
      at: i.resolved_at ?? now,
    };
  }
  return {
    ...base,
    severity: i.severity,
    title: ev.kind === "escalate" ? `Now ${i.severity}: ${i.title}` : i.title,
    body: i.body,
    at: ev.kind === "escalate" ? now : i.first_seen_at,
  };
}

async function optionsFor(ev: NotifyEvent): Promise<PushOptions> {
  return {
    ttl: TTL_SECONDS,
    urgency: ev.kind === "resolve" ? "normal" : URGENCY[ev.incident.severity],
    topic: await topicFor(ev.incident.key),
  };
}

export function sourcesOf(sub: Pick<SubscriptionRow, "sources">): Source[] {
  return sub.sources.split(",").filter(Boolean) as Source[];
}

/** Whether this device takes this event, by its own preferences. */
export function wants(sub: SubscriptionRow, ev: NotifyEvent): boolean {
  const i = ev.incident;
  if (!sourcesOf(sub).includes(i.source)) return false;
  const min = SEVERITY_RANK[sub.min_severity];
  // A recovery only for something this device was told about.
  if (ev.kind === "resolve") return sub.recoveries === 1 && i.announced === 1 && SEVERITY_RANK[i.notified_severity ?? i.severity] >= min;
  return SEVERITY_RANK[i.severity] >= min;
}

/** Note what the push service said: forget a gone device, remember its last refusal. */
async function record(env: Env, sub: SubscriptionRow, outcome: PushOutcome, now: number): Promise<void> {
  if (outcome.ok) {
    await env.DB.prepare("UPDATE push_subscriptions SET last_sent_at = ?2, last_error = NULL, last_error_at = NULL WHERE id = ?1").bind(sub.id, now).run();
  } else if (outcome.gone) {
    console.log(JSON.stringify({ msg: "push subscription gone", device: sub.label, status: outcome.status }));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(sub.id),
      env.DB.prepare("DELETE FROM push_retries WHERE subscription_id = ?1").bind(sub.id),
    ]);
  } else {
    console.warn(JSON.stringify({ msg: "push refused", device: sub.label, status: outcome.status, error: outcome.error, retry: outcome.retry }));
    await env.DB.prepare("UPDATE push_subscriptions SET last_error = ?2, last_error_at = ?3 WHERE id = ?1").bind(sub.id, outcome.error, now).run();
  }
}

async function sendEvent(env: Env, sub: SubscriptionRow, ev: NotifyEvent, open: number, now: number, attempts: number, firstAt: number): Promise<PushOutcome> {
  const outcome = await sendPush(env, sub, payloadFor(ev, open, now), await optionsFor(ev));
  await record(env, sub, outcome, now);
  if (!outcome.ok && !outcome.gone && outcome.retry && attempts + 1 < MAX_ATTEMPTS) {
    await env.DB.prepare(
      "INSERT INTO push_retries (subscription_id, incident_id, kind, attempts, next_at, created_at, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(sub.id, ev.incident.id, ev.kind, attempts + 1, now + RETRY_BASE_MS * 2 ** attempts, firstAt, outcome.error)
      .run();
  }
  return outcome;
}

export const vapidReady = (env: Env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

async function subscriptions(env: Env): Promise<SubscriptionRow[]> {
  return (await env.DB.prepare("SELECT * FROM push_subscriptions ORDER BY id").all<SubscriptionRow>()).results;
}

export interface DeliveryReport {
  sent: number;
  failed: number;
  muted: number;
}

/** Push this evaluation's events to every device that takes them. */
export async function deliver(env: Env, events: NotifyEvent[], now: number): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, muted: 0 };
  if (!events.length) return report;
  if (!vapidReady(env)) {
    console.warn(JSON.stringify({ msg: "push skipped: VAPID keys aren't set", events: events.length }));
    return report;
  }
  const [subs, mutes, open] = await Promise.all([subscriptions(env), activeMutes(env, now), openCount(env)]);
  const jobs: Promise<PushOutcome>[] = [];
  for (const ev of events) {
    if (isMuted(mutes, ev.incident.key)) {
      report.muted++;
      continue;
    }
    if (ev.kind !== "resolve") await env.DB.prepare("UPDATE incidents SET announced = 1 WHERE id = ?1").bind(ev.incident.id).run();
    for (const sub of subs) if (wants(sub, ev)) jobs.push(sendEvent(env, sub, ev, open, now, 0, now));
  }
  for (const o of await Promise.all(jobs)) o.ok ? report.sent++ : report.failed++;
  return report;
}

interface RetryRow {
  id: number;
  subscription_id: number;
  incident_id: number;
  kind: EventKind;
  attempts: number;
  created_at: number;
}

/** Is what this push would say still true? */
async function stillTrue(env: Env, kind: EventKind, i: IncidentRow): Promise<boolean> {
  if (kind === "open") return i.resolved_at === null;
  if (kind === "escalate") return i.resolved_at === null && i.acked_at === null;
  // A recovery is outdated once the same thing has gone wrong again.
  const newer = await env.DB.prepare("SELECT 1 AS x FROM incidents WHERE key = ?1 AND id > ?2 LIMIT 1").bind(i.key, i.id).first();
  return i.resolved_at !== null && !newer;
}

/** Retry the pushes that are due. Each retry row is claimed by deleting it. */
export async function retryDue(env: Env, now: number): Promise<number> {
  if (!vapidReady(env)) return 0;
  const { results } = await env.DB.prepare("SELECT * FROM push_retries WHERE next_at <= ?1 ORDER BY id LIMIT 50").bind(now).all<RetryRow>();
  if (!results.length) return 0;
  const [mutes, open] = await Promise.all([activeMutes(env, now), openCount(env)]);
  let sent = 0;
  for (const r of results) {
    const claimed = await env.DB.prepare("DELETE FROM push_retries WHERE id = ?1 RETURNING id").bind(r.id).first();
    if (!claimed) continue;
    const [sub, inc] = await Promise.all([
      env.DB.prepare("SELECT * FROM push_subscriptions WHERE id = ?1").bind(r.subscription_id).first<SubscriptionRow>(),
      env.DB.prepare("SELECT * FROM incidents WHERE id = ?1").bind(r.incident_id).first<IncidentRow>(),
    ]);
    if (!sub || !inc || now - r.created_at > RETRY_MAX_AGE_MS || isMuted(mutes, inc.key)) continue;
    const ev: NotifyEvent = { kind: r.kind, incident: inc };
    if (!wants(sub, ev) || !(await stillTrue(env, r.kind, inc))) continue;
    if ((await sendEvent(env, sub, ev, open, now, r.attempts, r.created_at)).ok) sent++;
  }
  return sent;
}

/** A test push to one device, sent now, with the push service's answer. Ignores mutes: it was asked for. */
export async function sendTest(env: Env, sub: SubscriptionRow, body: string, now = Date.now()): Promise<PushOutcome> {
  const payload: PushPayload = {
    v: 1,
    kind: "test",
    id: null,
    tag: "hdctl:test",
    severity: null,
    title: "hdctl",
    body,
    url: "/notifications",
    at: now,
    open: await openCount(env),
  };
  const outcome = await sendPush(env, sub, payload, { ttl: 600, urgency: "high" });
  await record(env, sub, outcome, now);
  return outcome;
}

export type { MuteRow };
