import { beforeAll, describe, expect, it } from "vitest";
import { AuthError, allowedEmails, tokenFrom, verifyAccessJwt, type AccessClaims } from "../src/auth";
import { b64url, newKeyPair, publicJwk as jwkFor, signJwt } from "./helpers/access";

const TEAM = "mfaherty.cloudflareaccess.com";
const AUD = "test-aud";
const NOW = 1_800_000_000_000;

let keys: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid: string };

const sign = (claims: Partial<AccessClaims>, header?: Record<string, unknown>, key = keys.privateKey) => signJwt(key, claims, header);

const good: Partial<AccessClaims> = {
  aud: [AUD],
  email: "Owner@Example.com",
  iss: `https://${TEAM}`,
  exp: NOW / 1000 + 600,
  iat: NOW / 1000,
};

const opts = () => ({
  audience: AUD,
  teamDomain: TEAM,
  allowedEmails: ["owner@example.com"],
  keyFor: async (kid: string) => (kid === "k1" ? publicJwk : null),
  now: NOW,
});

beforeAll(async () => {
  keys = await newKeyPair();
  publicJwk = await jwkFor(keys);
});

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns its claims", async () => {
    const claims = await verifyAccessJwt(await sign(good), opts());
    expect(claims.email).toBe("Owner@Example.com");
  });

  it.each([
    ["wrong audience", { aud: ["someone-else"] }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: NOW / 1000 - 3600 }],
    ["not yet valid", { nbf: NOW / 1000 + 3600 }],
    ["identity not allowed", { email: "intruder@example.com" }],
    ["identity not allowed", { email: undefined }],
  ])("rejects: %s", async (reason, override) => {
    await expect(verifyAccessJwt(await sign({ ...good, ...override }), opts())).rejects.toThrow(reason);
  });

  it("rejects a token signed by another key", async () => {
    const other = await newKeyPair();
    await expect(verifyAccessJwt(await sign(good, undefined, other.privateKey), opts())).rejects.toThrow("bad signature");
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = (await sign(good)).split(".");
    const forged = `${h}.${b64url(JSON.stringify({ ...good, email: "owner@example.com", exp: NOW / 1000 + 99999 }))}.${s}`;
    await expect(verifyAccessJwt(forged, opts())).rejects.toThrow("bad signature");
  });

  it("rejects alg none and unknown kids", async () => {
    await expect(verifyAccessJwt(await sign(good, { alg: "none", kid: "k1" }), opts())).rejects.toThrow(AuthError);
    await expect(verifyAccessJwt(await sign(good, { alg: "RS256", kid: "k9" }), opts())).rejects.toThrow("unknown signing key");
  });

  it("rejects garbage", async () => {
    await expect(verifyAccessJwt("not.a.jwt", opts())).rejects.toThrow(AuthError);
    await expect(verifyAccessJwt("nope", opts())).rejects.toThrow("malformed");
  });
});

describe("tokenFrom", () => {
  it("prefers the Access header, then the cookie", () => {
    expect(tokenFrom(new Request("https://x/", { headers: { "Cf-Access-Jwt-Assertion": "hdr" } }))).toBe("hdr");
    expect(tokenFrom(new Request("https://x/", { headers: { Cookie: "a=1; CF_Authorization=ck; b=2" } }))).toBe("ck");
    expect(tokenFrom(new Request("https://x/"))).toBeNull();
  });
});

describe("allowedEmails", () => {
  it("splits, trims and lower-cases", () => {
    expect(allowedEmails(" A@x.com , b@Y.com,")).toEqual(["a@x.com", "b@y.com"]);
  });
});
