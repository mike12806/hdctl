import type { Env } from "../env";
import { BadRequest, NotConfigured } from "../errors";

/**
 * Web Push, on Web Crypto alone (the `web-push` package needs Node's crypto).
 * Carried over from TaskTracker's pushSend.ts, which carried it over from
 * BabyTracker. Two independent pieces:
 *
 *  - VAPID (RFC 8292): an ES256 JWT that tells the push service this message
 *    comes from the server the browser subscribed to. Signed with hdctl's own
 *    keypair (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, from Vault kv/github/hdctl/push).
 *  - Payload encryption (RFC 8291, aes128gcm): a fresh ECDH exchange with the
 *    device's keys for every message, so the push service (Google, Apple,
 *    Mozilla, Microsoft) never sees what it carries.
 *
 * hdctl adds the headers TaskTracker didn't need:
 *  - Urgency (RFC 8030 §5.3): high for a critical incident, so a phone in
 *    battery saver still wakes for it; low for info.
 *  - Topic (§5.4): one per incident key. A message still queued at the push
 *    service for an offline phone is replaced by the next one about the same
 *    thing, so a phone that was in a tunnel gets "Harbor recovered", not
 *    "Harbor is down" followed by "Harbor recovered".
 */

export interface DeviceKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type Urgency = "very-low" | "low" | "normal" | "high";

export interface PushOptions {
  /** Seconds the push service may hold the message for an offline device. */
  ttl: number;
  urgency: Urgency;
  /** Collapses queued messages about the same thing; see topicFor. */
  topic?: string;
}

/** What the push service said, sorted into what to do about it. */
export type PushOutcome =
  | { ok: true; status: number }
  /** 404/410: the subscription is gone for good (unsubscribed, app removed). Forget it. */
  | { ok: false; gone: true; status: number; error: string }
  /** 429, 5xx, no answer: worth another try later. */
  | { ok: false; gone: false; retry: true; status: number | null; error: string }
  /** Anything else (bad VAPID key, payload too big): retrying won't help. */
  | { ok: false; gone: false; retry: false; status: number; error: string };

const SEND_TIMEOUT_MS = 10_000;

/**
 * The push services browsers actually use. A subscription is just a URL the
 * Worker will POST to from the cron, so anything else is refused at
 * registration: hdctl must not become a way to make the Worker call an
 * arbitrary host.
 */
const PUSH_HOSTS: RegExp[] = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Brave, Opera, Samsung Internet
  /^android\.googleapis\.com$/, // older Chrome subscriptions
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/, // Safari on macOS and iOS
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows
];

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A subscription as PushSubscription.toJSON() gives it, checked: an https URL
 * at a known push service, a P-256 public key and a 16-byte auth secret.
 */
export function parseDeviceKeys(raw: unknown): DeviceKeys {
  const s = (raw ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== "string" || s.endpoint.length > 2048) throw new BadRequest("subscription.endpoint is required");
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    throw new BadRequest("subscription.endpoint isn't a URL");
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || !PUSH_HOSTS.some((h) => h.test(url.hostname))) {
    throw new BadRequest(`subscription.endpoint isn't at a known push service (${url.hostname})`);
  }
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (typeof p256dh !== "string" || !B64URL.test(p256dh) || typeof auth !== "string" || !B64URL.test(auth)) {
    throw new BadRequest("subscription.keys.p256dh and subscription.keys.auth are required");
  }
  const key = base64UrlToBytes(p256dh);
  if (key.length !== 65 || key[0] !== 4) throw new BadRequest("subscription.keys.p256dh isn't an uncompressed P-256 key");
  if (base64UrlToBytes(auth).length !== 16) throw new BadRequest("subscription.keys.auth isn't 16 bytes");
  return { endpoint: url.toString(), p256dh, auth };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** Single-block HKDF-Expand: every length here is at most 32 bytes, one SHA-256 block. */
export async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  return (await hmacSha256(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/**
 * RFC 8291 aes128gcm: the whole request body (salt, record size, our
 * ephemeral public key, then one encrypted record).
 */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = base64UrlToBytes(p256dh);
  const authSecret = base64UrlToBytes(auth);

  const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // workers-types names the ECDH field `$public`; the runtime (and the spec) read `public`.
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, ephemeral.privateKey, 256),
  );

  // Key material from the shared secret, the auth secret and both public keys (RFC 8291 §3.3)...
  const ikm = await hkdfExpand(await hmacSha256(authSecret, shared), concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  // ...then this message's content key and nonce, under a random salt (RFC 8188 §2.1).
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(prk, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, utf8("Content-Encoding: nonce\0"), 12);

  // One record: the plaintext and the 0x02 last-record delimiter, no padding.
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, sealed);
}

/** The VAPID JWT for one push service (`aud` is its origin), valid for 12 hours. */
export async function vapidJwt(audience: string, subject: string, publicKey: string, privateKey: string, now = Date.now()): Promise<string> {
  const header = bytesToBase64Url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToBase64Url(utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const pub = base64UrlToBytes(publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    // The private key is stored as the JWK `d` value itself (base64url), which is what vapid-keys.mjs prints.
    { kty: "EC", crv: "P-256", d: privateKey, x: bytesToBase64Url(pub.slice(1, 33)), y: bytesToBase64Url(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // Web Crypto's ECDSA signature is already the raw r||s that JWS wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${claims}`)));
  return `${header}.${claims}.${bytesToBase64Url(sig)}`;
}

/** The public key browsers subscribe with, or a setup note while the keypair isn't in Vault yet. */
export function vapidPublicKey(env: Env): string {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new NotConfigured(
      "VAPID keys aren't set. Run `npm run vapid-keys -w worker` once, store both values at Vault kv/github/hdctl/push, and re-run the deploy.",
    );
  }
  return env.VAPID_PUBLIC_KEY;
}

/** A Topic header value: at most 32 characters of the base64url alphabet (RFC 8030 §5.4). */
export async function topicFor(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(key)));
  return bytesToBase64Url(digest).slice(0, 32);
}

/** Send one message to one device. Never throws: every failure is an outcome. */
export async function sendPush(env: Env, device: DeviceKeys, payload: unknown, opts: PushOptions): Promise<PushOutcome> {
  let body: Uint8Array;
  let jwt: string;
  try {
    const publicKey = vapidPublicKey(env);
    const url = new URL(device.endpoint);
    [body, jwt] = await Promise.all([
      encryptPayload(utf8(JSON.stringify(payload)), device.p256dh, device.auth),
      vapidJwt(`${url.protocol}//${url.host}`, env.VAPID_SUBJECT || "https://hdctl.mfaherty.net", publicKey, env.VAPID_PRIVATE_KEY!),
    ]);
  } catch (err) {
    return { ok: false, gone: false, retry: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    TTL: String(Math.max(0, Math.round(opts.ttl))),
    Urgency: opts.urgency,
  };
  if (opts.topic) headers.Topic = opts.topic;

  let res: Response;
  try {
    res = await fetch(device.endpoint, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "TimeoutError" ? `no answer in ${SEND_TIMEOUT_MS / 1000}s` : err.message) : String(err);
    return { ok: false, gone: false, retry: true, status: null, error: `push service unreachable: ${msg}` };
  }
  if (res.status >= 200 && res.status < 300) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: true, status: res.status };
  }
  const text = (await res.text().catch(() => "")).trim().slice(0, 200);
  const error = `push service answered HTTP ${res.status}${text ? `: ${text}` : ""}`;
  if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status, error };
  if (res.status === 429 || res.status >= 500) return { ok: false, gone: false, retry: true, status: res.status, error };
  return { ok: false, gone: false, retry: false, status: res.status, error };
}
