import { useSyncExternalStore } from "react";
import type { Incident, LiveMessage, LiveMonitor, MonitorStatus } from "./api";

/**
 * Uptime Kuma, live: one WebSocket to /api/kuma/live, shared by everything on
 * the page that shows Kuma (the Uptime page, the Status page's summary).
 *
 * Kuma pushes each heartbeat; hdctl relays it here within about a second.
 * Never shows stale data: when the feed drops, or goes quiet for longer than
 * hdctl's keep-alive allows, the monitors are cleared and the error shown
 * until a fresh snapshot arrives.
 */

export interface KumaLive {
  phase: "connecting" | "live" | "error";
  error: string | null;
  setup: boolean;
  /** Most urgent first. Null unless the feed is live. */
  monitors: LiveMonitor[] | null;
  /** Status changes, newest first. */
  incidents: Incident[];
  /** When hdctl last confirmed the feed is current. */
  asOf: number | null;
}

const RANK: Record<MonitorStatus, number> = { down: 0, pending: 1, unknown: 2, maintenance: 3, paused: 4, up: 5 };
const byAttention = (a: LiveMonitor, b: LiveMonitor) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name);

const INCIDENTS_KEPT = 50;
/** Keep the socket open this long after the last component lets go (moving between pages). */
const CLOSE_AFTER_MS = 10_000;
/** hdctl says "alive" every 20 s; this much silence means the connection is dead. */
export const SILENT_MS = 50_000;

const NOT_LIVE: Pick<KumaLive, "monitors" | "incidents" | "asOf"> = { monitors: null, incidents: [], asOf: null };
const INITIAL: KumaLive = { phase: "connecting", error: null, setup: false, ...NOT_LIVE };

let state: KumaLive = INITIAL;
const listeners = new Set<() => void>();
const monitors = new Map<number, LiveMonitor>();
let ws: WebSocket | null = null;
let attempts = 0;
const timers: Partial<Record<"retry" | "close" | "silent", ReturnType<typeof setTimeout>>> = {};

function clear(t: keyof typeof timers) {
  if (timers[t] !== undefined) clearTimeout(timers[t]);
  delete timers[t];
}

function set(next: Partial<KumaLive>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function sorted() {
  return [...monitors.values()].sort(byAttention);
}

function open() {
  clear("retry");
  monitors.clear();
  set({ phase: "connecting", error: null, setup: false, ...NOT_LIVE });
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/kuma/live`);
  ws = sock;
  sock.onmessage = (e: MessageEvent) => {
    if (ws !== sock) return;
    try {
      onMessage(JSON.parse(String(e.data)) as LiveMessage);
    } catch {
      // a message we can't read is skipped
    }
  };
  sock.onclose = () => ws === sock && lost("Lost the live connection to hdctl. Reconnecting…");
}

function lost(error: string) {
  const s = ws;
  ws = null;
  clear("silent");
  monitors.clear();
  try {
    s?.close();
  } catch {
    // already closed
  }
  set({ phase: "error", error, setup: false, ...NOT_LIVE });
  if (listeners.size) timers.retry = setTimeout(open, Math.min(1_000 * 2 ** attempts++, 30_000));
}

function armSilent() {
  clear("silent");
  timers.silent = setTimeout(() => lost("The live feed went quiet. Reconnecting…"), SILENT_MS);
}

function onMessage(m: LiveMessage) {
  switch (m.type) {
    case "connecting":
      monitors.clear();
      clear("silent");
      return set({ phase: "connecting", error: null, setup: false, ...NOT_LIVE });
    case "snapshot":
      monitors.clear();
      for (const mon of m.monitors) monitors.set(mon.id, mon);
      attempts = 0;
      armSilent();
      return set({ phase: "live", error: null, setup: false, monitors: sorted(), incidents: m.incidents.slice(0, INCIDENTS_KEPT), asOf: m.asOf });
    case "update": {
      if (state.phase !== "live") return;
      for (const mon of m.monitors) monitors.set(mon.id, mon);
      for (const id of m.removed) monitors.delete(id);
      armSilent();
      const incidents = m.incidents.length ? [...m.incidents].reverse().concat(state.incidents).slice(0, INCIDENTS_KEPT) : state.incidents;
      return set({ monitors: sorted(), incidents, asOf: m.asOf });
    }
    case "alive":
      if (state.phase !== "live") return;
      armSilent();
      return set({ asOf: m.asOf });
    case "error":
      monitors.clear();
      clear("silent");
      return set({ phase: "error", error: m.error, setup: m.setup === true, ...NOT_LIVE });
  }
}

function onVisible() {
  // Back from a hidden tab or a sleeping laptop: don't wait out the backoff.
  if (document.visibilityState === "visible" && !ws && listeners.size) open();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  clear("close");
  if (listeners.size === 1) document.addEventListener("visibilitychange", onVisible);
  if (!ws && timers.retry === undefined) open();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    document.removeEventListener("visibilitychange", onVisible);
    timers.close = setTimeout(shutdown, CLOSE_AFTER_MS);
  };
}

function shutdown() {
  for (const t of ["retry", "close", "silent"] as const) clear(t);
  const s = ws;
  ws = null;
  try {
    s?.close();
  } catch {
    // already closed
  }
  monitors.clear();
  attempts = 0;
  state = INITIAL;
}

export function useKumaLive(): KumaLive {
  return useSyncExternalStore(subscribe, () => state);
}

/** Tests only: drop the shared connection and state. */
export function resetKumaLive() {
  shutdown();
  listeners.clear();
}
