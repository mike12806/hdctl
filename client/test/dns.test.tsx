import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DnsOverview } from "../src/api";
import { DnsPage } from "../src/pages/Dns";

const overview = (): DnsOverview => ({
  asOf: Date.now(),
  hosts: [
    { host: "dns7", link: "https://dns7.mfaherty.net/admin/", error: null, enabled: true, queriesToday: 187010, blockedToday: 9481, blockedPercent: 5.07, clients: 42 },
    { host: "dns8", link: null, error: null, enabled: false, queriesToday: 1200, blockedToday: 0, blockedPercent: 0, clients: 3 },
    { host: "k8s-dns", link: null, error: "login refused: HTTP 429 API seats exceeded", enabled: null, queriesToday: null, blockedToday: null, blockedPercent: null, clients: null },
  ],
});

const row = (host: string) => screen.getByText(host).closest("tr")!;

describe("DNS page", () => {
  it("asks /api/dns and shows each Pi-hole's numbers, and a failed one as its error with no numbers", async () => {
    const fetch = vi.fn(async () => Response.json(overview()));
    vi.stubGlobal("fetch", fetch);
    render(<DnsPage />);
    expect(await screen.findByText("dns7")).toBeTruthy();
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe("/api/dns");

    expect(within(row("dns7")).getByText("on")).toBeTruthy();
    expect(within(row("dns7")).getByText("187,010")).toBeTruthy();
    expect(within(row("dns7")).getByText("9,481 (5.1%)")).toBeTruthy();
    expect(within(row("dns8")).getByText("off")).toBeTruthy();

    const failed = row("k8s-dns");
    expect(within(failed).getByRole("alert").textContent).toBe("login refused: HTTP 429 API seats exceeded");
    expect(within(failed).queryByText("unknown")).toBeNull();
    expect(failed.querySelectorAll("td")).toHaveLength(2); // the name and the error, no number cells

    expect(screen.getByText(/2\/3 Pi-holes answering/)).toBeTruthy();
  });

  it("drops every number when the whole call fails, rather than keeping the last answer", async () => {
    vi.useFakeTimers();
    let up = true;
    vi.stubGlobal("fetch", vi.fn(async () => (up ? Response.json(overview()) : Response.json({ error: "PIHOLE_PASSWORDS is not set", setup: true }, { status: 503 }))));
    render(<DnsPage />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("dns7")).toBeTruthy();

    up = false;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.queryByText("dns7")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("PIHOLE_PASSWORDS is not set");
  });
});
