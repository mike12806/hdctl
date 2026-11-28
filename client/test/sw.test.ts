import { describe, expect, it, vi } from "vitest";
import { handleClick, handlePush, handleSubscriptionChange, type SwContext, type WindowLike } from "../src/notifications/sw-handlers";
import { RECOVERY_KEEP_MS, closeAnswered, tidyRecoveries, type PushPayload, type ShowOptions } from "../src/notifications/payload";

/** The service worker's side, against a fake `self`: what it shows, and what a tap does. */

type Shown = { data: unknown; tag: string; close: ReturnType<typeof vi.fn<() => void>> };

function fakeSw(opts: { windows?: WindowLike[]; fetch?: (path: string, init: RequestInit) => Response | Promise<Response>; onScreen?: Shown[] } = {}) {
  const shown: { title: string; options: ShowOptions }[] = [];
  const badges: number[] = [];
  const opened: string[] = [];
  const fetched: { path: string; init: RequestInit }[] = [];
  const ctx: SwContext = {
    showNotification: async (title, options) => void shown.push({ title, options }),
    getNotifications: async () => opts.onScreen ?? [],
    windows: async () => opts.windows ?? [],
    openWindow: async (url) => void opened.push(url),
    fetch: async (path, init) => {
      fetched.push({ path, init });
      return (opts.fetch ?? (() => Response.json({ open: 0 })))(path, init);
    },
    setBadge: async (n) => void badges.push(n),
    subscribe: async () => ({ toJSON: () => ({ endpoint: "https://fcm.googleapis.com/new" }) }),
    images: { icon: "data:icon", badge: "data:badge" },
  };
  return { ctx, shown, badges, opened, fetched };
}

const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
  v: 1, kind: "open", id: 7, tag: "hdctl:target:harbor", severity: "critical", title: "Harbor is down", body: "connection refused · 10.0.0.5:443", url: "/", at: 1_700_000_000_000, open: 2, ...over,
});

describe("a push", () => {
  it("shows an alarm under its tag, with Acknowledge and Mute, kept on screen when critical, and badges the icon", async () => {
    const sw = fakeSw();
    await handlePush(sw.ctx, () => payload());
    expect(sw.shown).toEqual([
      {
        title: "Harbor is down",
        options: {
          body: "connection refused · 10.0.0.5:443",
          tag: "hdctl:target:harbor",
          icon: "data:icon",
          badge: "data:badge",
          timestamp: 1_700_000_000_000,
          renotify: true,
          silent: false,
          requireInteraction: true,
          actions: [
            { action: "ack", title: "Acknowledge" },
            { action: "mute", title: "Mute 1 h" },
          ],
          data: { id: 7, kind: "open", url: "/", at: 1_700_000_000_000 },
        },
      },
    ]);
    expect(sw.badges).toEqual([2]);
  });

  it("lets a warning go by on a desktop like any notification", async () => {
    const sw = fakeSw();
    await handlePush(sw.ctx, () => payload({ severity: "warning" }));
    expect(sw.shown[0]!.options.requireInteraction).toBe(false);
  });

  it("replaces the alarm with its recovery silently, with no buttons", async () => {
    const sw = fakeSw();
    await handlePush(sw.ctx, () => payload({ kind: "resolve", title: "Resolved: Harbor", body: "Back up (HTTP 200) after 12 min.", open: 0 }));
    expect(sw.shown[0]!.options).toMatchObject({ tag: "hdctl:target:harbor", renotify: false, silent: true, requireInteraction: false, actions: [] });
    expect(sw.badges).toEqual([0]);
  });

  it("clears recoveries older than ten minutes when another push arrives, and nothing else", async () => {
    const now = Date.now();
    const on = (tag: string, data: unknown): Shown => ({ tag, data, close: vi.fn() });
    const onScreen = [
      on("hdctl:target:immich", { kind: "resolve", id: 3, at: now - RECOVERY_KEEP_MS - 1000 }), // old recovery: cleared
      on("hdctl:target:paperless", { kind: "resolve", id: 4, at: now - 60_000 }), // recent recovery: kept
      on("hdctl:target:emby", { kind: "resolve", id: 5 }), // from a build that didn't record when: cleared
      on("hdctl:target:argo", { kind: "open", id: 6, at: now - 3_600_000 }), // an alarm: never by age
      on("hdctl:test", { kind: "test", id: null, at: now - 3_600_000 }),
    ];
    const sw = fakeSw({ onScreen });
    await handlePush(sw.ctx, () => payload());
    expect(onScreen.map((n) => n.close.mock.calls.length)).toEqual([1, 0, 1, 0, 0]);
  });

  it("still shows something for a push it can't read, since every push must", async () => {
    for (const read of [() => ({ v: 2, title: "x" }), () => null, () => { throw new SyntaxError("not JSON"); }]) {
      const sw = fakeSw();
      await handlePush(sw.ctx, read);
      expect(sw.shown).toMatchObject([{ title: "hdctl", options: { tag: "hdctl:unreadable", data: { url: "/notifications" } } }]);
    }
  });

  it("never lets a payload point a tap off the site", async () => {
    const sw = fakeSw();
    await handlePush(sw.ctx, () => payload({ url: "https://evil.example/" }));
    await handlePush(sw.ctx, () => payload({ url: "//evil.example/" }));
    expect(sw.shown.map((s) => (s.options.data as { url: string }).url)).toEqual(["/", "/"]);
  });
});

describe("a tap", () => {
  const win = (): WindowLike & { calls: string[] } => {
    const calls: string[] = [];
    return { url: "https://hdctl.mfaherty.net/argo", calls, focus: async () => void calls.push("focus"), navigate: async (u) => void calls.push(`navigate ${u}`) };
  };

  it("brings an open hdctl window forward on the incident's page", async () => {
    const w = win();
    const sw = fakeSw({ windows: [w] });
    await handleClick(sw.ctx, { id: 7, kind: "open", url: "/metrics" }, "");
    expect(w.calls).toEqual(["focus", "navigate /metrics"]);
    expect(sw.opened).toEqual([]);
  });

  it("opens hdctl when no window is open", async () => {
    const sw = fakeSw();
    await handleClick(sw.ctx, { id: 7, kind: "open", url: "/argo" }, "");
    expect(sw.opened).toEqual(["/argo"]);
  });

  it("acknowledges in place, the way the app calls the API, and updates the badge", async () => {
    const sw = fakeSw({ fetch: () => Response.json({ open: 1 }) });
    await handleClick(sw.ctx, { id: 7, kind: "open", url: "/" }, "ack");
    expect(sw.fetched).toHaveLength(1);
    const { path, init } = sw.fetched[0]!;
    expect(path).toBe("/api/notify/incidents/7/ack");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "manual", headers: { "X-Hdctl": "1" } });
    expect(sw.opened).toEqual([]);
    expect(sw.badges).toEqual([1]);
  });

  it("mutes for an hour in place", async () => {
    const sw = fakeSw();
    await handleClick(sw.ctx, { id: 7, kind: "escalate", url: "/" }, "mute");
    expect(sw.fetched[0]).toMatchObject({ path: "/api/notify/incidents/7/mute", init: { body: JSON.stringify({ minutes: 60 }) } });
  });

  it("opens the Notifications page when acting in place fails, so signing in again is one tap away", async () => {
    for (const fail of [() => Response.error(), () => new Response(null, { status: 401 }), () => Promise.reject(new TypeError("offline"))]) {
      const sw = fakeSw({ fetch: fail });
      await handleClick(sw.ctx, { id: 7, kind: "open", url: "/" }, "ack");
      expect(sw.opened).toEqual(["/notifications"]);
    }
  });
});

describe("a replaced subscription", () => {
  it("registers the new one in place of the old", async () => {
    const sw = fakeSw({ fetch: () => Response.json({}) });
    await handleSubscriptionChange(sw.ctx, { endpoint: "https://fcm.googleapis.com/old" }, { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/new" }) });
    expect(sw.fetched).toHaveLength(1);
    expect(sw.fetched[0]!.path).toBe("/api/notify/devices");
    expect(JSON.parse(sw.fetched[0]!.init.body as string)).toEqual({ subscription: { endpoint: "https://fcm.googleapis.com/new" }, replaces: "https://fcm.googleapis.com/old" });
  });

  it("subscribes again itself when the browser didn't, with hdctl's key", async () => {
    const sw = fakeSw({ fetch: (path) => (path === "/api/notify/devices" ? Response.json({ publicKey: "BPk" }) : Response.json({})) });
    const subscribe = vi.spyOn(sw.ctx, "subscribe");
    await handleSubscriptionChange(sw.ctx, { endpoint: "https://fcm.googleapis.com/old" }, null);
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: "BPk" });
    expect(sw.fetched.map((f) => f.init.method ?? "GET")).toEqual(["GET", "POST"]);
  });
});

describe("closeAnswered", () => {
  it("closes alarms no longer open and unacknowledged, and every recovery, and leaves tests alone", () => {
    const n = (data: unknown) => ({ data, close: vi.fn() });
    const shown = [n({ id: 1, kind: "open" }), n({ id: 2, kind: "escalate" }), n({ id: 3, kind: "open" }), n({ id: 3, kind: "resolve" }), n({ id: null, kind: "test" }), n(null)];
    expect(closeAnswered(shown, new Set([1]))).toBe(3);
    expect(shown.map((s) => s.close.mock.calls.length)).toEqual([0, 1, 1, 1, 0, 0]);
  });
});

describe("tidyRecoveries", () => {
  it("keeps the one just shown, however old", () => {
    const n = { tag: "hdctl:lab", data: { kind: "resolve", at: 0 }, close: vi.fn() };
    expect(tidyRecoveries([n], "hdctl:lab", Date.now())).toBe(0);
    expect(n.close).not.toHaveBeenCalled();
  });
});
