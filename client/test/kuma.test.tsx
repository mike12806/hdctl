import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SILENT_MS } from "../src/kumaLive";
import { KumaPage } from "../src/pages/Kuma";
import { FakeWebSocket, monitor } from "./fakeWebSocket";

const T0 = Date.UTC(2026, 10, 9, 10, 0);

const snapshot = () => ({
  type: "snapshot" as const,
  asOf: Date.now(),
  monitors: [
    monitor({ id: 2, name: "dns9", type: "dns", target: "192.168.9.9:53", status: "down", msg: "SERVFAIL", pingMs: null, uptime24h: 0.5, uptime30d: 0.98 }),
    monitor({
      id: 1, name: "Apps / Argo", target: "https://argo.mfaherty.net", pingMs: 112, avgPing24hMs: 98.5, uptime24h: 0.9993, uptime30d: 0.9871,
      cert: { valid: true, daysRemaining: 9, validTo: null },
      beats: [{ at: T0, status: "down", pingMs: null }, { at: T0 + 60_000, status: "up", pingMs: 112 }],
    }),
  ],
  incidents: [{ monitorId: 2, status: "down" as const, at: Date.now() - 120_000, msg: "SERVFAIL" }],
});

const row = (name: string) => within(screen.getByRole("table")).getByText(name).closest("tr")!;

describe("Uptime page", () => {
  it("shows each monitor as Kuma pushes it: status, last checks, response, uptime, certificate, and recent events", () => {
    render(<KumaPage />);
    expect(screen.getByText(/Fetching Uptime Kuma monitors live/)).toBeTruthy();
    FakeWebSocket.latest().push(snapshot());

    const argo = row("Apps / Argo");
    expect(within(argo).getByText("up")).toBeTruthy();
    expect(within(argo).getByText("112 ms")).toBeTruthy();
    expect(within(argo).getByText("avg 99 ms")).toBeTruthy();
    expect(argo.textContent).toContain("99.93%");
    expect(argo.textContent).toContain("98.71%");
    expect(within(argo).getByText("cert 9 days")).toBeTruthy();
    const ticks = within(argo).getByLabelText("Last 2 checks, newest last").children;
    expect(ticks).toHaveLength(60);
    expect([ticks[58]!.className, ticks[59]!.className]).toEqual(["tick tick-bad", "tick tick-good"]);

    const dns = row("dns9");
    expect(within(dns).getByText("down")).toBeTruthy();
    expect(within(dns).getByText("SERVFAIL")).toBeTruthy();
    expect(within(dns).getByText("dns · 192.168.9.9:53")).toBeTruthy();

    const events = screen.getByText("Recent events").closest("section")!;
    expect(within(events).getByText("dns9")).toBeTruthy();
    expect(within(events).getByText("2m ago")).toBeTruthy();
    expect(screen.getByText(/live · pushed by Uptime Kuma/)).toBeTruthy();
  });

  it("applies pushed changes in place: a recovery, a new event, a deleted monitor", () => {
    render(<KumaPage />);
    const ws = FakeWebSocket.latest();
    ws.push(snapshot());
    ws.push({
      type: "update",
      asOf: Date.now(),
      monitors: [monitor({ id: 2, name: "dns9", type: "dns", status: "up", msg: "NOERROR" })],
      removed: [1],
      incidents: [{ monitorId: 2, status: "up", at: Date.now(), msg: "NOERROR" }],
    });
    expect(within(row("dns9")).getByText("up")).toBeTruthy();
    expect(screen.queryByText("Apps / Argo")).toBeNull();
    const events = screen.getByText("Recent events").closest("section")!;
    expect(within(events).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("NOERROR"), expect.stringContaining("SERVFAIL")]);
  });

  it("drops every monitor the moment the feed is lost, then reconnects and starts from a fresh snapshot", async () => {
    vi.useFakeTimers();
    render(<KumaPage />);
    FakeWebSocket.latest().push(snapshot());
    FakeWebSocket.latest().drop();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Lost the live connection");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(FakeWebSocket.all).toHaveLength(2);
    FakeWebSocket.latest().push(snapshot());
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("treats a feed that goes quiet as lost, instead of showing its last word as current", async () => {
    vi.useFakeTimers();
    render(<KumaPage />);
    const ws = FakeWebSocket.latest();
    ws.push(snapshot());
    await act(() => vi.advanceTimersByTimeAsync(SILENT_MS - 1_000));
    ws.push({ type: "alive", asOf: Date.now() });
    await act(() => vi.advanceTimersByTimeAsync(SILENT_MS - 1_000));
    expect(screen.getByRole("table")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.queryByRole("table")).toBeNull();
    expect(ws.closed).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("went quiet");
  });

  it("shows the setup note, and no monitors, while hdctl has no Kuma token", () => {
    render(<KumaPage />);
    FakeWebSocket.latest().push({ type: "error", error: "KUMA_TOKEN is not set.", setup: true });
    expect(screen.getByText("Not set up yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
