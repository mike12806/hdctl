-- Push notifications (src/notify/). Times are epoch milliseconds, as in 0001.
--
-- Like the rest of D1, this holds only what no backend can give back: which
-- devices asked to be told, and the record of what hdctl told them. Whether
-- anything is wrong right now is always re-read from the source.

-- One row per browser or device that turned notifications on (a Web Push
-- subscription). Delivery preferences are per device: the phone can take
-- critical only while the laptop takes everything.
CREATE TABLE push_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint      TEXT    NOT NULL UNIQUE,
  p256dh        TEXT    NOT NULL,
  auth          TEXT    NOT NULL,
  -- The Access identity that turned it on, and what the device called itself.
  actor         TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  -- Comma-separated: any of endpoint, alert, argo, workflow.
  sources       TEXT    NOT NULL DEFAULT 'endpoint,alert,argo,workflow',
  min_severity  TEXT    NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('critical', 'warning', 'info')),
  recoveries    INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- The push service's last answer: when it last took a message, and its
  -- last refusal, so the device list can say why a phone went quiet.
  last_sent_at  INTEGER,
  last_error    TEXT,
  last_error_at INTEGER
);

-- Everything hdctl decided was wrong, one row per occurrence. `key` names the
-- thing (target:harbor, alert:<fingerprint>, argo:immich:health, ...); at most
-- one row per key is open, which is what makes opening one idempotent across
-- overlapping cron runs. A row is first pending (seen, not yet notified, while
-- it's debounced), then notified, then resolved. Pending rows that clear before
-- their threshold are deleted: they never fired.
CREATE TABLE incidents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key               TEXT    NOT NULL,
  source            TEXT    NOT NULL CHECK (source IN ('endpoint', 'alert', 'argo', 'workflow')),
  severity          TEXT    NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  -- What it's about ("Harbor"), and the current description of what's wrong.
  subject           TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  body              TEXT    NOT NULL,
  -- The hdctl page to open, and the system's own page, if it has one.
  url               TEXT    NOT NULL,
  link              TEXT,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  -- Consecutive evaluations it has been a problem; compared with the source's threshold.
  seen              INTEGER NOT NULL DEFAULT 1,
  notified_at       INTEGER,
  -- The highest severity pushed so far: a rise above it is pushed again.
  notified_severity TEXT    CHECK (notified_severity IN ('critical', 'warning', 'info')),
  -- Whether an opening or escalation actually went out (it doesn't while muted).
  -- Only then is its recovery pushed: nobody wants "resolved" for news they never got.
  announced         INTEGER NOT NULL DEFAULT 0,
  acked_at          INTEGER,
  acked_by          TEXT,
  resolved_at       INTEGER,
  resolution        TEXT
);
CREATE UNIQUE INDEX incidents_open_key ON incidents (key) WHERE resolved_at IS NULL;
CREATE INDEX incidents_source_open ON incidents (source) WHERE resolved_at IS NULL;
CREATE INDEX incidents_resolved_at ON incidents (resolved_at);

-- Muted keys: nothing about them is pushed until `until`. '*' mutes everything.
-- Muted incidents are still recorded and shown.
CREATE TABLE notify_mutes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL,
  until      INTEGER NOT NULL,
  actor      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- Each feed's last evaluation (endpoint, alert, argo, github, gitea), so the
-- page can say how current the record is, and why a feed isn't.
CREATE TABLE notify_sources (
  feed       TEXT    PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  ok_at      INTEGER,
  error      TEXT
);

-- A push a push service didn't take (5xx, 429, no answer), to try again on a
-- later cron run if what it says is still true by then.
CREATE TABLE push_retries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  incident_id     INTEGER NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('open', 'escalate', 'resolve')),
  attempts        INTEGER NOT NULL,
  next_at         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  error           TEXT
);
CREATE INDEX push_retries_next_at ON push_retries (next_at);
