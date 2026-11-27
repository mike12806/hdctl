/** What a device can choose to hear about. Lab-wide and group outages count as `endpoint`. */
export const SOURCES = ["endpoint", "alert", "argo", "workflow"] as const;
export type Source = (typeof SOURCES)[number];

export const SEVERITIES = ["critical", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/** Something a source says is wrong right now. */
export interface Problem {
  /** Names the thing, not the occurrence: target:harbor, alert:<fingerprint>, argo:immich:health, github:<repo>:<workflow>. */
  key: string;
  source: Source;
  severity: Severity;
  /** What it's about, for the recovery message: "Harbor". */
  subject: string;
  title: string;
  body: string;
  /** The hdctl page to open. */
  url: string;
  /** The system's own page, if there's one worth linking. */
  link: string | null;
  /** Consecutive evaluations it must be seen in before anyone is told: 1 is at once. */
  threshold: number;
}

/**
 * One feed's answer for one evaluation: what is wrong, and, for each open
 * incident that isn't wrong any more, why. A feed that couldn't be read
 * yields no observation at all, so nothing it covers is opened or resolved:
 * not hearing about a problem is not evidence that it's over.
 */
export interface Observation {
  /** The notify_sources row: endpoint, alert, argo, github, gitea. */
  feed: string;
  source: Source;
  /** The open incidents this feed speaks for: its source's, with keys starting with this. */
  prefix: string;
  problems: Problem[];
  /**
   * For an open incident this feed speaks for that isn't among `problems`:
   * what ended it ("back up (HTTP 200)"), or null when this evaluation can't
   * say (a target hidden behind a lab-wide outage, a rollout in progress).
   */
  resolution(key: string): string | null;
  /**
   * Close an open incident this feed hasn't mentioned for STALE_MS as "no
   * longer reported". Only for feeds where silence means the thing is gone (a
   * deleted workflow drops out of the runs), never where it can mean "still
   * failing, reported as part of something bigger" (a target folded into a
   * lab-wide outage).
   */
  ageOut?: boolean;
}

export type FeedOutcome = { feed: string; observation: Observation } | { feed: string; error: string } | { feed: string; skipped: true };
