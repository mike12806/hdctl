import { vi } from "vitest";
import worker from "../../src/index";
import type { AccessClaims } from "../../src/auth";
import type { Env } from "../../src/env";
import { TARGETS, type Target } from "../../src/targets";
import { testD1 } from "./d1";
import { fakeKv } from "./kv";
import { newKeyPair, publicJwk, signJwt } from "./access";

/**
 * The real Worker (routes, Access check, CSRF guard, headers, onError), run
 * in-process against:
 *   - D1: SQLite with the real migrations (helpers/d1.ts);
 *   - one fake VPC binding per target, answering as `upstream` says and
 *     recording every call, so a test can assert what was (or wasn't) sent;
 *   - an ASSETS binding whose responses have immutable headers, as the real
 *     one's do;
 *   - a global fetch that serves Access's signing keys and hands anything
 *     else (api.github.com) to `internet`.
 */

export const ORIGIN = "https://hdctl.mfaherty.net";
export const TEAM = "mfaherty.cloudflareaccess.com";
export const AUD = "test-aud";
export const OWNER = "owner@example.com";
export const BUILD = "build-123";

let keys: Promise<CryptoKeyPair> | null = null;
const signingKeys = () => (keys ??= newKeyPair());

/** A valid Access JWT for the owner, with any claims overridden. */
export async function accessToken(overrides: Partial<AccessClaims> = {}, key?: CryptoKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Partial<AccessClaims> = { aud: [AUD], iss: `https://${TEAM}`, email: OWNER, iat: now, exp: now + 600, ...overrides };
  return signJwt(key ?? (await signingKeys()).privateKey, claims);
}

export interface UpstreamCall {
  target: string;
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

export type Upstream = (target: Target, req: Request) => Response | Promise<Response>;
export type Internet = (req: Request) => Response | Promise<Response>;

/** Every target answers its health check as expected, and anything else with 404. */
export const healthy: Upstream = (t, req) =>
  new URL(req.url).pathname === t.check.path ? new Response(null, { status: t.check.expect[0] }) : new Response("not stubbed", { status: 404 });

const offline: Internet = () => {
  throw new TypeError("fetch failed");
};

function immutableHeaders(res: Response): Response {
  for (const m of ["set", "append", "delete"] as const) {
    Object.defineProperty(res.headers, m, {
      value: () => {
        throw new TypeError("Can't modify immutable headers.");
      },
    });
  }
  return res;
}

export function testEnv(opts: { upstream?: Upstream; internet?: Internet; vars?: Partial<Env> } = {}) {
  const d1 = testD1();
  const { kv, store } = fakeKv();
  const calls: UpstreamCall[] = [];
  const internetCalls: Request[] = [];
  const state = { upstream: opts.upstream ?? healthy, internet: opts.internet ?? offline };

  const bindings = Object.fromEntries(
    TARGETS.map((t) => [
      t.binding,
      {
        async fetch(input: string, init?: RequestInit) {
          const req = new Request(input, init);
          const url = new URL(req.url);
          calls.push({ target: t.id, method: req.method, path: url.pathname + url.search, headers: req.headers, body: await req.clone().text() });
          return state.upstream(t, req);
        },
      },
    ]),
  );

  const assetRequests: string[] = [];
  const ASSETS = {
    async fetch(req: Request) {
      const path = new URL(req.url).pathname;
      assetRequests.push(path);
      if (path === "/assets/index-abc123.js") return immutableHeaders(new Response("// js", { headers: { "Content-Type": "text/javascript" } }));
      if (path.startsWith("/assets/")) return immutableHeaders(new Response("not found", { status: 404 }));
      return immutableHeaders(new Response("<!doctype html><title>hdctl</title>", { headers: { "Content-Type": "text/html" } }));
    },
  };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [await publicJwk(await signingKeys())] });
    internetCalls.push(req.clone());
    return state.internet(req);
  });

  const env = {
    DB: d1.db,
    CACHE: kv,
    ASSETS,
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    ALLOWED_EMAILS: OWNER,
    GITHUB_OWNER: "mike12806",
    BUILD_ID: BUILD,
    ...bindings,
    ...opts.vars,
  } as unknown as Env;

  return {
    env,
    d1,
    cache: store,
    /** Calls made through the VPC bindings, in order. */
    calls,
    /** Calls made over the internet (GitHub), in order. */
    internetCalls,
    assetRequests,
    setUpstream: (u: Upstream) => void (state.upstream = u),
    setInternet: (i: Internet) => void (state.internet = i),
    audit: () => d1.query<{ actor: string; action: string; target: string; params: string | null; status: string; result: string | null }>("SELECT * FROM audit_log ORDER BY id"),
  };
}

export type TestEnv = ReturnType<typeof testEnv>;

function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

/**
 * A request to the Worker as Access forwards it: with the owner's JWT unless
 * `token` says otherwise (null: none). Waits for waitUntil work to finish.
 */
export async function call(env: Env, path: string, init: RequestInit & { token?: string | null; origin?: string } = {}): Promise<Response> {
  const { token, origin = ORIGIN, ...rest } = init;
  const headers = new Headers(rest.headers);
  const jwt = token === undefined ? await accessToken() : token;
  if (jwt) headers.set("Cf-Access-Jwt-Assertion", jwt);
  const { ctx, settle } = executionContext();
  const res = await worker.fetch(new Request(origin + path, { ...rest, headers }), env, ctx);
  await settle();
  return res;
}

/** A state-changing call made the way the app makes it: same origin, X-Hdctl header. */
export function action(env: Env, path: string, body?: unknown): Promise<Response> {
  return call(env, path, {
    method: "POST",
    headers: { "X-Hdctl": "1", Origin: ORIGIN, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Run the cron handler once. */
export async function cron(env: Env): Promise<void> {
  const { ctx, settle } = executionContext();
  await worker.scheduled({ cron: "*/2 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx);
  await settle();
}
