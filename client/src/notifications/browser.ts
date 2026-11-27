import { closeAnswered } from "./payload";

/**
 * This browser's side of push: whether it can, its subscription, and the
 * service worker that receives it. Every call degrades to "can't" rather
 * than throwing on a browser without the APIs (jsdom included).
 */

export type Support =
  | { kind: "supported" }
  /** iPhone or iPad in a Safari tab: push only works from the Home Screen app. */
  | { kind: "ios-install" }
  | { kind: "unsupported" };

const nav = () => (typeof navigator === "undefined" ? undefined : navigator);

function isIos(): boolean {
  const n = nav();
  if (!n) return false;
  // iPadOS reports itself as a Mac; a Mac has no touch screen.
  return /iPhone|iPad|iPod/.test(n.userAgent) || (/Macintosh/.test(n.userAgent) && n.maxTouchPoints > 1);
}

function standalone(): boolean {
  return (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) || (nav() as Navigator & { standalone?: boolean })?.standalone === true;
}

export function pushSupport(): Support {
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (supported) return { kind: "supported" };
  return isIos() && !standalone() ? { kind: "ios-install" } : { kind: "unsupported" };
}

export function permission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Register /sw.js. Done on every load, so the worker that receives pushes stays current. */
export function registerServiceWorker(): void {
  const sw = nav()?.serviceWorker;
  if (!sw) return;
  sw.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
}

/** `getRegistration`, not `ready`: `ready` never settles without a worker, and this runs on every refresh. */
async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return nav()?.serviceWorker?.getRegistration().catch(() => undefined);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  return (await (await registration())?.pushManager?.getSubscription().catch(() => null)) ?? null;
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/**
 * Ask for permission and subscribe. Must run straight from a tap: iOS only
 * grants permission to a user gesture, and the prompt can't be shown again
 * once it's been declined.
 */
export async function subscribe(publicKey: string): Promise<PushSubscription> {
  const result = await Notification.requestPermission();
  if (result !== "granted") throw new Error(result === "denied" ? "Notifications are blocked for hdctl in this browser's settings." : "Notifications weren't allowed.");
  const sw = navigator.serviceWorker;
  await sw.register("/sw.js", { scope: "/", updateViaCache: "none" });
  const reg = await sw.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing && keyMatches(existing.options?.applicationServerKey ?? null, publicKey)) return existing;
  // One made with an older key would never verify: replace it.
  if (existing) await existing.unsubscribe();
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
}

/**
 * Whether a subscription was made with hdctl's current key. One made with an
 * earlier key is refused by the push service, so it needs subscribing again.
 * A browser that doesn't report the key gets the benefit of the doubt.
 */
export function keyMatches(key: ArrayBuffer | ArrayBufferView | null, publicKey: string): boolean {
  if (!key) return true;
  const a = ArrayBuffer.isView(key) ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength) : new Uint8Array(key);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Unsubscribe this browser. Returns the endpoint it had, if any. */
export async function unsubscribe(): Promise<string | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  await sub.unsubscribe().catch(() => undefined);
  return sub.endpoint;
}

export async function endpointHash(endpoint: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "iPhone · Safari", "Mac · Chrome": what the device list calls this browser. */
export function deviceLabel(ua = nav()?.userAgent ?? ""): string {
  const touchMac = /Macintosh/.test(ua) && (nav()?.maxTouchPoints ?? 0) > 1;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || touchMac ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  return browser ? `${device} · ${browser}` : device;
}

/**
 * Bring this device in line with what the server just said: close alarms
 * that are over or acknowledged, and set the app icon's badge.
 */
export async function syncShown(live: Set<number>): Promise<void> {
  try {
    const reg = await registration();
    if (reg && typeof reg.getNotifications === "function") closeAnswered(await reg.getNotifications(), live);
    const n = nav() as (Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> }) | undefined;
    if (live.size) await n?.setAppBadge?.(live.size);
    else await n?.clearAppBadge?.();
  } catch {
    // Nothing to recover: the page shows the truth either way.
  }
}
