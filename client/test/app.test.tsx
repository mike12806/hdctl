import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/reload", () => ({ reloadPage: vi.fn() }));

import { reloadPage } from "../src/reload";
import { NEW_BUILD_EVENT, type StatusSummary } from "../src/api";
import { App } from "../src/App";
import { StatusPage } from "../src/pages/Status";
import { FakeWebSocket, monitor } from "./fakeWebSocket";

const summary = (): StatusSummary => ({
  asOf: Date.now(),
  groups: { cluster: "Cluster apps" },
  targets: [
    {
      id: "harbor", name: "Harbor", group: "cluster", link: null, endpoint: "harbor-core:80", state: "up", checkedAt: Date.now(),
      code: 200, latencyMs: 12, detail: null, since: null, changedAfter: null, uptime24h: 1, history: [],
    },
  ],
});

const kumaSnapshot = () => ({
  type: "snapshot" as const,
  asOf: Date.now(),
  monitors: [
    monitor({ id: 1, name: "dns9", type: "dns", target: "192.168.9.9:53", status: "down", msg: "SERVFAIL" }),
    monitor({ id: 2, name: "Argo", target: "https://argo.mfaherty.net", cert: { valid: true, daysRemaining: 5, validTo: null } }),
    ...Array.from({ length: 68 }, (_, i) => monitor({ id: 10 + i, name: `m${i}` })),
  ],
  incidents: [{ monitorId: 1, status: "down" as const, at: Date.now() - 60_000, msg: "SERVFAIL" }],
});

const renderStatus = () =>
  render(
    <MemoryRouter>
      <StatusPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(reloadPage).mockClear();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => (path === "/api/me" ? Response.json({ email: "owner@example.com" }) : Response.json(summary()))));
});

async function renderApp() {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText("owner@example.com");
}

const pageshow = (persisted: boolean) => Object.assign(new Event("pageshow"), { persisted });

describe("App", () => {
  it("reloads onto a new deploy as soon as the Worker reports one", async () => {
    await renderApp();
    act(() => void window.dispatchEvent(new CustomEvent(NEW_BUILD_EVENT, { detail: "newer" })));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("asks first while a confirmation dialog is open, so nothing typed is lost", async () => {
    await renderApp();
    const dialog = document.body.appendChild(document.createElement("dialog"));
    dialog.setAttribute("open", "");
    act(() => void window.dispatchEvent(new CustomEvent(NEW_BUILD_EVENT, { detail: "newer" })));
    expect(reloadPage).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("hdctl was updated");
    act(() => screen.getByRole("button", { name: "Reload" }).click());
    expect(reloadPage).toHaveBeenCalledTimes(1);
    dialog.remove();
  });

  it("reloads a page restored from the back/forward cache, and only that", async () => {
    await renderApp();
    act(() => void window.dispatchEvent(pageshow(false)));
    expect(reloadPage).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(pageshow(true)));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });
});

describe("Tab bar", () => {
  // jsdom has no layout: give the bar a phone's width (360 px) and nine tabs' worth of content (687 px).
  function phoneLayout() {
    const box = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 48, height: 48, x: left, y: 0, toJSON: () => ({}) });
    const isBar = (el: Element) => el.classList.contains("tabs");
    return [
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return isBar(this) ? 687 : 0; }),
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return isBar(this) ? 360 : 0; }),
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        // "Pull requests" sits at 510-613 px before the bar scrolls.
        if (isBar(this)) return box(0, 360) as DOMRect;
        const scroll = this.parentElement?.scrollLeft ?? 0;
        return box(510 - scroll, 103) as DOMRect;
      }),
    ];
  }

  it("scrolls the current page's tab into view and fades only the edges with more tabs past them", async () => {
    const spies = phoneLayout();
    try {
      render(
        <MemoryRouter initialEntries={["/pulls"]}>
          <App />
        </MemoryRouter>,
      );
      const bar = document.querySelector<HTMLElement>(".tabs")!;
      expect(bar.querySelector(".tab-active")?.textContent).toBe("Pull requests");
      // Centred: 510 + 103 / 2 - 180.
      expect(bar.scrollLeft).toBeCloseTo(381.5);
      act(() => void bar.dispatchEvent(new Event("scroll")));
      expect(bar.hasAttribute("data-more-left")).toBe(true);
      expect(bar.hasAttribute("data-more-right")).toBe(false);

      bar.scrollLeft = 0;
      act(() => void bar.dispatchEvent(new Event("scroll")));
      expect(bar.hasAttribute("data-more-left")).toBe(false);
      expect(bar.hasAttribute("data-more-right")).toBe(true);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("Status page", () => {
  it("takes the board down when a refresh fails, rather than showing the last one", async () => {
    vi.useFakeTimers();
    let tunnelDown = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (tunnelDown ? Response.json({ error: "tunnel down" }, { status: 502 }) : Response.json(summary()))),
    );
    renderStatus();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Harbor")).toBeTruthy();
    expect(screen.getByText(/live · as of/)).toBeTruthy();

    tunnelDown = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.queryByText("Harbor")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("tunnel down");
    expect(screen.getByText(/^no data/)).toBeTruthy();
  });

  it("leads with Uptime Kuma, live: counts, what's down, certificates expiring soon and today's changes", async () => {
    renderStatus();
    const kumaSection = await screen.findByRole("region", { name: "Uptime Kuma" });
    expect(kumaSection.textContent).toContain("Connecting to Uptime Kuma");
    expect(FakeWebSocket.latest().url).toBe(`ws://${location.host}/api/kuma/live`);
    FakeWebSocket.latest().push(kumaSnapshot());
    expect(kumaSection.textContent).toContain("69Up");
    expect(kumaSection.textContent).toContain("1Down");
    expect(within(kumaSection).getAllByText("SERVFAIL").length).toBeGreaterThan(0);
    expect(within(kumaSection).getByText("cert 5 days")).toBeTruthy();
    expect(within(kumaSection).getByText("Changes in the last 24 hours")).toBeTruthy();
    expect(within(kumaSection).getByText(/live · pushed by Uptime Kuma/)).toBeTruthy();
    expect(within(kumaSection).getByRole("link", { name: "All monitors" }).getAttribute("href")).toBe("/uptime");
    expect(await screen.findByText("Harbor")).toBeTruthy();

    // dns9 recovers: pushed, not polled.
    FakeWebSocket.latest().push({ type: "update", asOf: Date.now(), monitors: [monitor({ id: 1, name: "dns9", status: "up" })], removed: [], incidents: [] });
    expect(kumaSection.textContent).toContain("70Up");
    expect(kumaSection.textContent).toContain("0Down");
  });

  it("keeps the endpoint board when Kuma fails, and shows Kuma's error, with no monitors, only in its own section", async () => {
    renderStatus();
    const kumaSection = await screen.findByRole("region", { name: "Uptime Kuma" });
    FakeWebSocket.latest().push(kumaSnapshot());
    FakeWebSocket.latest().push({ type: "error", error: "Uptime Kuma closed the connection." });
    expect(within(kumaSection).getByRole("alert").textContent).toContain("closed the connection");
    expect(within(kumaSection).queryByText("dns9")).toBeNull();
    expect(kumaSection.textContent).not.toContain("69Up");
    expect(await screen.findByText("Harbor")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("says that it refreshes itself, and how often", async () => {
    renderStatus();
    expect((await screen.findByText(/live · as of/)).textContent).toContain("auto-refresh every 30 s");
  });
});
