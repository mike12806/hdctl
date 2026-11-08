import { describe, expect, it } from "vitest";
import { revalidatingFetch, type CachedEntry } from "../src/cache";

/** A Map-backed stand-in for the parts of KVNamespace the cache uses. */
function fakeKv(initial: Record<string, CachedEntry> = {}, opts: { failGet?: boolean } = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const kv = {
    async get(key: string) {
      if (opts.failGet) throw new Error("kv down");
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function harness() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), settle: () => Promise.all(pending) };
}

const entry = (etag: string, body: string): CachedEntry => ({ etag, body, contentType: "application/json", storedAt: 1 });

/** An origin that records the If-None-Match it was sent and answers as told. */
function origin(answer: (ifNoneMatch: string | null) => Response | Promise<Response>) {
  const seen: (string | null)[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const inm = new Headers(init?.headers).get("If-None-Match");
    seen.push(inm);
    return answer(inm);
  };
  return { fetcher, seen };
}

const ok = (body: string, etag?: string) =>
  new Response(body, { status: 200, headers: { "Content-Type": "application/json", ...(etag ? { ETag: etag } : {}) } });

describe("revalidatingFetch", () => {
  it("on a miss, fetches in full and stores the response with its ETag", async () => {
    const { kv, store } = fakeKv();
    const h = harness();
    const o = origin(() => ok('{"v":1}', '"e1"'));
    const r = await revalidatingFetch(kv, "k", "https://x", {}, { waitUntil: h.waitUntil, fetcher: o.fetcher });
    await h.settle();
    expect(r).toMatchObject({ status: 200, body: '{"v":1}', source: "fetched" });
    expect(o.seen).toEqual([null]);
    expect(JSON.parse(store.get("k")!)).toMatchObject({ etag: '"e1"', body: '{"v":1}' });
  });

  it("uses the cached body only when the origin confirms it with 304", async () => {
    const { kv } = fakeKv({ k: entry('"e1"', '{"v":1}') });
    const o = origin((inm) => (inm === '"e1"' ? new Response(null, { status: 304 }) : ok('{"v":2}', '"e2"')));
    const r = await revalidatingFetch(kv, "k", "https://x", {}, { waitUntil: () => {}, fetcher: o.fetcher });
    expect(o.seen).toEqual(['"e1"']);
    expect(r).toMatchObject({ status: 200, body: '{"v":1}', source: "revalidated" });
  });

  it("returns the new body when the resource changed, and replaces the entry", async () => {
    const { kv, store } = fakeKv({ k: entry('"old"', '{"v":1}') });
    const h = harness();
    // An older copy (e.g. KV not yet consistent) carries an older ETag, so the origin sends the current body.
    const o = origin(() => ok('{"v":2}', '"new"'));
    const r = await revalidatingFetch(kv, "k", "https://x", {}, { waitUntil: h.waitUntil, fetcher: o.fetcher });
    await h.settle();
    expect(r).toMatchObject({ status: 200, body: '{"v":2}', source: "fetched" });
    expect(JSON.parse(store.get("k")!)).toMatchObject({ etag: '"new"', body: '{"v":2}' });
  });

  it("never falls back to the cache when the origin is unreachable", async () => {
    const { kv } = fakeKv({ k: entry('"e1"', '{"v":"cached"}') });
    const o = origin(() => {
      throw new TypeError("fetch failed");
    });
    await expect(revalidatingFetch(kv, "k", "https://x", {}, { waitUntil: () => {}, fetcher: o.fetcher })).rejects.toThrow("fetch failed");
  });

  it("never falls back to the cache when the origin answers with an error", async () => {
    const { kv, store } = fakeKv({ k: entry('"e1"', '{"v":"cached"}') });
    const h = harness();
    const o = origin(() => new Response("upstream down", { status: 503 }));
    const r = await revalidatingFetch(kv, "k", "https://x", {}, { waitUntil: h.waitUntil, fetcher: o.fetcher });
    await h.settle();
    expect(r).toMatchObject({ status: 503, body: "upstream down", source: "fetched" });
    expect(JSON.parse(store.get("k")!).body).toBe('{"v":"cached"}'); // the error isn't cached either
  });

  it("does not store responses without an ETag", async () => {
    const { kv, store } = fakeKv();
    const h = harness();
    const r = await revalidatingFetch(kv, "k", "https://x", {}, { waitUntil: h.waitUntil, fetcher: origin(() => ok("plain")).fetcher });
    await h.settle();
    expect(r.body).toBe("plain");
    expect(store.has("k")).toBe(false);
  });

  it("treats an unreadable KV as a miss rather than failing the request", async () => {
    const { kv } = fakeKv({}, { failGet: true });
    const o = origin(() => ok("fresh", '"e"'));
    const r = await revalidatingFetch(kv, "k", "https://x", {}, { waitUntil: () => {}, fetcher: o.fetcher });
    expect(o.seen).toEqual([null]);
    expect(r).toMatchObject({ status: 200, body: "fresh", source: "fetched" });
  });
});
