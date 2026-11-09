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
  volumes: { data: { count: 1, fullest: [{ namespace: "harbor", claim: "data-harbor-trivy-0", used: 0.82, capacity: 5e9 }] }, error: null },
  network: {
    data: {
      wans: [{ device: "udm", port: "eth8", downloadBps: 940_000, uploadBps: 5_500_000, latencyMs: 9, availability: 100 }],
      wifiClients: 43, wiredClients: 50, vpnClients: 0, guests: 0, accessPoints: 5, disconnectedDevices: 0, internetLatencyMs: 9,
      speedtest: { downMbps: 926, upMbps: 951, pingMs: 11 },
    },
    error: null,
  },
  dns: { data: null, error: "Prometheus: parse error" },
  scrape: { data: { total: 113, down: [] }, error: null },
});

describe("Metrics page", () => {
  it("shows a failed section as its error, with no data, and the rest as normal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(overview())));
    render(<MetricsPage />);
    expect(await screen.findByText("Nothing is firing.")).toBeTruthy();

    const dns = screen.getByText("DNS").closest("section")!;
    expect(dns.querySelector("[role=alert]")?.textContent).toContain("Prometheus: parse error");
    expect(dns.querySelector("table")).toBeNull();

    expect(screen.getByText("pve4")).toBeTruthy();
    expect(screen.getByText("7.5 Mbps")).toBeTruthy(); // 940 kB/s down
    expect(screen.getByText("926/951")).toBeTruthy();
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
