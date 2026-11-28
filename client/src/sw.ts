/**
 * hdctl's service worker: push notifications, and nothing else.
 *
 * There is deliberately no fetch handler, so nothing is ever answered from a
 * cache: every page load and every /api call goes to the Worker exactly as
 * it would without a service worker. That keeps "nothing shown is stale"
 * true by construction, and means a deploy is never half-cached.
 *
 * Built on its own (vite.sw.config.ts) as one classic script at /sw.js, so it
 * shares no chunk with the app and its scope is the whole site. The images
 * are inlined: a notification's icon is fetched by the browser, which may not
 * carry the Access cookie, so a URL could come back as Access's login page.
 */

import icon from "./notifications/icons/notification-icon.png?inline";
import badge from "./notifications/icons/badge-72.png?inline";
import { handleClick, handlePush, handleSubscriptionChange, type SwContext, type WindowLike } from "./notifications/sw-handlers";

// The few service-worker types used here, declared rather than pulling the
// webworker lib into a project built against the DOM's.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface PushEvent extends ExtendableEvent {
  data: { json(): unknown } | null;
}
interface NotificationEvent extends ExtendableEvent {
  notification: Notification;
  action: string;
}
interface PushSubscriptionChangeEvent extends ExtendableEvent {
  oldSubscription: PushSubscription | null;
  newSubscription: PushSubscription | null;
}
declare const self: {
  registration: ServiceWorkerRegistration;
  clients: {
    claim(): Promise<void>;
    matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<WindowLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  navigator: Navigator;
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "push", fn: (e: PushEvent) => void): void;
  addEventListener(type: "notificationclick", fn: (e: NotificationEvent) => void): void;
  addEventListener(type: "pushsubscriptionchange", fn: (e: PushSubscriptionChangeEvent) => void): void;
};

// A new build takes over at once: there's no cache to keep consistent.
self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const nav = self.navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

const ctx: SwContext = {
  showNotification: (title, options) => self.registration.showNotification(title, options),
  getNotifications: () => self.registration.getNotifications(),
  windows: () => self.clients.matchAll({ type: "window", includeUncontrolled: true }),
  openWindow: (url) => self.clients.openWindow(url),
  fetch: (input, init) => fetch(input, init),
  // The number on the Home Screen icon (iOS 16.4+, Chrome and Edge installed apps).
  setBadge: async (n) => {
    if (n > 0) await nav.setAppBadge?.(n);
    else await nav.clearAppBadge?.();
  },
  subscribe: (options) => self.registration.pushManager.subscribe(options),
  images: { icon, badge },
};

self.addEventListener("push", (e) => e.waitUntil(handlePush(ctx, () => e.data?.json())));

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(handleClick(ctx, e.notification.data, e.action));
});

self.addEventListener("pushsubscriptionchange", (e) => e.waitUntil(handleSubscriptionChange(ctx, e.oldSubscription, e.newSubscription).catch(() => undefined)));
