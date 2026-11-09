import { useSyncExternalStore } from "react";

/**
 * Whether anyone is using this tab. After IDLE_AFTER_MS without input, the
 * tab counts as idle and every poll pauses (see usePoll), so a dashboard left
 * on screen overnight sends nothing to the Worker or the systems behind it.
 * The next input ends it at once, and each poll loads fresh data right away.
 *
 * One tracker for the whole app, so every poll on a page agrees. Its
 * listeners are installed while at least one component is subscribed.
 */

export const IDLE_AFTER_MS = 15 * 60_000;

/** Pointer moves fire constantly; one per second is plenty to count as activity. */
const THROTTLE_MS = 1_000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;

let idle = false;
let lastInput = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

function setIdle(next: boolean) {
  if (idle === next) return;
  idle = next;
  subscribers.forEach((notify) => notify());
}

function arm() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => setIdle(true), IDLE_AFTER_MS);
}

function onInput() {
  const now = Date.now();
  if (!idle && now - lastInput < THROTTLE_MS) return;
  lastInput = now;
  arm();
  setIdle(false);
}

/** Coming back to the tab counts as input. */
function onVisibility() {
  if (document.visibilityState === "visible") onInput();
}

function subscribe(notify: () => void): () => void {
  if (subscribers.size === 0) {
    idle = false;
    lastInput = Date.now();
    arm();
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
  }
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      idle = false;
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

/** True once the tab has had no input for IDLE_AFTER_MS; false again on the next input. */
export function useIdle(): boolean {
  return useSyncExternalStore(subscribe, () => idle, () => false);
}
