import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/reload", () => ({ reloadPage: vi.fn() }));

import { reloadPage } from "../src/reload";
import { NEW_BUILD_EVENT, type KumaOverview, type StatusSummary } from "../src/api";
import { App } from "../src/App";
import { StatusPage } from "../src/pages/Status";

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

const kuma = (): KumaOverview => ({
  asOf: Date.now(),
  counts: { up: 69, down: 1, pending: 0, maintenance: 0, unknown: 0 },
  monitors: [
    { name: "dns9", type: "dns", target: "192.168.9.9:53", status: "down", responseTimeMs: null, certDaysRemaining: null, certValid: null },
    { name: "Argo", type: "http", target: "https://argo.mfaherty.net", status: "up", responseTimeMs: 112, certDaysRemaining: 5, certValid: true },
  ],
});

const renderStatus = () =>
  render(
    <MemoryRouter>
      <StatusPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(reloadPage).mockClear();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => (path === "/api/me" ? Response.json({ email: "owner@example.com" }) : path === "/api/kuma" ? Response.json(kuma()) : Response.json(summary()))));
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

describe("Status page", () => {
  it("takes the board down when a refresh fails, rather than showing the last one", async () => {
    vi.useFakeTimers();
    let tunnelDown = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => (path === "/api/kuma" ? Response.json(kuma()) : tunnelDown ? Response.json({ error: "tunnel down" }, { status: 502 }) : Response.json(summary()))),
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

  it("leads with Uptime Kuma: counts, then what's down and which certificates expire soon", async () => {
    renderStatus();
    const kumaSection = await screen.findByRole("region", { name: "Uptime Kuma" });
    await within(kumaSection).findByText("dns9");
    expect(kumaSection.textContent).toContain("69Up");
    expect(kumaSection.textContent).toContain("1Down");
    expect(within(kumaSection).getByText("cert 5 days")).toBeTruthy();
    expect(within(kumaSection).getByRole("link", { name: "All monitors" }).getAttribute("href")).toBe("/uptime");
    expect(await screen.findByText("Harbor")).toBeTruthy();
  });

  it("keeps the endpoint board when Kuma fails, and shows Kuma's error only in its own section", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => (path === "/api/kuma" ? Response.json({ error: "Uptime Kuma refused the API key (HTTP 401)." }, { status: 502 }) : Response.json(summary()))),
    );
    renderStatus();
    const kumaSection = await screen.findByRole("region", { name: "Uptime Kuma" });
    expect((await within(kumaSection).findByRole("alert")).textContent).toContain("refused the API key");
    expect(await screen.findByText("Harbor")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("says that it refreshes itself, and how often", async () => {
    renderStatus();
    expect((await screen.findByText(/live · as of/)).textContent).toContain("auto-refresh every 30 s");
  });
});
