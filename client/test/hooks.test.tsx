import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "../src/hooks";
import { IDLE_AFTER_MS } from "../src/idle";

// Polled every 30 s, so anything older than 65 s (two intervals + 5 s) is withheld.
const INTERVAL = 30_000;

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (v: DocumentVisibilityState) =>
  act(() => {
    visibility = v;
    document.dispatchEvent(new Event("visibilitychange"));
  });

/** Let `ms` pass on the fake clock, running timers and settling promises. */
const pass = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe("usePoll", () => {
  it("loads at once, then again every interval", async () => {
    const load = vi.fn().mockResolvedValueOnce("a").mockResolvedValueOnce("b");
    const { result } = renderHook(() => usePoll(load, INTERVAL));
    expect(result.current).toMatchObject({ data: null, loading: true });
    await pass();
    expect(result.current).toMatchObject({ data: "a", error: null, loading: false, fetchedAt: Date.now() });
    await pass(INTERVAL);
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("b");
  });

  it("clears the data when a refresh fails, instead of leaving the last answer up", async () => {
    const load = vi.fn().mockResolvedValueOnce("a").mockRejectedValueOnce(new Error("tunnel down"));
    const { result } = renderHook(() => usePoll(load, INTERVAL));
    await pass();
    expect(result.current.data).toBe("a");
    await pass(INTERVAL);
    expect(result.current).toMatchObject({ data: null, fetchedAt: null });
    expect((result.current.error as Error).message).toBe("tunnel down");
  });

  it("withholds data that has aged out while a refresh hangs", async () => {
    const load = vi.fn().mockResolvedValueOnce("a").mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePoll(load, INTERVAL));
    await pass();
    await pass(2 * INTERVAL);
    expect(result.current.data).toBe("a"); // 60 s old: still within two intervals
    await pass(6_000);
    expect(result.current).toMatchObject({ data: null, fetchedAt: null, error: null });
  });

  it("never lets a late answer, or a late failure, replace a newer one", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const { result } = renderHook(() => usePoll(load, INTERVAL));
    act(() => void result.current.reload());
    await act(async () => second.resolve("new"));
    await act(async () => first.resolve("old"));
    expect(result.current).toMatchObject({ data: "new", loading: false });

    act(() => void result.current.reload());
    await act(async () => third.reject(new Error("too late to matter")));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("stops polling while the tab is hidden, withholds what it showed, and refreshes on return", async () => {
    const load = vi.fn().mockResolvedValue("x");
    const { result } = renderHook(() => usePoll(load, INTERVAL));
    await pass();
    setVisibility("hidden");
    await pass(5 * INTERVAL);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBeNull();
    setVisibility("visible");
    await pass();
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("x");
  });

  it("pauses after 15 minutes without input, withholds what it showed, and loads fresh on the next input", async () => {
    const load = vi.fn().mockResolvedValue("x");
    const { result } = renderHook(() => usePoll(load, INTERVAL));
    await pass();
    await pass(IDLE_AFTER_MS);
    const callsWhileInUse = load.mock.calls.length;
    // The load at mount, then one per interval before the idle mark (the tick
    // that lands exactly on it doesn't happen: the tab is idle by then).
    expect(callsWhileInUse).toBe(IDLE_AFTER_MS / INTERVAL);
    expect(result.current.paused).toBe(true);

    await pass(10 * INTERVAL);
    expect(load).toHaveBeenCalledTimes(callsWhileInUse); // nothing sent while idle
    expect(result.current.data).toBeNull(); // and nothing shown as if current

    act(() => void window.dispatchEvent(new Event("keydown")));
    await pass();
    expect(result.current.paused).toBe(false);
    expect(load).toHaveBeenCalledTimes(callsWhileInUse + 1); // at once, not at the next interval
    expect(result.current.data).toBe("x");
    await pass(INTERVAL);
    expect(load).toHaveBeenCalledTimes(callsWhileInUse + 2);
  });

  it("keeps polling while someone is using the tab", async () => {
    const load = vi.fn().mockResolvedValue("x");
    const { result } = renderHook(() => usePoll(load, INTERVAL));
    await pass();
    for (let i = 0; i < 4; i++) {
      await pass(IDLE_AFTER_MS - 60_000);
      act(() => void window.dispatchEvent(new Event("pointermove")));
    }
    expect(result.current.paused).toBe(false);
    expect(load).toHaveBeenCalledTimes(1 + (4 * (IDLE_AFTER_MS - 60_000)) / INTERVAL);
  });

  it("counts coming back to the tab as input", async () => {
    const load = vi.fn().mockResolvedValue("x");
    const { result } = renderHook(() => usePoll(load, INTERVAL));
    await pass();
    setVisibility("hidden");
    await pass(IDLE_AFTER_MS + INTERVAL);
    expect(result.current.paused).toBe(true);
    const before = load.mock.calls.length;
    setVisibility("visible");
    await pass();
    expect(result.current.paused).toBe(false);
    expect(load).toHaveBeenCalledTimes(before + 1);
  });
});
