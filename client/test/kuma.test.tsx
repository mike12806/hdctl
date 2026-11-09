import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KumaOverview } from "../src/api";
import { KumaPage } from "../src/pages/Kuma";

const overview = (): KumaOverview => ({
  asOf: Date.now(),
  counts: { up: 1, down: 1, pending: 0, maintenance: 0, unknown: 0 },
  monitors: [
    { name: "dns9", type: "dns", target: "192.168.9.9:53", status: "down", responseTimeMs: null, certDaysRemaining: null, certValid: null },
    { name: "Argo", type: "http", target: "https://argo.mfaherty.net", status: "up", responseTimeMs: 112.4, certDaysRemaining: 9, certValid: true },
  ],
});

function serve(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status, headers: { "X-Hdctl-Build": __HDCTL_BUILD__ } })));
}

describe("Uptime page", () => {
  it("shows each monitor's live status, response time and certificate", async () => {
    serve(overview());
    render(<KumaPage />);
    const row = (await screen.findByText("Argo")).closest("tr")!;
    expect(within(row).getByText("up")).toBeTruthy();
    expect(within(row).getByText("112 ms")).toBeTruthy();
    expect(within(row).getByText("cert 9 days")).toBeTruthy();
    const down = screen.getByText("dns9").closest("tr")!;
    expect(within(down).getByText("down")).toBeTruthy();
    expect(within(down).getByText("dns · 192.168.9.9:53")).toBeTruthy();
    expect(screen.queryByText(/Every monitor/)).toBeNull();
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/kuma");
  });

  it("shows the setup note, and no monitors, while the key is missing", async () => {
    serve({ error: "KUMA_API_KEY is not set.", setup: true }, 503);
    render(<KumaPage />);
    expect(await screen.findByText("Not set up yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
