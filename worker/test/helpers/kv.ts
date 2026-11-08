import type { CachedEntry } from "../../src/cache";

/** A Map-backed stand-in for the parts of KVNamespace the cache uses. */
export function fakeKv(initial: Record<string, CachedEntry> = {}, opts: { failGet?: boolean } = {}) {
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
