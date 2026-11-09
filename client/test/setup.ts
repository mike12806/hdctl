import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetKumaLive } from "../src/kumaLive";
import { FakeWebSocket } from "./fakeWebSocket";

// No test opens a real WebSocket: the Kuma feed goes through a fake each test drives.
beforeEach(() => {
  FakeWebSocket.all = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  resetKumaLive();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
