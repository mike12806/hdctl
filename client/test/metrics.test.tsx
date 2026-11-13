import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MetricsOverview } from "../src/api";
import { MetricsPage } from "../src/pages/Metrics";

const overview = (): MetricsOverview => ({
  asOf: Date.now(),
  alerts: { data: [], error: null },
  machines: {
    data: [{ name: "pve4", kind: "host", instance: "192.168.1.12:9100", up: true, ready: null, cpu: 0.03, cores: 8, mem: 0.56, memTotal: 7.6e9, disk: 0.35, diskTotal: 1e11, load5: 0.1, uptime: 86400 }],
    error: null,
  },
  workloads: { data: { podsRunning: 306, podsTotal: 337, problems: [], restarts: [] }, error: null },
  volumes: { data: null, error: "Prometheus: parse error" },
  scrape: { data: { total: 113, down: [] }, error: null },
});

describe("Metrics page", () => {
  it("shows a failed section as its error, with no data, and the rest as normal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(overview())));
    render(<MetricsPage />);
    expect(await screen.findByText("Nothing is firing.")).toBeTruthy();

    const storage = screen.getByText("Storage").closest("section")!;
    expect(storage.querySelector("[role=alert]")?.textContent).toContain("Prometheus: parse error");
    expect(storage.querySelector("ul")).toBeNull();

    expect(screen.getByText("pve4")).toBeTruthy();
    expect(screen.queryByText("Network")).toBeNull(); // on the UniFi page, from the UDM's own API
    expect(screen.queryByText("DNS")).toBeNull(); // on the DNS page, from each Pi-hole's own API
    expect(screen.getByText("All 113 targets are up.")).toBeTruthy();
  });

  it("drops everything when the whole call fails, rather than keeping the last answer", async () => {
    vi.useFakeTimers();
    let up = true;
    vi.stubGlobal("fetch", vi.fn(async () => (up ? Response.json(overview()) : Response.json({ error: "tunnel down" }, { status: 502 }))));
    render(<MetricsPage />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("pve4")).toBeTruthy();

    up = false;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.queryByText("pve4")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("tunnel down");
  });
});
