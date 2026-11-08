import type { AccessClaims } from "../../src/auth";

/** Sign Cloudflare Access style JWTs (RS256) with a key made for the test run. */

export const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function newKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export async function publicJwk(keys: CryptoKeyPair, kid = "k1"): Promise<JsonWebKey & { kid: string }> {
  return { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid };
}

export async function signJwt(
  key: CryptoKey,
  claims: Partial<AccessClaims>,
  header: Record<string, unknown> = { alg: "RS256", kid: "k1" },
): Promise<string> {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
