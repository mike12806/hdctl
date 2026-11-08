import { afterEach, beforeEach, vi } from "vitest";

// The Worker logs every refused request and every cron run; keep test output to the results.
beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
