import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Device, Devices, IncidentFeed, NotifyIncident } from "../src/api";
import { endpointHash } from "../src/notifications/browser";
import { IncidentFeedProvider } from "../src/notifications/feed";
import { NotificationsPage } from "../src/pages/Notifications";

/**
 * The Notifications page against a fake browser (service worker, push
 * manager, permission prompt) and a fake /api/notify.
 */

const ENDPOINT = "https://fcm.googleapis.com/push/this-phone";
const KEY = "BAEC"; // base64url of 04 01 02

interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | Uint8Array };
  toJSON(): unknown;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeBrowser(opts: { permission?: NotificationPermission; subscribed?: boolean; grant?: NotificationPermission; shown?: { data: unknown; close: () => void }[] } = {}) {
  const state: { sub: FakeSub | null } = { sub: null };
  const makeSub = (key: ArrayBuffer | Uint8Array): FakeSub => ({
    endpoint: ENDPOINT,
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => {
      state.sub = null;
      return true;
    }),
  });
  if (opts.subscribed) state.sub = makeSub(new Uint8Array([4, 1, 2]));
  const pushManager = {
    getSubscription: vi.fn(async () => state.sub),
    subscribe: vi.fn(async (o: { applicationServerKey: Uint8Array }) => (state.sub = makeSub(o.applicationServerKey))),
  };
  const reg = { pushManager, getNotifications: vi.fn(async () => opts.shown ?? []) };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => reg), ready: Promise.resolve(reg), getRegistration: vi.fn(async () => reg) },
  });
  const badge = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: badge });
  Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: vi.fn(async () => undefined) });
  vi.stubGlobal("PushManager", function PushManager() {});
  const notification = {
    permission: opts.permission ?? "default",
    requestPermission: vi.fn(async () => (notification.permission = opts.grant ?? "granted")),
  };
  vi.stubGlobal("Notification", notification);
  return { state, pushManager, notification, badge };
}

afterEach(() => {
  for (const k of ["serviceWorker", "setAppBadge", "clearAppBadge", "userAgent", "maxTouchPoints"]) delete (navigator as unknown as Record<string, unknown>)[k];
});

const incident = (over: Partial<NotifyIncident> = {}): NotifyIncident => ({
  id: 1, key: "target:harbor", source: "endpoint", severity: "critical", subject: "Harbor", title: "Harbor is down", body: "connection refused · 10.0.0.5:443",
  url: "/", link: "https://harbor.mfaherty.net", firstSeenAt: Date.now() - 12 * 60_000, lastSeenAt: Date.now() - 60_000, seen: 6, notifiedAt: Date.now() - 10 * 60_000,
  pushed: true, ackedAt: null, ackedBy: null, resolvedAt: null, resolution: null, mutedUntil: null, ...over,
});

let feed: IncidentFeed;
let devices: Devices | { status: number; body: unknown };
let calls: { method: string; path: string; body: unknown }[];

async function thisDevice(over: Partial<Device> = {}): Promise<Device> {
  return {
    id: 5, label: "Android · Chrome", actor: "owner@example.com", endpointHash: await endpointHash(ENDPOINT), service: "Google",
    sources: ["endpoint", "alert", "argo", "workflow"], minSeverity: "warning", recoveries: true, createdAt: Date.now() - 86_400_000,
    lastSentAt: Date.now() - 300_000, lastError: null, lastErrorAt: null, ...over,
  };
}

beforeEach(() => {
  feed = { asOf: Date.now(), open: [], pending: [], recent: [], mutes: [], feeds: [{ feed: "endpoint", checkedAt: Date.now() - 60_000, okAt: Date.now() - 60_000, error: null }] };
  devices = { publicKey: KEY, devices: [] };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      if (path === "/api/notify/incidents") return Response.json(feed);
      if (path === "/api/notify/devices" && method === "GET") return "status" in devices ? Response.json(devices.body, { status: devices.status }) : Response.json(devices);
      if (path === "/api/notify/devices" && method === "POST") {
        const d = await thisDevice({ label: body.label });
        if (!("status" in devices)) devices.devices.push(d);
        return Response.json({ device: d, created: true, confirmation: { ok: true, status: 201 } });
      }
      return Response.json({ ok: true, open: 0 });
    }),
  );
});

function renderPage() {
  return render(
    <MemoryRouter>
      <IncidentFeedProvider>
        <NotificationsPage />
      </IncidentFeedProvider>
    </MemoryRouter>,
  );
}

const section = (name: string) => screen.getByRole("heading", { name }).closest("section")!;

describe("turning notifications on", () => {
  it("asks permission from the tap, subscribes with hdctl's key, and registers this device by name", async () => {
    const b = fakeBrowser();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
    expect(await screen.findByText("Notifications are on. A confirmation is on its way to this device.")).toBeTruthy();

    expect(b.notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(b.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([4, 1, 2]) });
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/api/notify/devices",
      body: { subscription: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }, label: "Android · Chrome" },
    });
    expect(await within(section("Devices")).findByText("this device")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send a test" })).toBeTruthy();
  });

  it("says so, and registers nothing, when permission is declined", async () => {
    fakeBrowser({ grant: "denied" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
    expect((await screen.findByRole("alert")).textContent).toContain("blocked for hdctl");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("tells an iPhone in Safari to add hdctl to the Home Screen first", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Version/26.1 Mobile/15E148 Safari/604.1" });
    renderPage();
    expect(await screen.findByText("Add hdctl to your Home Screen")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).toBeNull();
  });

  it("says it isn't set up while the VAPID keys aren't in Vault", async () => {
    fakeBrowser();
    devices = { status: 503, body: { error: "VAPID keys aren't set.", setup: true } };
    renderPage();
    expect(await screen.findByText("Not set up yet")).toBeTruthy();
  });

  it("offers to register again a subscription hdctl no longer has", async () => {
    fakeBrowser({ subscribed: true, permission: "granted" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Register this device" }));
    expect(await screen.findByText("Notifications are on. A confirmation is on its way to this device.")).toBeTruthy();
  });
});

describe("this device, once on", () => {
  it("sends a test and reports the push service's answer", async () => {
    fakeBrowser({ subscribed: true, permission: "granted" });
    devices = { publicKey: KEY, devices: [await thisDevice()] };
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Send a test" }));
    expect(await screen.findByText("Sent. It should arrive within a few seconds.")).toBeTruthy();
    expect(calls.at(-2)).toMatchObject({ method: "POST", path: "/api/notify/devices/5/test" });
  });

  it("turns off: unsubscribes the browser and removes the device", async () => {
    const b = fakeBrowser({ subscribed: true, permission: "granted" });
    devices = { publicKey: KEY, devices: [await thisDevice()] };
    renderPage();
    const sub = b.state.sub!;
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(await screen.findByText("Turned off. hdctl won't push to this device any more.")).toBeTruthy();
    expect(screen.getByText("Notifications are off on this device.")).toBeTruthy();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(calls).toContainEqual({ method: "DELETE", path: "/api/notify/devices/5", body: undefined });
  });

  it("changes what a device is told about", async () => {
    fakeBrowser({ subscribed: true, permission: "granted" });
    devices = { publicKey: KEY, devices: [await thisDevice()] };
    renderPage();
    fireEvent.click(await screen.findByLabelText("Argo CD apps degraded or failing to sync"));
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({ method: "PATCH", path: "/api/notify/devices/5", body: { sources: ["endpoint", "alert", "workflow"] } });
    fireEvent.change(screen.getByLabelText("Severity for Android · Chrome"), { target: { value: "critical" } });
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({ method: "PATCH", path: "/api/notify/devices/5", body: { minSeverity: "critical" } });
  });

  it("won't uncheck a device's last source", async () => {
    fakeBrowser({ subscribed: true, permission: "granted" });
    devices = { publicKey: KEY, devices: [await thisDevice({ sources: ["alert"] })] };
    renderPage();
    expect(((await screen.findByLabelText("Alertmanager alerts")) as HTMLInputElement).disabled).toBe(true);
  });

  it("shows why a device went quiet", async () => {
    fakeBrowser();
    devices = { publicKey: KEY, devices: [await thisDevice({ label: "iPad · Safari", endpointHash: "other", lastError: "push service answered HTTP 403: BadJwtToken", lastErrorAt: Date.now() - 120_000 })] };
    renderPage();
    expect(await screen.findByText(/push service answered HTTP 403: BadJwtToken/)).toBeTruthy();
    expect(within(section("Devices")).queryByText("this device")).toBeNull();
  });
});

describe("the record", () => {
  it("lists what's open, and acknowledges from the page", async () => {
    fakeBrowser();
    feed.open = [incident()];
    renderPage();
    const open = await screen.findByText("Harbor is down");
    expect(open.closest("li")!.textContent).toContain("connection refused · 10.0.0.5:443");
    expect(open.getAttribute("href")).toBe("/");
    const reads = calls.filter((c) => c.path === "/api/notify/incidents").length;
    fireEvent.click(within(open.closest("li")!).getByRole("button", { name: "Acknowledge" }));
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({ method: "POST", path: "/api/notify/incidents/1/ack", body: undefined });
    await vi.waitFor(() => expect(calls.filter((c) => c.path === "/api/notify/incidents").length).toBeGreaterThan(reads));
  });

  it("mutes one thing for an hour, and pauses everything", async () => {
    fakeBrowser();
    feed.open = [incident()];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Mute 1 h" }));
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({ method: "POST", path: "/api/notify/incidents/1/mute", body: { minutes: 60 } });
    fireEvent.change(screen.getByLabelText("Pause all notifications"), { target: { value: "240" } });
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({ method: "POST", path: "/api/notify/pause", body: { minutes: 240 } });
  });

  it("says when notifications are paused, and resumes them", async () => {
    fakeBrowser();
    feed.mutes = [{ id: 9, key: "*", label: "everything", until: Date.now() + 3600_000, actor: "owner@example.com", createdAt: Date.now() }];
    renderPage();
    expect(await screen.findByText(/Nothing is pushed until/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume notifications" }));
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({ method: "DELETE", path: "/api/notify/mutes/9", body: undefined });
  });

  it("says which feed couldn't be read, so the record isn't taken as current", async () => {
    fakeBrowser();
    feed.feeds.push({ feed: "alert", checkedAt: Date.now() - 30_000, okAt: Date.now() - 20 * 60_000, error: "Alertmanager: HTTP 503" });
    renderPage();
    const alert = await screen.findByText(/couldn't be read: Alertmanager: HTTP 503/);
    expect(alert.closest("[role=alert]")!.textContent).toContain("Alertmanager");
  });

  it("warns when nothing has been evaluated for a while", async () => {
    fakeBrowser();
    feed.feeds = [{ feed: "endpoint", checkedAt: Date.now() - 20 * 60_000, okAt: Date.now() - 20 * 60_000, error: null }];
    renderPage();
    expect(await screen.findByText(/not evaluated for 20m: notifications may be late/)).toBeTruthy();
  });

  it("shows what it's still watching before telling anyone, and what resolved", async () => {
    fakeBrowser();
    feed.pending = [incident({ id: 2, title: "Immich is down", notifiedAt: null })];
    feed.recent = [incident({ id: 3, title: "Paperless is degraded", resolvedAt: Date.now() - 60_000, firstSeenAt: Date.now() - 13 * 60_000, resolution: "back up (HTTP 200)" })];
    renderPage();
    expect(within(await screen.findByRole("heading", { name: "Watching" }).then((h) => h.closest("section")!)).getByText("Immich is down")).toBeTruthy();
    expect(section("Resolved in the last 7 days").textContent).toContain("back up (HTTP 200) · lasted 12m");
  });
});

describe("this device's lock screen", () => {
  it("closes alarms that were answered elsewhere and badges the app icon with what's left", async () => {
    const close = [vi.fn(), vi.fn(), vi.fn()];
    const b = fakeBrowser({
      shown: [
        { data: { id: 1, kind: "open" }, close: close[0]! },
        { data: { id: 2, kind: "open" }, close: close[1]! },
        { data: { id: 3, kind: "resolve" }, close: close[2]! },
      ],
    });
    feed.open = [incident({ id: 1 }), incident({ id: 4, title: "Vault is sealed", ackedAt: Date.now() })];
    renderPage();
    await screen.findByText("Harbor is down", { selector: "a" });
    await vi.waitFor(() => expect(b.badge).toHaveBeenCalledWith(1));
    expect(close.map((c) => c.mock.calls.length)).toEqual([0, 1, 0]);
  });
});
