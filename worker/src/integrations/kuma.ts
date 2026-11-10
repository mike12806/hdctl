import type { Env } from "../env";
import { targetById, targetWebSocket } from "../targets";

/**
 * Uptime Kuma, live, from Kuma itself: its Socket.IO API (the one Kuma's own
 * web UI uses), through the hdctl-kuma VPC Service.
 *
 * One Durable Object (KumaLive) holds a single connection to Kuma while at
 * least one hdctl tab is watching, and relays it to every open tab over a
 * WebSocket. Kuma pushes each heartbeat as it happens, so a monitor's change
 * shows within about a second. With no one watching, the connection closes
 * a minute later and nothing runs.
 *
 * Kuma 2.x only lets an API key read /metrics. Its Socket.IO API needs a
 * login, so hdctl holds a Kuma login token (KUMA_TOKEN: the JWT Kuma's web
 * UI keeps after sign-in). It never expires on its own; changing the Kuma
 * password revokes it. hdctl only reads with it: the only calls it sends are
 * loginByToken and monitorImportantHeartbeatListPaged.
 *
 * Nothing is kept beyond the connection: when it drops, every tab is told,
 * shows the error and no data, and gets a fresh snapshot once it's back.
 */

const KUMA = targetById("kuma")!;

export type MonitorStatus = "up" | "down" | "pending" | "maintenance" | "paused" | "unknown";

/** Kuma's heartbeat status codes. */
const STATUS: Record<number, MonitorStatus> = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };

export interface Beat {
  /** When Kuma checked, epoch ms. */
  at: number;
  status: MonitorStatus;
  pingMs: number | null;
}

export interface Cert {
  valid: boolean;
  daysRemaining: number | null;
  validTo: string | null;
}

export interface LiveMonitor {
  id: number;
  /** Kuma's path name: "Group / Monitor" for a monitor in a group. */
  name: string;
  type: string | null;
  /** What it checks: the URL, or host[:port]. */
  target: string | null;
  status: MonitorStatus;
  /** The latest heartbeat's message (an error, or "200 - OK"). */
  msg: string | null;
  lastBeatAt: number | null;
  pingMs: number | null;
  avgPing24hMs: number | null;
  /** Fractions, 0 to 1, as Kuma computes them. */
  uptime24h: number | null;
  uptime30d: number | null;
  cert: Cert | null;
  /** The most recent heartbeats, oldest first. */
  beats: Beat[];
}

/** A status change, which Kuma calls an important heartbeat. */
export interface Incident {
  monitorId: number;
  status: MonitorStatus;
  at: number;
  msg: string;
}

/** What hdctl sends each open tab. */
export type LiveMessage =
  | { type: "connecting" }
  | { type: "snapshot"; asOf: number; monitors: LiveMonitor[]; incidents: Incident[] }
  | { type: "update"; asOf: number; monitors: LiveMonitor[]; removed: number[]; incidents: Incident[] }
  /** Sent while nothing changes, so a tab can tell a quiet feed from a dead one. */
  | { type: "alive"; asOf: number }
  | { type: "error"; error: string; setup?: boolean };

/** Heartbeats kept per monitor (Kuma sends its last 100 on login). */
export const BEATS_KEPT = 60;
export const INCIDENTS_KEPT = 50;

// --- Socket.IO v4 over Engine.IO v4, only as much as Kuma uses ---------------------

export type Packet =
  | { kind: "open"; pingInterval: number; pingTimeout: number }
  | { kind: "ping" }
  | { kind: "close" }
  | { kind: "connect" }
  | { kind: "connect_error"; message: string }
  | { kind: "disconnect" }
  | { kind: "event"; name: string; args: unknown[] }
  | { kind: "ack"; id: number; args: unknown[] }
  | { kind: "other" };

export function decode(frame: string): Packet {
  switch (frame[0]) {
    case "0": {
      const o = JSON.parse(frame.slice(1)) as { pingInterval?: number; pingTimeout?: number };
      return { kind: "open", pingInterval: o.pingInterval ?? 25_000, pingTimeout: o.pingTimeout ?? 20_000 };
    }
    case "1":
      return { kind: "close" };
    case "2":
      return { kind: "ping" };
    case "4":
      break;
    default:
      return { kind: "other" };
  }
  // Engine.IO message: a Socket.IO packet. Kuma uses only the default namespace.
  const type = frame[1];
  let i = 2;
  let id = "";
  while (i < frame.length && frame[i]! >= "0" && frame[i]! <= "9") id += frame[i++];
  const payload: unknown = i < frame.length ? JSON.parse(frame.slice(i)) : undefined;
  switch (type) {
    case "0":
      return { kind: "connect" };
    case "1":
      return { kind: "disconnect" };
    case "2": {
      const [name, ...args] = Array.isArray(payload) ? payload : [];
      return typeof name === "string" ? { kind: "event", name, args } : { kind: "other" };
    }
    case "3":
      return { kind: "ack", id: Number(id), args: Array.isArray(payload) ? payload : [] };
    case "4":
      return { kind: "connect_error", message: String((payload as { message?: unknown } | undefined)?.message ?? "refused") };
    default:
      return { kind: "other" };
  }
}

/** An event with an acknowledgement id, as Socket.IO frames it. */
export const emit = (id: number, name: string, ...args: unknown[]) => `42${id}${JSON.stringify([name, ...args])}`;

// --- What Kuma sends, kept as hdctl shows it ------------------------------------------

interface RawMonitor {
  id: number;
  name?: string;
  pathName?: string;
  type?: string;
  url?: string | null;
  hostname?: string | null;
  port?: number | string | null;
  active?: boolean | number;
}

interface NormalBeat extends Beat {
  msg: string;
  important: boolean;
}

/** Kuma stores times as UTC "YYYY-MM-DD HH:mm:ss.SSS", without a zone. */
export function kumaTime(t: unknown): number | null {
  if (typeof t !== "string" || !t) return null;
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(t);
  const ms = Date.parse(zoned ? t : `${t.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** A heartbeat in either of Kuma's shapes: a database row (heartbeatList) or a live one (heartbeat). */
function normalBeat(b: Record<string, unknown>): { monitorId: number; beat: NormalBeat } | null {
  const monitorId = Number(b.monitorID ?? b.monitor_id);
  const at = kumaTime(b.time);
  if (!Number.isFinite(monitorId) || at === null) return null;
  const ping = typeof b.ping === "number" && b.ping >= 0 ? b.ping : null;
  return {
    monitorId,
    beat: { at, status: STATUS[Number(b.status)] ?? "unknown", pingMs: ping, msg: typeof b.msg === "string" ? b.msg : "", important: b.important === true || b.important === 1 },
  };
}

function targetOf(m: RawMonitor): string | null {
  const url = typeof m.url === "string" ? m.url.trim() : "";
  // New monitors start with url "https://" whatever their type; that isn't a target.
  if (url && !/^https?:\/\/$/.test(url)) {
    try {
      if (new URL(url).host) return url;
    } catch {
      // not a URL: fall through to host:port
    }
  }
  const host = typeof m.hostname === "string" && m.hostname ? m.hostname : null;
  if (!host) return null;
  return m.port !== null && m.port !== undefined && m.port !== "" ? `${host}:${m.port}` : host;
}

const RANK: Record<MonitorStatus, number> = { down: 0, pending: 1, unknown: 2, maintenance: 3, paused: 4, up: 5 };
export const byAttention = (a: LiveMonitor, b: LiveMonitor) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name);

export interface Changes {
  monitors: Set<number>;
  removed: Set<number>;
  incidents: Incident[];
}

/** Kuma's state, as built from its events. Lives only as long as one connection. */
export class KumaState {
  private monitors = new Map<number, RawMonitor>();
  private beats = new Map<number, NormalBeat[]>();
  private avgPing = new Map<number, number | null>();
  private uptime = new Map<number, { d1: number | null; d30: number | null }>();
  private certs = new Map<number, Cert | null>();
  incidents: Incident[] = [];

  /** Apply one Kuma event. Unknown events (settings, notifications, ...) are ignored. */
  apply(name: string, args: unknown[], changes: Changes): void {
    const id = (v: unknown) => Number(v);
    const touch = (m: number) => {
      changes.monitors.add(m);
      changes.removed.delete(m);
    };
    switch (name) {
      case "monitorList": {
        const list = (args[0] ?? {}) as Record<string, RawMonitor>;
        for (const old of this.monitors.keys()) if (!(String(old) in list)) this.remove(old, changes);
        for (const m of Object.values(list)) {
          this.monitors.set(id(m.id), m);
          touch(id(m.id));
        }
        return;
      }
      case "updateMonitorIntoList": {
        for (const m of Object.values((args[0] ?? {}) as Record<string, RawMonitor>)) {
          this.monitors.set(id(m.id), m);
          touch(id(m.id));
        }
        return;
      }
      case "deleteMonitorFromList":
        this.remove(id(args[0]), changes);
        return;
      case "heartbeatList": {
        const m = id(args[0]);
        const overwrite = args[2] === true;
        const rows = Array.isArray(args[1]) ? (args[1] as Record<string, unknown>[]) : [];
        const beats = rows.map((r) => normalBeat({ monitor_id: m, ...r })?.beat).filter((b): b is NormalBeat => !!b);
        const merged = overwrite ? beats : [...(this.beats.get(m) ?? []), ...beats];
        this.beats.set(m, merged.sort((a, b) => a.at - b.at).slice(-BEATS_KEPT));
        touch(m);
        return;
      }
      case "heartbeat": {
        const n = normalBeat((args[0] ?? {}) as Record<string, unknown>);
        if (!n) return;
        const list = this.beats.get(n.monitorId) ?? [];
        list.push(n.beat);
        this.beats.set(n.monitorId, list.slice(-BEATS_KEPT));
        if (n.beat.important) {
          const inc: Incident = { monitorId: n.monitorId, status: n.beat.status, at: n.beat.at, msg: n.beat.msg };
          this.incidents = [inc, ...this.incidents].slice(0, INCIDENTS_KEPT);
          changes.incidents.push(inc);
        }
        touch(n.monitorId);
        return;
      }
      case "avgPing": {
        const v = args[1];
        this.avgPing.set(id(args[0]), typeof v === "number" ? v : null);
        touch(id(args[0]));
        return;
      }
      case "uptime": {
        const m = id(args[0]);
        const v = typeof args[2] === "number" ? args[2] : null;
        const u = this.uptime.get(m) ?? { d1: null, d30: null };
        if (String(args[1]) === "24") u.d1 = v;
        else if (String(args[1]) === "720") u.d30 = v;
        else return;
        this.uptime.set(m, u);
        touch(m);
        return;
      }
      case "certInfo": {
        const m = id(args[0]);
        let cert: Cert | null = null;
        try {
          const info = (typeof args[1] === "string" ? JSON.parse(args[1]) : args[1]) as { valid?: boolean; certInfo?: { daysRemaining?: number; validTo?: string } } | null;
          if (info && typeof info.valid === "boolean") {
            cert = { valid: info.valid, daysRemaining: typeof info.certInfo?.daysRemaining === "number" ? info.certInfo.daysRemaining : null, validTo: info.certInfo?.validTo ?? null };
          }
        } catch {
          cert = null;
        }
        this.certs.set(m, cert);
        touch(m);
        return;
      }
    }
  }

  /** The answer to monitorImportantHeartbeatListPaged: the latest status changes, newest first. */
  setIncidents(rows: unknown): void {
    this.incidents = (Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [])
      .map(normalBeat)
      .filter((n): n is { monitorId: number; beat: NormalBeat } => !!n)
      .map(({ monitorId, beat }) => ({ monitorId, status: beat.status, at: beat.at, msg: beat.msg }))
      .sort((a, b) => b.at - a.at)
      .slice(0, INCIDENTS_KEPT);
  }

  private remove(m: number, changes: Changes) {
    for (const map of [this.monitors, this.beats, this.avgPing, this.uptime, this.certs]) map.delete(m);
    changes.monitors.delete(m);
    changes.removed.add(m);
  }

  view(m: number): LiveMonitor | null {
    const raw = this.monitors.get(m);
    if (!raw) return null;
    const beats = this.beats.get(m) ?? [];
    const last = beats.at(-1);
    const active = raw.active !== false && raw.active !== 0;
    const u = this.uptime.get(m);
    return {
      id: m,
      name: raw.pathName || raw.name || `monitor ${m}`,
      type: raw.type ?? null,
      target: targetOf(raw),
      status: !active ? "paused" : (last?.status ?? "unknown"),
      msg: last?.msg || null,
      lastBeatAt: last?.at ?? null,
      pingMs: last?.pingMs ?? null,
      avgPing24hMs: this.avgPing.get(m) ?? null,
      uptime24h: u?.d1 ?? null,
      uptime30d: u?.d30 ?? null,
      cert: this.certs.get(m) ?? null,
      beats: beats.map(({ at, status, pingMs }) => ({ at, status, pingMs })),
    };
  }

  all(): LiveMonitor[] {
    return [...this.monitors.keys()].map((m) => this.view(m)!).sort(byAttention);
  }
}

// --- The hub: one Kuma connection, many tabs -------------------------------------------

/** The little of a WebSocket the hub uses, so tests can drive it without a runtime. */
export interface Socketish {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(handlers: { message(data: string): void; closed(): void }): void;
}

export interface HubOptions {
  token: string | undefined;
  connect: () => Promise<Socketish>;
}

/** How long the Kuma connection stays open after the last tab closes. */
export const IDLE_CLOSE_MS = 60_000;
export const CONNECT_TIMEOUT_MS = 30_000;
export const FLUSH_MS = 250;
export const ALIVE_MS = 20_000;
/** After Kuma refuses the token, retry only this often (Kuma rate-limits logins). */
export const AUTH_RETRY_MS = 60_000;
const ACK_LOGIN = 0;
const ACK_INCIDENTS = 1;

const SETUP =
  "KUMA_TOKEN is not set. Sign in to Uptime Kuma, run localStorage.getItem(\"token\") in the browser console, and store the result at Vault kv/github/hdctl/kuma as KUMA_TOKEN.";

type Failure = { error: string; setup?: boolean; auth?: boolean };

export class KumaHub {
  private viewers = new Set<Socketish>();
  private phase: "idle" | "connecting" | "ready" | "failed" = "idle";
  private gen = 0;
  private socket: Socketish | null = null;
  private state: KumaState | null = null;
  private failure: Failure | null = null;
  private attempts = 0;
  private pending: Changes = { monitors: new Set(), removed: new Set(), incidents: [] };
  private timers: Partial<Record<"idle" | "retry" | "connect" | "watchdog" | "flush" | "alive", ReturnType<typeof setTimeout>>> = {};
  private watchdogMs = 45_000;

  constructor(private opts: HubOptions) {}

  get viewerCount() {
    return this.viewers.size;
  }

  addViewer(ws: Socketish): void {
    this.viewers.add(ws);
    ws.on({ message: () => {}, closed: () => this.removeViewer(ws) });
    this.clear("idle");
    if (!this.opts.token) return this.send(ws, { type: "error", error: SETUP, setup: true });
    if (this.phase === "ready" && this.state) this.send(ws, { type: "snapshot", asOf: Date.now(), monitors: this.state.all(), incidents: this.state.incidents });
    else if (this.phase === "failed" && this.failure) this.send(ws, { type: "error", error: this.failure.error });
    else this.send(ws, { type: "connecting" });
    if (this.phase === "idle") void this.start();
  }

  private removeViewer(ws: Socketish): void {
    if (!this.viewers.delete(ws) || this.viewers.size) return;
    this.timers.idle = setTimeout(() => this.stop(), IDLE_CLOSE_MS);
  }

  private async start(): Promise<void> {
    const gen = ++this.gen;
    this.phase = "connecting";
    this.state = new KumaState();
    this.clear("retry");
    this.timers.connect = setTimeout(() => this.fail(gen, { error: "Uptime Kuma didn't finish connecting within 30 s." }), CONNECT_TIMEOUT_MS);
    let socket: Socketish;
    try {
      socket = await this.opts.connect();
    } catch (e) {
      return this.fail(gen, { error: `Couldn't open a WebSocket to Uptime Kuma: ${e instanceof Error ? e.message : String(e)}` });
    }
    if (gen !== this.gen) return socket.close(1000, "superseded");
    this.socket = socket;
    socket.on({
      message: (data) => this.onFrame(gen, data),
      closed: () => this.fail(gen, { error: "Uptime Kuma closed the connection." }),
    });
  }

  private onFrame(gen: number, frame: string): void {
    if (gen !== this.gen || !this.state) return;
    this.armWatchdog(gen);
    let p: Packet;
    try {
      p = decode(frame);
    } catch {
      return; // a frame we can't read is skipped, not fatal
    }
    switch (p.kind) {
      case "open":
        this.watchdogMs = p.pingInterval + p.pingTimeout;
        this.armWatchdog(gen);
        return this.socket?.send("40");
      case "ping":
        return this.socket?.send("3");
      case "connect":
        return this.socket?.send(emit(ACK_LOGIN, "loginByToken", this.opts.token));
      case "connect_error":
        return this.fail(gen, { error: `Uptime Kuma refused the connection: ${p.message}` });
      case "close":
      case "disconnect":
        return this.fail(gen, { error: "Uptime Kuma closed the connection." });
      case "event":
        this.state.apply(p.name, p.args, this.pending);
        if (this.phase === "ready") this.scheduleFlush();
        return;
      case "ack": {
        const res = (p.args[0] ?? {}) as { ok?: boolean; msg?: string; data?: unknown };
        if (p.id === ACK_LOGIN) {
          if (!res.ok) return this.fail(gen, { error: `Uptime Kuma refused the login token (${res.msg === "authInvalidToken" ? "invalid or revoked" : (res.msg ?? "no reason given")}). A Kuma password change revokes it; store a new one.`, auth: true });
          // Kuma sends the monitors, their last heartbeats and stats before it acknowledges the login.
          return this.socket?.send(emit(ACK_INCIDENTS, "monitorImportantHeartbeatListPaged", null, 0, INCIDENTS_KEPT));
        }
        if (p.id === ACK_INCIDENTS) {
          if (!res.ok) return this.fail(gen, { error: `Uptime Kuma wouldn't list recent events: ${res.msg ?? "no reason given"}` });
          this.state.setIncidents(res.data);
          return this.ready();
        }
        return;
      }
    }
  }

  private ready(): void {
    this.phase = "ready";
    this.failure = null;
    this.attempts = 0;
    this.clear("connect");
    this.pending = { monitors: new Set(), removed: new Set(), incidents: [] };
    this.broadcast({ type: "snapshot", asOf: Date.now(), monitors: this.state!.all(), incidents: this.state!.incidents });
    this.armAlive();
  }

  private scheduleFlush(): void {
    this.timers.flush ??= setTimeout(() => {
      delete this.timers.flush;
      const state = this.state;
      if (this.phase !== "ready" || !state) return;
      const { monitors, removed, incidents } = this.pending;
      this.pending = { monitors: new Set(), removed: new Set(), incidents: [] };
      const views = [...monitors].map((m) => state.view(m)).filter((v): v is LiveMonitor => !!v);
      if (!views.length && !removed.size && !incidents.length) return;
      this.broadcast({ type: "update", asOf: Date.now(), monitors: views, removed: [...removed], incidents });
      this.armAlive();
    }, FLUSH_MS);
  }

  private armAlive(): void {
    this.clear("alive");
    this.timers.alive = setTimeout(() => {
      if (this.phase !== "ready") return;
      this.broadcast({ type: "alive", asOf: Date.now() });
      this.armAlive();
    }, ALIVE_MS);
  }

  private armWatchdog(gen: number): void {
    this.clear("watchdog");
    this.timers.watchdog = setTimeout(() => this.fail(gen, { error: "Uptime Kuma stopped answering." }), this.watchdogMs);
  }

  private fail(gen: number, f: Failure): void {
    if (gen !== this.gen) return;
    this.gen++;
    this.teardown();
    this.phase = "failed";
    this.failure = f;
    this.broadcast({ type: "error", error: f.error });
    if (!this.viewers.size) {
      this.phase = "idle";
      return;
    }
    const delay = f.auth ? AUTH_RETRY_MS : Math.min(1_000 * 2 ** this.attempts++, 30_000);
    this.timers.retry = setTimeout(() => void this.start(), delay);
  }

  private stop(): void {
    this.gen++;
    this.teardown();
    this.clear("retry");
    this.phase = "idle";
    this.failure = null;
    this.attempts = 0;
  }

  /** Close the Kuma connection and forget everything it said. */
  private teardown(): void {
    for (const t of ["connect", "watchdog", "flush", "alive"] as const) this.clear(t);
    const s = this.socket;
    this.socket = null;
    this.state = null;
    this.pending = { monitors: new Set(), removed: new Set(), incidents: [] };
    try {
      s?.close(1000, "done");
    } catch {
      // already closed
    }
  }

  private clear(t: keyof KumaHub["timers"]): void {
    if (this.timers[t] !== undefined) clearTimeout(this.timers[t]);
    delete this.timers[t];
  }

  private broadcast(msg: LiveMessage): void {
    for (const ws of this.viewers) this.send(ws, msg);
  }

  private send(ws: Socketish, msg: LiveMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.removeViewer(ws);
    }
  }
}

// --- The Durable Object, and the Worker's side of it -----------------------------------

function wrap(ws: WebSocket): Socketish {
  return {
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    on: (h) => {
      ws.addEventListener("message", (e) => typeof e.data === "string" && h.message(e.data));
      ws.addEventListener("close", () => h.closed());
      ws.addEventListener("error", () => h.closed());
    },
  };
}

async function connectKuma(env: Env): Promise<Socketish> {
  const res = await targetWebSocket(env, KUMA, "/socket.io/?EIO=4&transport=websocket");
  const ws = res.webSocket;
  if (!ws) throw new Error(`no upgrade (HTTP ${res.status})`);
  ws.accept();
  return wrap(ws);
}

/**
 * The single instance ("kuma") that holds Kuma's connection. Tabs connect to
 * it through GET /api/kuma/live, after the Worker has checked Access.
 */
export class KumaLive implements DurableObject {
  private hub: KumaHub;

  constructor(_state: DurableObjectState, env: Env) {
    this.hub = new KumaHub({ token: env.KUMA_TOKEN, connect: () => connectKuma(env) });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    this.hub.addViewer(wrap(server));
    return new Response(null, { status: 101, webSocket: client });
  }
}
