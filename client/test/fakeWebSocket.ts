import { act } from "@testing-library/react";
import type { LiveMessage, LiveMonitor } from "../src/api";

/** Stands in for the browser's WebSocket: tests push hdctl's live messages through it. */
export class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  static latest() {
    return FakeWebSocket.all.at(-1)!;
  }
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send() {}
  close() {
    this.closed = true;
  }
  /** hdctl sends `m`. */
  push(m: LiveMessage) {
    act(() => this.onmessage?.({ data: JSON.stringify(m) }));
  }
  /** The connection to hdctl drops. */
  drop() {
    this.closed = true;
    act(() => this.onclose?.());
  }
}

export const monitor = (m: Partial<LiveMonitor> & Pick<LiveMonitor, "id" | "name">): LiveMonitor => ({
  type: "http",
  target: null,
  status: "up",
  msg: null,
  lastBeatAt: Date.now(),
  pingMs: 20,
  avgPing24hMs: 25,
  uptime24h: 1,
  uptime30d: 0.999,
  cert: null,
  beats: [],
  ...m,
});
