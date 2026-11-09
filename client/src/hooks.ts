import { useCallback, useEffect, useRef, useState } from "react";
import { useIdle } from "./idle";

/**
 * Load something now and every `intervalMs` after, pausing while the tab is
 * hidden and refreshing the moment it's visible again. It also pauses once
 * the tab has been idle (no input for 15 minutes, see idle.ts) and loads
 * fresh data on the next input, so a page left open costs nothing.
 *
 * Never shows stale data:
 *   - a failed refresh clears the data and reports the error, rather than
 *     leaving the last good answer on screen as if it were current;
 *   - data older than `maxAgeMs` (a hidden tab, a sleeping laptop, a hung
 *     request) is withheld until a fresh answer arrives;
 *   - responses that arrive out of order can't overwrite a newer one.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, maxAgeMs = intervalMs * 2 + 5_000) {
  const [result, setResult] = useState<{ data: T | null; fetchedAt: number | null; error: unknown }>({ data: null, fetchedAt: null, error: null });
  const [loading, setLoading] = useState(true);
  const now = useNow(1_000);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const data = await loadRef.current();
      if (mine === seq.current) setResult({ data, fetchedAt: Date.now(), error: null });
    } catch (error) {
      if (mine === seq.current) setResult({ data: null, fetchedAt: null, error });
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  const idle = useIdle();

  // Runs on mount and whenever the tab stops being idle: a fresh load at once,
  // then one every interval while the tab is visible. Nothing while idle.
  useEffect(() => {
    if (idle) return;
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, intervalMs);
    const onVisible = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, intervalMs, idle]);

  const fresh = result.fetchedAt !== null && now - result.fetchedAt <= maxAgeMs;
  return {
    data: fresh ? result.data : null,
    fetchedAt: fresh ? result.fetchedAt : null,
    error: result.error,
    loading,
    reload,
    /** How often it refreshes while in use, for the page's indicator. */
    intervalMs,
    /** True while polling is paused because nobody is using the tab. */
    paused: idle,
  };
}

/** Re-render every `ms` so "3 min ago" labels and freshness checks stay true. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
