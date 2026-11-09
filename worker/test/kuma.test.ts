import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALIVE_MS, AUTH_RETRY_MS, FLUSH_MS, IDLE_CLOSE_MS, KumaHub, decode, emit, kumaTime, type LiveMessage, type Socketish } from "../src/integrations/kuma";
import { targetById } from "../src/targets";
import { ORIGIN, call, testEnv } from "./helpers/worker";

/**
 * Uptime Kuma, pushed live: hdctl logs in to Kuma's Socket.IO API with a
 * login token, only reads, relays to every tab, and shows nothing once the
 * connection is gone.
 */

const TOKEN = "eyJ.kuma.token";

const MONITORS = {
  1: { id: 1, name: "Argo", pathName: "Apps / Argo", type: "http", url: "https://argo.mfaherty.net", hostname: null, port: null, active: true },
  2: { id: 2, name: "dns9", pathName: "dns9", type: "dns", url: "https://", hostname: "192.168.9.9", port: 53, active: true },
  3: { id: 3, name: "old", pathName: "old", type: "push", url: "https://", hostname: null, port: null, active: false },
};

/** A fake Kuma 2.5.9: answers the handshake, the login and the event list the way Kuma does. */
class FakeKuma implements Socketish {
  sent: string[] = [];
  closed = false;
  private h: { message(d: string): void; closed(): void } | null = null;
  private pinger: ReturnType<typeof setInterval> | undefined;
  constructor(private goodToken = TOKEN, private pings = true) {}

  on(h: { message(d: string): void; closed(): void }) {
    this.h = h;
    this.push('0{"sid":"e1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    // Engine.IO: the server pings every pingInterval.
    if (this.pings) this.pinger = setInterval(() => this.push("2"), 25_000);
  }
  send(frame: string) {
    this.sent.push(frame);
    if (frame === "40") return this.push('40{"sid":"s1"}');
    const p = decode(`4${frame.slice(1)}`);
    if (p.kind !== "event") return;
    if (p.name === "loginByToken") {
      if (p.args[0] !== this.goodToken) return this.push('430[{"ok":false,"msg":"authInvalidToken","msgi18n":true}]');
      // Kuma sends everything from afterLogin() before it acknowledges the login.
      this.event("monitorList", MONITORS);
      this.event("heartbeatList", 1, [
        { id: 10, monitor_id: 1, status: 0, time: "2026-11-09 10:00:00.000", msg: "timeout", ping: null, important: 1 },
        { id: 11, monitor_id: 1, status: 1, time: "2026-11-09 10:01:00.000", msg: "200 - OK", ping: 112, important: 1 },
      ], false);
      this.event("heartbeatList", 2, [{ id: 20, monitor_id: 2, status: 0, time: "2026-11-09 10:01:30.000", msg: "SERVFAIL", ping: null, important: 0 }], false);
      this.event("avgPing", 1, 98.5);
      this.event("uptime", 1, 24, 0.9993);
      this.event("uptime", 1, 720, 0.9871);
      this.event("uptime", 1, "1y", 0.99);
      this.event("certInfo", 1, JSON.stringify({ valid: true, certInfo: { daysRemaining: 9, validTo: "2026-11-18T00:00:00.000Z", raw: "…" } }));
      this.event("notificationList", [{ id: 1, config: "{\"secret\":\"x\"}" }]);
      return this.push('430[{"ok":true}]');
    }
    if (p.name === "monitorImportantHeartbeatListPaged") {
      return this.push(`431${JSON.stringify([{ ok: true, data: [{ monitorID: 1, status: 1, time: "2026-11-09 10:01:00.000", msg: "200 - OK", important: true }, { monitorID: 1, status: 0, time: "2026-11-09 10:00:00.000", msg: "timeout", important: true }] }])}`);
    }
  }
  close() {
    this.closed = true;
    if (this.pinger !== undefined) clearInterval(this.pinger);
  }
  /** What Kuma pushes on its own. */
  event(name: string, ...args: unknown[]) {
    this.push(`42${JSON.stringify([name, ...args])}`);
  }
  push(frame: string) {
    queueMicrotask(() => !this.closed && this.h?.message(frame));
  }
  drop() {
    this.close();
    this.h?.closed();
  }
}

class Viewer implements Socketish {
  got: LiveMessage[] = [];
  private h: { closed(): void } | null = null;
  send(d: string) {
    this.got.push(JSON.parse(d) as LiveMessage);
  }
  close() {}
  on(h: { message(d: string): void; closed(): void }) {
    this.h = h;
  }
  leave() {
    this.h?.closed();
  }
  last() {
    return this.got.at(-1)!;
  }
  ofType<T extends LiveMessage["type"]>(t: T) {
    return this.got.filter((m): m is Extract<LiveMessage, { type: T }> => m.type === t);
  }
}

function hub(token: string | undefined = TOKEN, kuma = () => new FakeKuma()) {
  const conns: FakeKuma[] = [];
  const connect = vi.fn(async () => {
    const k = kuma();
    conns.push(k);
    return k;
  });
  return { hub: new KumaHub({ token, connect }), conns, connect };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("the Kuma target", () => {
  it("is pinned by IP to Kuma on the LAN, and health-checked on an endpoint that needs no login", () => {
    expect(targetById("kuma")).toMatchObject({ address: { ipv4: "192.168.9.7" }, port: 3001, binding: "KUMA", check: { path: "/api/entry-page" } });
  });
});

describe("Socket.IO framing", () => {
  it("reads Engine.IO and Socket.IO packets as Kuma sends them", () => {
    expect(decode('0{"sid":"a","pingInterval":25000,"pingTimeout":20000}')).toEqual({ kind: "open", pingInterval: 25000, pingTimeout: 20000 });
    expect(decode("2")).toEqual({ kind: "ping" });
    expect(decode('40{"sid":"x"}')).toEqual({ kind: "connect" });
    expect(decode('42["avgPing",3,12.5]')).toEqual({ kind: "event", name: "avgPing", args: [3, 12.5] });
    expect(decode('4317[{"ok":true}]')).toEqual({ kind: "ack", id: 17, args: [{ ok: true }] });
    expect(decode('44{"message":"Not authorized"}')).toEqual({ kind: "connect_error", message: "Not authorized" });
    expect(emit(0, "loginByToken", "t")).toBe('420["loginByToken","t"]');
  });

  it("reads Kuma's zone-less UTC times", () => {
    expect(kumaTime("2026-11-09 10:01:00.000")).toBe(Date.UTC(2026, 10, 9, 10, 1));
    expect(kumaTime("2026-11-09T10:01:00.000Z")).toBe(Date.UTC(2026, 10, 9, 10, 1));
    expect(kumaTime(null)).toBeNull();
  });
});

describe("the live hub", () => {
  it("logs in with the token, then sends each tab a snapshot of every monitor and the recent events", async () => {
    const { hub: h, conns } = hub();
    const v = new Viewer();
    h.addViewer(v);
    expect(v.got[0]).toEqual({ type: "connecting" });
    await tick();
    const snap = v.ofType("snapshot")[0]!;
    expect(snap.monitors.map((m) => [m.name, m.status])).toEqual([
      ["dns9", "down"],
      ["old", "paused"],
      ["Apps / Argo", "up"],
    ]);
    expect(snap.monitors.find((m) => m.id === 1)).toEqual({
      id: 1,
      name: "Apps / Argo",
      type: "http",
      target: "https://argo.mfaherty.net",
      status: "up",
      msg: "200 - OK",
      lastBeatAt: Date.UTC(2026, 10, 9, 10, 1),
      pingMs: 112,
      avgPing24hMs: 98.5,
      uptime24h: 0.9993,
      uptime30d: 0.9871,
      cert: { valid: true, daysRemaining: 9, validTo: "2026-11-18T00:00:00.000Z" },
      beats: [
        { at: Date.UTC(2026, 10, 9, 10, 0), status: "down", pingMs: null },
        { at: Date.UTC(2026, 10, 9, 10, 1), status: "up", pingMs: 112 },
      ],
    });
    expect(snap.monitors.find((m) => m.id === 2)!.target).toBe("192.168.9.9:53");
    expect(snap.monitors.find((m) => m.id === 3)!.target).toBeNull();
    expect(snap.incidents.map((i) => [i.monitorId, i.status, i.msg])).toEqual([
      [1, "up", "200 - OK"],
      [1, "down", "timeout"],
    ]);
    // Nothing from Kuma beyond monitors reaches a tab (its notification settings hold secrets).
    expect(JSON.stringify(v.got)).not.toContain("secret");
  });

  it("only ever reads: the handshake, a pong, the login and the event list", async () => {
    const { hub: h, conns } = hub();
    h.addViewer(new Viewer());
    await tick(25_000);
    expect(conns[0]!.sent).toEqual(["40", `420["loginByToken","${TOKEN}"]`, '421["monitorImportantHeartbeatListPaged",null,0,50]', "3"]);
  });

  it("pushes each heartbeat to every tab within a moment, with status changes as events", async () => {
    const { hub: h, conns, connect } = hub();
    const a = new Viewer();
    const b = new Viewer();
    h.addViewer(a);
    await tick();
    h.addViewer(b);
    expect(b.got[0]!.type).toBe("snapshot");
    expect(connect).toHaveBeenCalledTimes(1);

    conns[0]!.event("heartbeat", { monitorID: 2, status: 1, time: "2026-11-09 10:02:00.000", msg: "NOERROR", ping: 4, important: true });
    conns[0]!.event("uptime", 2, 24, 0.5);
    await tick(FLUSH_MS);
    for (const v of [a, b]) {
      const u = v.last() as Extract<LiveMessage, { type: "update" }>;
      expect(u.type).toBe("update");
      expect(u.monitors).toHaveLength(1);
      expect(u.monitors[0]).toMatchObject({ id: 2, status: "up", pingMs: 4, uptime24h: 0.5, msg: "NOERROR" });
      expect(u.incidents).toEqual([{ monitorId: 2, status: "up", at: Date.UTC(2026, 10, 9, 10, 2), msg: "NOERROR" }]);
    }
  });

  it("tells tabs when a monitor is deleted, and keeps a quiet feed visibly alive", async () => {
    const { hub: h, conns } = hub();
    const v = new Viewer();
    h.addViewer(v);
    await tick();
    conns[0]!.event("deleteMonitorFromList", 3);
    await tick(FLUSH_MS);
    expect(v.last()).toMatchObject({ type: "update", removed: [3], monitors: [] });
    await tick(ALIVE_MS);
    expect(v.last().type).toBe("alive");
  });

  it("when Kuma drops, shows every tab the error and no data, then reconnects with a fresh snapshot", async () => {
    const { hub: h, conns, connect } = hub();
    const v = new Viewer();
    h.addViewer(v);
    await tick();
    conns[0]!.drop();
    expect(v.last()).toEqual({ type: "error", error: "Uptime Kuma closed the connection." });
    // A late event from the dead connection changes nothing.
    conns[0]!.event("heartbeat", { monitorID: 1, status: 0, time: "2026-11-09 11:00:00.000", msg: "x", important: true });
    await tick(FLUSH_MS);
    expect(v.last().type).toBe("error");
    await tick(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(v.last().type).toBe("snapshot");
  });

  it("treats a silent Kuma as gone once its own ping deadline passes", async () => {
    const { hub: h, conns } = hub(TOKEN, () => new FakeKuma(TOKEN, false));
    const v = new Viewer();
    h.addViewer(v);
    await tick();
    await tick(45_000);
    expect(v.ofType("error")[0]).toEqual({ type: "error", error: "Uptime Kuma stopped answering." });
    expect(conns[0]!.closed).toBe(true);
  });

  it("reports a refused token with no data, and retries only once a minute", async () => {
    const { hub: h, connect } = hub(TOKEN, () => new FakeKuma("another-token"));
    const v = new Viewer();
    h.addViewer(v);
    await tick();
    expect(v.last()).toMatchObject({ type: "error", error: expect.stringContaining("refused the login token (invalid or revoked)") });
    expect(v.ofType("snapshot")).toHaveLength(0);
    await tick(AUTH_RETRY_MS - 1);
    expect(connect).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("says how to set it up while KUMA_TOKEN is missing, without calling Kuma", async () => {
    const { hub: h, connect } = hub("");
    const v = new Viewer();
    h.addViewer(v);
    await tick();
    expect(v.got).toEqual([{ type: "error", error: expect.stringContaining("KUMA_TOKEN is not set"), setup: true }]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("closes Kuma's connection a minute after the last tab leaves, and not while one is open", async () => {
    const { hub: h, conns, connect } = hub();
    const a = new Viewer();
    h.addViewer(a);
    await tick();
    a.leave();
    await tick(IDLE_CLOSE_MS - 1);
    expect(conns[0]!.closed).toBe(false);
    // A tab coming back inside the minute reuses the connection.
    const b = new Viewer();
    h.addViewer(b);
    expect(b.got[0]!.type).toBe("snapshot");
    b.leave();
    await tick(IDLE_CLOSE_MS);
    expect(conns[0]!.closed).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    // Nothing reconnects with no one watching.
    await tick(10 * 60_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/kuma/live", () => {
  const liveNs = () => {
    const forwarded: Request[] = [];
    return {
      forwarded,
      ns: { getByName: (name: string) => ({ fetch: async (req: Request) => (forwarded.push(req), new Response(`relayed to ${name}`)) }) },
    };
  };

  it("hands a same-origin WebSocket upgrade, after the Access check, to the one KumaLive object", async () => {
    const { ns, forwarded } = liveNs();
    const t = testEnv({ vars: { KUMA_LIVE: ns as never } });
    const res = await call(t.env, "/api/kuma/live", { headers: { Upgrade: "websocket", Origin: ORIGIN } });
    expect(await res.text()).toBe("relayed to kuma");
    expect(forwarded).toHaveLength(1);
  });

  it("refuses a WebSocket opened from another site, a plain GET, and a request without Access", async () => {
    const { ns, forwarded } = liveNs();
    const t = testEnv({ vars: { KUMA_LIVE: ns as never } });
    expect((await call(t.env, "/api/kuma/live", { headers: { Upgrade: "websocket", Origin: "https://evil.example" } })).status).toBe(403);
    expect((await call(t.env, "/api/kuma/live", { headers: { Upgrade: "websocket" } })).status).toBe(403);
    expect((await call(t.env, "/api/kuma/live")).status).toBe(426);
    expect((await call(t.env, "/api/kuma/live", { token: null, headers: { Upgrade: "websocket", Origin: ORIGIN } })).status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });
});
