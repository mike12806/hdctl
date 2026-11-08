/**
 * Cloudflare Access JWT verification.
 *
 * Access already blocks anyone who isn't allowed before a request reaches the
 * Worker; this is the second lock. It means nothing is served if the Access
 * app is ever removed, misconfigured, or bypassed (workers.dev and preview URLs
 * are off as well). Checked: RS256 signature against the team's published
 * keys, audience = this app's AUD, issuer = the team domain, expiry, and the
 * email against ALLOWED_EMAILS.
 */

export interface AccessClaims {
  aud: string[] | string;
  email?: string;
  exp: number;
  nbf?: number;
  iat?: number;
  iss: string;
  sub?: string;
  type?: string;
}

type SigningKey = JsonWebKey & { kid?: string };

export class AuthError extends Error {}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as T;
}

export interface VerifyOptions {
  audience: string;
  teamDomain: string;
  allowedEmails: string[];
  /** Returns the key for a kid, or null. Injected so tests don't fetch. */
  keyFor: (kid: string) => Promise<SigningKey | null>;
  now?: number;
}

export async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = decodeJson(h);
    claims = decodeJson(p);
  } catch {
    throw new AuthError("undecodable token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError("unexpected token algorithm");

  const key = await opts.keyFor(header.kid);
  if (!key) throw new AuthError("unknown signing key");
  const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AuthError("bad signature");

  // Only trust the claims once the signature has checked out.
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) throw new AuthError("wrong audience");
  if (claims.iss !== `https://${opts.teamDomain}`) throw new AuthError("wrong issuer");
  if (typeof claims.exp !== "number" || claims.exp < now - 30) throw new AuthError("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) throw new AuthError("not yet valid");
  const email = claims.email?.toLowerCase();
  if (!email || !opts.allowedEmails.includes(email)) throw new AuthError("identity not allowed");
  return claims;
}

/** The token Access forwards: the header on every proxied request, else the cookie. */
export function tokenFrom(req: Request): string | null {
  const header = req.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m?.[1] ?? null;
}

// Access's signing keys, cached in the isolate for at most an hour, so a key
// Access has retired stops being accepted within the hour. An unknown kid
// refetches at once (keys rotate), but at most once a minute, so a stream of
// forged tokens can't turn into a stream of subrequests.
let jwks: { keys: SigningKey[]; fetchedAt: number } | null = null;
const REFETCH_FLOOR_MS = 60_000;
const MAX_AGE_MS = 3_600_000;

export function accessKeyFetcher(teamDomain: string): (kid: string) => Promise<SigningKey | null> {
  return async (kid) => {
    if (jwks && Date.now() - jwks.fetchedAt > MAX_AGE_MS) jwks = null;
    const cached = jwks?.keys.find((k) => k.kid === kid);
    if (cached) return cached;
    if (jwks && Date.now() - jwks.fetchedAt < REFETCH_FLOOR_MS) return null;
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new AuthError(`could not fetch Access keys (${res.status})`);
    const body = (await res.json()) as { keys?: SigningKey[] };
    jwks = { keys: body.keys ?? [], fetchedAt: Date.now() };
    return jwks.keys.find((k) => k.kid === kid) ?? null;
  };
}

export function allowedEmails(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
