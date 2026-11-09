import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsOf, Loading, intervalLabel } from "../src/components/ui";
import { IDLE_AFTER_MS } from "../src/idle";

const pass = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the refresh indicator", () => {
  it("formats the interval", () => {
    expect([intervalLabel(20_000), intervalLabel(30_000), intervalLabel(300_000)]).toEqual(["20 s", "30 s", "5 min"]);
  });

  it("says how often the page refreshes, then that it's paused while idle, until the next input", async () => {
    const { container } = render(
      <>
        <AsOf at={Date.now()} every={30_000} />
        <Loading what="metrics" />
      </>,
    );
    expect(container.textContent).toContain("auto-refresh every 30 s");
    expect(screen.getByText("Fetching metrics live…")).toBeTruthy();

    await pass(IDLE_AFTER_MS);
    expect(container.textContent).toContain("auto-refresh paused while idle");
    expect(container.textContent).not.toContain("auto-refresh every 30 s");
    expect(screen.getByText("Paused while idle. Move the mouse or press a key to fetch metrics live.")).toBeTruthy();

    act(() => void window.dispatchEvent(new Event("pointerdown")));
    expect(container.textContent).toContain("auto-refresh every 30 s");
    expect(screen.getByText("Fetching metrics live…")).toBeTruthy();
  });

  it("says when there's no current data because it's paused, rather than that it's fetching", async () => {
    const { container } = render(<AsOf at={null} loading every={30_000} />);
    expect(container.textContent).toContain("fetching live data…");
    await pass(IDLE_AFTER_MS);
    expect(container.textContent).toContain("no current data");
    expect(container.textContent).not.toContain("fetching");
  });
});
