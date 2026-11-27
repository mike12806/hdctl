import type { Runtime } from "../env";
import { NotConfigured } from "../errors";
import type { CheckResult } from "../health";
import { applyObservation, recordFeed, type NotifyEvent } from "./incidents";
import { deliver, retryDue } from "./deliver";
import { observeAlerts, observeArgo, observeBackups, observeEndpoints, observeGitea, observeGithub, observeGuests, observeKuma, observePihole, observeUnifi } from "./sources";
import type { FeedOutcome, Observation } from "./types";

/**
 * One evaluation, run by the every-two-minutes cron right after it probes
 * every endpoint: ask each feed what's wrong, apply that to the incidents,
 * push what changed, and retry earlier pushes that are due.
 *
 * Some feeds are asked every ten minutes rather than every two: the forges (a
 * failed deploy isn't minute-critical, and it keeps GitHub and Gitea from
 * being read across every repository thirty times an hour), backups (they run
 * nightly), and the Pi-holes (each read is a login, and FTL has few API seats).
 */

export const SLOW_EVERY_MIN = 10;

export const slowFeedsDue = (scheduledTime: number) => Math.floor(scheduledTime / 60_000) % SLOW_EVERY_MIN === 0;

async function outcome(feed: string, run: () => Promise<Observation | null>): Promise<FeedOutcome> {
  try {
    const observation = await run();
    return observation ? { feed, observation } : { feed, skipped: true };
  } catch (err) {
    if (err instanceof NotConfigured) return { feed, skipped: true };
    return { feed, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

export async function runNotifications(rt: Runtime, checks: CheckResult[], scheduledTime: number, now = Date.now()) {
  const { env } = rt;
  const feeds: [string, () => Promise<Observation | null>][] = [
    ["endpoint", async () => observeEndpoints(checks)],
    ["alert", () => observeAlerts(env)],
    ["argo", () => observeArgo(env)],
    ["kuma", () => observeKuma(env)],
    ["proxmox", () => observeGuests(env)],
    ["unifi", () => observeUnifi(env)],
  ];
  if (slowFeedsDue(scheduledTime)) {
    feeds.push(["github", () => observeGithub(rt)], ["gitea", () => observeGitea(env)], ["backup", () => observeBackups(env)], ["pihole", () => observePihole(env)]);
  }

  const outcomes = await Promise.all(feeds.map(([feed, run]) => outcome(feed, run)));
  const events: NotifyEvent[] = [];
  for (const o of outcomes) {
    if ("observation" in o) events.push(...(await applyObservation(env, o.observation, now)));
    await recordFeed(env, o.feed, now, "skipped" in o ? "skipped" : { error: "error" in o ? o.error : (o.observation.partial ?? null) });
  }

  const delivered = await deliver(env, events, now);
  const retried = await retryDue(env, now);
  const failedFeeds = outcomes.filter((o): o is { feed: string; error: string } => "error" in o).map((o) => `${o.feed}: ${o.error}`);
  if (events.length || retried || failedFeeds.length) {
    console.log(JSON.stringify({ msg: "notifications", events: events.map((e) => `${e.kind} ${e.incident.key}`), ...delivered, retried, failedFeeds }));
  }
  return { events, delivered, retried };
}
