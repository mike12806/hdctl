import { b64url } from "./access";

/**
 * A browser's side of Web Push, for tests: device keys to subscribe with, and
 * the receiver's half of RFC 8291 to read what the Worker sent. Written
 * independently of src/notify/webpush.ts (HKDF from Web Crypto, not the
 * sender's HMAC steps), so a mistake in the sender's math fails the test
 * instead of agreeing with itself.
 */

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** A VAPID keypair in the form the Worker's secrets hold it. */
export async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { VAPID_PUBLIC_KEY: b64url(raw), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: "https://hdctl.test" };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export interface FakeDevice {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  /** Decrypt one aes128gcm body sent to this device. */
  decrypt(body: Uint8Array): Promise<unknown>;
}

export async function fakeDevice(name = "phone", host = "fcm.googleapis.com"): Promise<FakeDevice> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint: `https://${host}/push/${name}-${b64url(crypto.getRandomValues(new Uint8Array(6)))}`, keys: { p256dh: b64url(uaPublic), auth: b64url(auth) } },
    async decrypt(body) {
      const salt = body.slice(0, 16);
      const idlen = body[20]!;
      const asPublic = body.slice(21, 21 + idlen);
      const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256));
      const ikm = await hkdf(auth, shared, new Uint8Array([...utf8("WebPush: info\0"), ...uaPublic, ...asPublic]), 32);
      const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
      const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
      const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
      let end = plain.length - 1;
      while (end > 0 && plain[end] === 0) end--; // padding, if any
      if (plain[end] !== 2) throw new Error("missing the last-record delimiter");
      return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
    },
  };
}

export { fromB64url };
