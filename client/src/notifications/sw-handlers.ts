import { ACK, MUTE, MUTE_MINUTES, parsePayload, toNotification, type NotificationData, type ShowOptions } from "./payload";

/**
 * The service worker's behaviour, without its globals, so it is tested in
 * jsdom (test/sw.test.ts). sw.ts binds these to `self`.
 */

export interface WindowLike {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}

export interface SwContext {
  showNotification(title: string, options: ShowOptions): Promise<void>;
  /** Same-origin window clients, controlled or not. */
  windows(): Promise<WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
  fetch(input: string, init: RequestInit): Promise<Response>;
  setBadge(count: number): Promise<void>;
  subscribe(options: PushSubscriptionOptionsInit): Promise<{ toJSON(): unknown }>;
  images: { icon: string; badge: string };
}

/** Same as the app's own calls: the CSRF guard wants the header (worker/src/index.ts). */
const HEADERS = { Accept: "application/json", "Content-Type": "application/json", "X-Hdctl": "1" };

/**
 * Show a push. A browser requires every push to show something, so one this
 * build can't read (a newer server, a corrupt payload) still says hdctl has
 * news rather than nothing, which Chrome would replace with its own generic
 * text and Safari would count against the subscription.
 */
export async function handlePush(ctx: SwContext, read: () => unknown): Promise<void> {
  let raw: unknown = null;
  try {
    raw = read();
  } catch {
    // not JSON
  }
  const p = parsePayload(raw);
  if (!p) {
    const data: NotificationData = { id: null, kind: "test", url: "/notifications" };
    await ctx.showNotification("hdctl", { body: "Something changed. Open hdctl to see what.", tag: "hdctl:unreadable", icon: ctx.images.icon, badge: ctx.images.badge, data });
    return;
  }
  const { title, options } = toNotification(p, ctx.images);
  await Promise.all([ctx.showNotification(title, options), ctx.setBadge(p.open).catch(() => undefined)]);
}

/**
 * Acknowledge or mute straight from the notification, with no window opened.
 * Same-origin, so the Access cookie goes along. Redirects aren't followed: an
 * expired Access session answers with one, and that counts as failure.
 */
async function act(ctx: SwContext, id: number, action: typeof ACK | typeof MUTE): Promise<boolean> {
  try {
    const res = await ctx.fetch(`/api/notify/incidents/${id}/${action}`, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      headers: HEADERS,
      body: JSON.stringify(action === MUTE ? { minutes: MUTE_MINUTES } : {}),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { open?: unknown } | null;
    if (typeof body?.open === "number") await ctx.setBadge(body.open).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Bring hdctl forward on `url`: an open window if there is one, else a new one. */
async function show(ctx: SwContext, url: string): Promise<void> {
  const [win] = await ctx.windows();
  if (win) {
    // Focus first, while the click still counts as the user's: navigating can take a while.
    await win.focus().catch(() => undefined);
    await win.navigate(url).catch(() => undefined);
    return;
  }
  await ctx.openWindow(url);
}

/**
 * A tap opens the page the notification is about. Acknowledge and Mute act
 * in place; if that fails (most likely an expired Access session), hdctl
 * opens on the Notifications page instead, where signing in again and
 * retrying is one tap.
 */
export async function handleClick(ctx: SwContext, rawData: unknown, action: string): Promise<void> {
  const data = (rawData ?? {}) as Partial<NotificationData>;
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/";
  if ((action === ACK || action === MUTE) && typeof data.id === "number") {
    if (await act(ctx, data.id, action)) return;
    return show(ctx, "/notifications");
  }
  return show(ctx, url);
}

/**
 * The browser replaced this device's subscription (keys rotated, or the old
 * one expired). Register the new one in place of the old, keeping its
 * preferences. Best effort: with an expired Access session it can't, and
 * the Notifications page offers to register this device again.
 */
export async function handleSubscriptionChange(
  ctx: SwContext,
  oldSub: { endpoint: string; options?: PushSubscriptionOptions } | null,
  newSub: { toJSON(): unknown } | null,
): Promise<void> {
  let sub = newSub;
  if (!sub) {
    let key: BufferSource | string | null | undefined = oldSub?.options?.applicationServerKey;
    if (!key) {
      const res = await ctx.fetch("/api/notify/devices", { credentials: "same-origin", redirect: "manual", headers: HEADERS });
      if (!res.ok) return;
      key = ((await res.json()) as { publicKey: string }).publicKey;
    }
    sub = await ctx.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  await ctx.fetch("/api/notify/devices", {
    method: "POST",
    credentials: "same-origin",
    redirect: "manual",
    headers: HEADERS,
    body: JSON.stringify({ subscription: sub.toJSON(), replaces: oldSub?.endpoint ?? null }),
  });
}
