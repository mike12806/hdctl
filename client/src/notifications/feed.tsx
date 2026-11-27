import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api, type IncidentFeed } from "../api";
import { usePoll } from "../hooks";
import { syncShown } from "./browser";

/**
 * The incidents feed, read once for the whole app: the Notifications tab's
 * count comes from it on every page, and every fresh read takes answered
 * alarms off this device's lock screen and sets the app icon's badge.
 * Polls like every page does (paused while idle, withheld once stale).
 */

type Feed = ReturnType<typeof usePoll<IncidentFeed>>;

const FeedContext = createContext<Feed | null>(null);

export function IncidentFeedProvider({ children }: { children: ReactNode }) {
  const feed = usePoll(() => api<IncidentFeed>("/api/notify/incidents"), 30_000);
  useEffect(() => {
    if (feed.data) void syncShown(new Set(live(feed.data)));
  }, [feed.data]);
  return <FeedContext.Provider value={feed}>{children}</FeedContext.Provider>;
}

export function useIncidentFeed(): Feed {
  const feed = useContext(FeedContext);
  if (!feed) throw new Error("useIncidentFeed outside IncidentFeedProvider");
  return feed;
}

/** Open and not acknowledged: what the badge counts and what stays on a lock screen. */
export const live = (feed: IncidentFeed) => feed.open.filter((i) => i.ackedAt === null).map((i) => i.id);
