/**
 * What a push carries, and how it's shown. Shared by the service worker
 * (sw.ts), which shows it, and the page, which takes answered ones back down.
 * The sender is worker/src/notify/deliver.ts (PushPayload there); keep the two
 * in step.
 */

export type Kind = "open" | "escalate" | "resolve" | "test";
export type Severity = "critical" | "warning" | "info";

export interface PushPayload {
  v: 1;
  kind: Kind;
  /** The incident, for Acknowledge and Mute. Null for a test. */
  id: number | null;
  /** One per thing (hdctl:target:harbor), so a recovery replaces the alarm it answers. */
  tag: string;
  severity: Severity | null;
  title: string;
  body: string;
  /** The hdctl page to open. */
  url: string;
  /** When it happened, epoch ms. */
  at: number;
  /** Open, unacknowledged incidents: the app icon's badge. */
  open: number;
}

/** What a shown notification keeps, to act on a click. */
export interface NotificationData {
  id: number | null;
  kind: Kind;
  url: string;
  /** When it happened, so an old recovery can be tidied away (see tidyRecoveries). */
  at?: number;
}

/** A "Resolved" notification is cleared by the next one to arrive once it's this old. */
export const RECOVERY_KEEP_MS = 10 * 60_000;

export const ACK = "ack";
export const MUTE = "mute";
export const MUTE_MINUTES = 60;

const KINDS = new Set<Kind>(["open", "escalate", "resolve", "test"]);

/** A payload this build understands, or null. A same-origin path only, so a payload can't send a click elsewhere. */
export function parsePayload(raw: unknown): PushPayload | null {
  const p = raw as Partial<PushPayload> | null;
  if (!p || typeof p !== "object" || p.v !== 1 || !KINDS.has(p.kind as Kind)) return null;
  if (typeof p.title !== "string" || typeof p.body !== "string" || typeof p.tag !== "string") return null;
  const url = typeof p.url === "string" && p.url.startsWith("/") && !p.url.startsWith("//") ? p.url : "/";
  return {
    v: 1,
    kind: p.kind as Kind,
    id: typeof p.id === "number" ? p.id : null,
    tag: p.tag,
    severity: p.severity ?? null,
    title: p.title,
    body: p.body,
    url,
    at: typeof p.at === "number" ? p.at : Date.now(),
    open: typeof p.open === "number" ? p.open : 0,
  };
}

/** NotificationOptions as browsers take them; actions, renotify and timestamp aren't in TypeScript's DOM types. */
export type ShowOptions = NotificationOptions & {
  actions?: { action: string; title: string }[];
  renotify?: boolean;
  timestamp?: number;
  requireInteraction?: boolean;
};

/**
 * How each kind is shown:
 *  - open, escalate: buzz even when replacing an older notification for the
 *    same thing (renotify), with Acknowledge and Mute 1 h buttons where the
 *    platform shows them (not iOS: there a tap opens the page). A critical one
 *    stays on a desktop screen until dealt with.
 *  - resolve: replaces the alarm under the same tag, silently (no sound or
 *    vibration, even if the alarm was already swiped away). It doesn't stay:
 *    opening hdctl clears it (closeAnswered), and so does the next push to
 *    arrive once it's RECOVERY_KEEP_MS old (tidyRecoveries).
 *  - test: on its own tag.
 * `timestamp` is when it happened, so a phone that was offline shows "12 min
 * ago" rather than "now".
 */
export function toNotification(p: PushPayload, images: { icon: string; badge: string }): { title: string; options: ShowOptions } {
  const alarm = p.kind === "open" || p.kind === "escalate";
  const data: NotificationData = { id: p.id, kind: p.kind, url: p.url, at: p.at };
  return {
    title: p.title,
    options: {
      body: p.body,
      tag: p.tag,
      icon: images.icon,
      badge: images.badge,
      timestamp: p.at,
      renotify: alarm,
      silent: p.kind === "resolve",
      requireInteraction: alarm && p.severity === "critical",
      actions:
        alarm && p.id !== null
          ? [
              { action: ACK, title: "Acknowledge" },
              { action: MUTE, title: `Mute ${MUTE_MINUTES / 60} h` },
            ]
          : [],
      data,
    },
  };
}

type Shown = { data: unknown; tag?: string; close(): void };

/**
 * Tidy this device's notifications against what the server just said: close
 * the alarms no longer open and unacknowledged (resolved, acknowledged on
 * another device, or gone), and every "Resolved" one, which hdctl's own page
 * now shows. A push is a copy that lives on the device, so nothing the server
 * does can take it back; the page does, whenever it reads the incidents. Call
 * it only with a list that actually came back from the server: a failed read
 * says nothing is over.
 */
export function closeAnswered(shown: Shown[], live: Set<number>): number {
  let closed = 0;
  for (const n of shown) {
    const d = n.data as Partial<NotificationData> | null;
    const answered = (d?.kind === "open" || d?.kind === "escalate") && typeof d.id === "number" && !live.has(d.id);
    if (!answered && d?.kind !== "resolve") continue;
    n.close();
    closed++;
  }
  return closed;
}

/**
 * The service worker's half of keeping recoveries from piling up, for a
 * device where hdctl isn't opened: when a push arrives, close the "Resolved"
 * notifications older than RECOVERY_KEEP_MS, other than the one just shown
 * (`keepTag`). One from a build before `at` was recorded counts as old.
 */
export function tidyRecoveries(shown: Shown[], keepTag: string, now: number): number {
  let closed = 0;
  for (const n of shown) {
    const d = n.data as Partial<NotificationData> | null;
    if (d?.kind !== "resolve" || n.tag === keepTag) continue;
    if (typeof d.at === "number" && now - d.at <= RECOVERY_KEEP_MS) continue;
    n.close();
    closed++;
  }
  return closed;
}
