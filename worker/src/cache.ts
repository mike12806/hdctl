/**
 * A KV-backed HTTP cache that never answers with stale data.
 *
 * Every read goes to the origin. When KV holds a copy, the request carries
 * that copy's ETag (If-None-Match):
 *   - 304 Not Modified: the origin has just confirmed the copy is current,
 *     so its body is returned. Nothing was transferred, and for GitHub a 304
 *     doesn't count against the API rate limit.
 *   - 200: the resource changed; the new body is returned and stored.
 *   - anything else: the error is returned as is. A cached copy is never used
 *     as a fallback, because by then nobody has confirmed it.
 *
 * KV is eventually consistent (a write can take up to a minute to be seen
 * everywhere), which can't cause staleness here: an older copy just carries an
 * older ETag, the origin answers 200 with the current body, and it's stored
 * again. The worst case is a wasted cache entry, never a stale page.
 *
 * Only origins that send validators (ETag) can be cached like this. Argo CD
 * and Proxmox don't, so they are always fetched in full.
 */

export interface CachedEntry {
  etag: string;
  body: string;
  contentType: string | null;
  storedAt: number;
}

export interface CachedResponse {
  status: number;
  body: string;
  contentType: string | null;
  /** "revalidated" = KV copy confirmed by a 304; "fetched" = full response from the origin. */
  source: "revalidated" | "fetched";
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// KV values max out at 25 MiB; nothing hdctl caches comes close, but don't try.
const MAX_BODY = 5 * 1024 * 1024;
// Unused entries age out; a used one is rewritten (and its TTL renewed) whenever it changes.
const TTL_SECONDS = 7 * 24 * 3600;

export async function revalidatingFetch(
  kv: KVNamespace,
  key: string,
  url: string,
  init: RequestInit,
  opts: { waitUntil: (p: Promise<unknown>) => void; fetcher?: Fetch },
): Promise<CachedResponse> {
  const fetcher = opts.fetcher ?? fetch;
  const cached = await kv.get<CachedEntry>(key, "json").catch(() => null);

  const headers = new Headers(init.headers);
  if (cached?.etag) headers.set("If-None-Match", cached.etag);
  const res = await fetcher(url, { ...init, headers });

  if (res.status === 304 && cached) {
    await res.body?.cancel();
    return { status: 200, body: cached.body, contentType: cached.contentType, source: "revalidated" };
  }

  const body = await res.text();
  const contentType = res.headers.get("Content-Type");
  const etag = res.headers.get("ETag");
  if (res.status === 200 && etag && body.length <= MAX_BODY) {
    const entry: CachedEntry = { etag, body, contentType, storedAt: Date.now() };
    // Off the response path; a failed write only means the next read fetches in full.
    opts.waitUntil(kv.put(key, JSON.stringify(entry), { expirationTtl: TTL_SECONDS }).catch(() => undefined));
  }
  return { status: res.status, body, contentType, source: "fetched" };
}
