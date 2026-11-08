import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, cron, healthy, testEnv, type TestEnv, type Upstream } from "./helpers/worker";
import { TARGETS, targetById } from "../src/targets";

/**
 * The Status page shows each target's state as probed for that very request.
 * What the cron recorded only adds duration, uptime and history, and can never
 * stand in for the live answer.
 */

interface StatusBody {
  asOf: number;
  targets: { id: string; state: string; code: number | null; detail: string | null; checkedAt: number; since: number | null; changedAfter: number | null; uptime24h: number | null; history: { at: number; state: string }[] }[];
}

const status = async (t: TestEnv) => (await (await call(t.env, "/api/status")).json()) as StatusBody;
const target = (body: StatusBody, id: string) => body.targets.find((x) => x.id === id)!;

/** Every target healthy except `id`, which answers as `outcome` says. */
const allBut = (id: string, outcome: Upstream): Upstream => (t, req) => (t.id === id ? outcome(t, req) : healthy(t, req));
const refused: Upstream = () => {
  throw new TypeError("connection refused");
};
const http = (code: number): Upstream => () => new Response(null, { status: code });

describe("the Status page", () => {
  it("probes every target live, each through its own binding", async () => {
    const t = testEnv();
    const before = Date.now();
    const body = await status(t);
    expect(body.targets).toHaveLength(TARGETS.length);
    expect(t.calls.map((c) => c.target).sort()).toEqual(TARGETS.map((x) => x.id).sort());
    for (const c of t.calls) expect(c.path, c.target).toBe(targetById(c.target)!.check.path);
    expect(body.targets.every((x) => x.state === "up")).toBe(true);
    expect(body.asOf).toBeGreaterThanOrEqual(before);
    expect(Math.min(...body.targets.map((x) => x.checkedAt))).toBeGreaterThanOrEqual(before);
  });

  it("probes again on every request", async () => {
    const t = testEnv();
    await status(t);
    await status(t);
    expect(t.calls).toHaveLength(2 * TARGETS.length);
  });

  it("shows a target that just went down as down, though the last recorded check said up", async () => {
    const t = testEnv();
    await cron(t.env);
    const [recorded] = t.d1.query<{ checked_at: number }>("SELECT checked_at FROM target_state WHERE target_id = 'harbor'");
    t.setUpstream(allBut("harbor", refused));
    expect(target(await status(t), "harbor")).toMatchObject({
      state: "down",
      code: null,
      detail: "connection refused",
      since: null,
      changedAfter: recorded!.checked_at,
    });
  });

  it("shows a target that just came back as up, though the last recorded check said down", async () => {
    const t = testEnv({ upstream: allBut("harbor", http(502)) });
    await cron(t.env);
    t.setUpstream(healthy);
    expect(target(await status(t), "harbor")).toMatchObject({ state: "up", code: 200, since: null });
  });

  it("reports a probe that times out as down", async () => {
    const t = testEnv({
      upstream: allBut("immich", () => {
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      }),
    });
    expect(target(await status(t), "immich")).toMatchObject({ state: "down", detail: "no answer in 8s" });
  });

  it("claims no duration, uptime or history before the cron has recorded any", async () => {
    const t = testEnv();
    expect(target(await status(t), "pve")).toMatchObject({ state: "up", since: null, changedAfter: null, uptime24h: null, history: [] });
  });

  it("says when a target is still answering but not as expected", async () => {
    const t = testEnv({ upstream: allBut("paperless", http(404)) });
    expect(target(await status(t), "paperless")).toMatchObject({ state: "degraded", code: 404, detail: "HTTP 404, expected 200/301/302" });
  });
});

describe("the cron", () => {
  const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
  const MIN = 60_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  const stateOf = (t: TestEnv, id: string) => t.d1.query("SELECT state, since, checked_at, code FROM target_state WHERE target_id = ?1", id)[0];

  it("records every target, and keeps 'since' until the state changes", async () => {
    const t = testEnv();
    await cron(t.env);
    vi.setSystemTime(T0 + 2 * MIN);
    await cron(t.env);
    expect(stateOf(t, "harbor")).toEqual({ state: "up", since: T0, checked_at: T0 + 2 * MIN, code: 200 });

    t.setUpstream(allBut("harbor", http(502)));
    vi.setSystemTime(T0 + 4 * MIN);
    await cron(t.env);
    expect(stateOf(t, "harbor")).toEqual({ state: "down", since: T0 + 4 * MIN, checked_at: T0 + 4 * MIN, code: 502 });
    expect(stateOf(t, "pve")).toMatchObject({ state: "up", since: T0 });
    expect(t.d1.query("SELECT COUNT(*) AS n FROM checks")).toEqual([{ n: 3 * TARGETS.length }]);
  });

  it("feeds the duration, 24 h uptime and history shown beside the live state", async () => {
    const t = testEnv();
    await cron(t.env);
    t.setUpstream(allBut("harbor", http(502)));
    vi.setSystemTime(T0 + 2 * MIN);
    await cron(t.env);
    t.setUpstream(healthy);
    vi.setSystemTime(T0 + 4 * MIN);
    await cron(t.env);

    vi.setSystemTime(T0 + 5 * MIN);
    const harbor = target(await status(t), "harbor");
    expect(harbor).toMatchObject({ state: "up", since: T0 + 4 * MIN, changedAfter: null });
    expect(harbor.uptime24h).toBeCloseTo(2 / 3);
    expect(harbor.history.map((h) => h.state)).toEqual(["up", "down", "up"]);
  });

  it("drops checks older than seven days", async () => {
    const t = testEnv();
    await cron(t.env);
    vi.setSystemTime(T0 + 8 * 24 * 60 * MIN);
    await cron(t.env);
    expect(t.d1.query("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM checks")).toEqual([{ n: TARGETS.length, oldest: T0 + 8 * 24 * 60 * MIN }]);
  });
});
