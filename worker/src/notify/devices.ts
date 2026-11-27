import type { Env, Identity } from "../env";
import { BadRequest, NotFound } from "../errors";
import { sendTest, sourcesOf, type SubscriptionRow } from "./deliver";
import { parseId } from "./incidents";
import { parseDeviceKeys, vapidPublicKey, type PushOutcome } from "./webpush";
import { SEVERITIES, SOURCES, type Severity, type Source } from "./types";

/**
 * The devices that turned notifications on: one Web Push subscription each,
 * with its own preferences. The keys never leave the Worker; the page tells
 * its own device apart by a hash of the endpoint.
 */

/** Who runs a push service, for the device list. Anchored at both ends, like PUSH_HOSTS in webpush.ts. */
const SERVICES: [RegExp, string][] = [
  [/^(?:[a-z0-9-]+\.)?push\.apple\.com$/, "Apple"],
  [/^(?:fcm|android)\.googleapis\.com$/, "Google"],
  [/^(?:updates\.)?push\.services\.mozilla\.com$/, "Mozilla"],
  [/^[a-z0-9-]+\.notify\.windows\.com$/, "Microsoft"],
];

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function toDevice(s: SubscriptionRow) {
  const host = new URL(s.endpoint).hostname;
  return {
    id: s.id,
    label: s.label,
    actor: s.actor,
    endpointHash: await sha256Hex(s.endpoint),
    service: SERVICES.find(([re]) => re.test(host))?.[1] ?? host,
    sources: sourcesOf(s),
    minSeverity: s.min_severity,
    recoveries: s.recoveries === 1,
    createdAt: s.created_at,
    lastSentAt: s.last_sent_at,
    lastError: s.last_error,
    lastErrorAt: s.last_error_at,
  };
}

function parseLabel(raw: unknown): string {
  const label = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return label || "Browser";
}

function parseSources(raw: unknown): Source[] {
  if (!Array.isArray(raw) || !raw.length || raw.some((s) => !SOURCES.includes(s as Source))) {
    throw new BadRequest(`sources must be a non-empty list of ${SOURCES.join(", ")}`);
  }
  return SOURCES.filter((s) => raw.includes(s));
}

function parseSeverity(raw: unknown): Severity {
  if (!SEVERITIES.includes(raw as Severity)) throw new BadRequest(`minSeverity must be one of ${SEVERITIES.join(", ")}`);
  return raw as Severity;
}

async function row(env: Env, id: number): Promise<SubscriptionRow> {
  const r = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE id = ?1").bind(id).first<SubscriptionRow>();
  if (!r) throw new NotFound("no such device");
  return r;
}

export async function listDevices(env: Env) {
  const publicKey = vapidPublicKey(env);
  const { results } = await env.DB.prepare("SELECT * FROM push_subscriptions ORDER BY created_at").all<SubscriptionRow>();
  return { publicKey, devices: await Promise.all(results.map(toDevice)) };
}

const summary = (o: PushOutcome) => (o.ok ? { ok: true as const, status: o.status } : { ok: false as const, status: o.status, gone: o.gone, error: o.error });

/**
 * Register this device's subscription, or refresh one already registered
 * (new keys, a new label; its preferences stay). A new device gets a
 * confirmation push at once, so turning notifications on proves they arrive.
 *
 * `replaces` is the endpoint the browser just swapped for this one (the
 * service worker's pushsubscriptionchange): the old row's preferences move
 * over and the old row goes.
 */
export async function registerDevice(env: Env, who: Identity, body: { subscription?: unknown; label?: unknown; replaces?: unknown }, now = Date.now()) {
  vapidPublicKey(env);
  const keys = parseDeviceKeys(body.subscription);
  const label = parseLabel(body.label);

  const existing = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?1").bind(keys.endpoint).first<SubscriptionRow>();
  if (existing) {
    const updated = await env.DB.prepare("UPDATE push_subscriptions SET p256dh = ?2, auth = ?3, label = ?4, updated_at = ?5 WHERE id = ?1 RETURNING *")
      .bind(existing.id, keys.p256dh, keys.auth, body.label === undefined ? existing.label : label, now)
      .first<SubscriptionRow>();
    return { device: await toDevice(updated!), created: false, confirmation: null };
  }

  const old =
    typeof body.replaces === "string" && body.replaces !== keys.endpoint
      ? await env.DB.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?1").bind(body.replaces).first<SubscriptionRow>()
      : null;
  const created = await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, actor, label, sources, min_severity, recoveries, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at
     RETURNING *`,
  )
    .bind(keys.endpoint, keys.p256dh, keys.auth, who.email, old?.label ?? label, old?.sources ?? SOURCES.join(","), old?.min_severity ?? "warning", old?.recoveries ?? 1, now)
    .first<SubscriptionRow>();
  if (old) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(old.id),
      env.DB.prepare("DELETE FROM push_retries WHERE subscription_id = ?1").bind(old.id),
    ]);
    return { device: await toDevice(created!), created: true, confirmation: null };
  }
  const confirmation = summary(await sendTest(env, created!, `Notifications are on for ${created!.label}. This is what they'll look like.`, now));
  return { device: await toDevice(created!), created: true, confirmation };
}

export async function updateDevice(env: Env, rawId: string, body: { sources?: unknown; minSeverity?: unknown; recoveries?: unknown; label?: unknown }, now = Date.now()) {
  const current = await row(env, parseId(rawId));
  if (body.recoveries !== undefined && typeof body.recoveries !== "boolean") throw new BadRequest("recoveries must be true or false");
  const updated = await env.DB.prepare(
    "UPDATE push_subscriptions SET sources = ?2, min_severity = ?3, recoveries = ?4, label = ?5, updated_at = ?6 WHERE id = ?1 RETURNING *",
  )
    .bind(
      current.id,
      body.sources === undefined ? current.sources : parseSources(body.sources).join(","),
      body.minSeverity === undefined ? current.min_severity : parseSeverity(body.minSeverity),
      body.recoveries === undefined ? current.recoveries : body.recoveries ? 1 : 0,
      body.label === undefined ? current.label : parseLabel(body.label),
      now,
    )
    .first<SubscriptionRow>();
  return toDevice(updated!);
}

export async function removeDevice(env: Env, rawId: string): Promise<{ ok: true }> {
  const id = parseId(rawId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(id),
    env.DB.prepare("DELETE FROM push_retries WHERE subscription_id = ?1").bind(id),
  ]);
  return { ok: true };
}

export async function testDevice(env: Env, rawId: string, now = Date.now()) {
  vapidPublicKey(env);
  const sub = await row(env, parseId(rawId));
  return summary(await sendTest(env, sub, `Test notification. If you can read this, ${sub.label} gets hdctl's notifications.`, now));
}
