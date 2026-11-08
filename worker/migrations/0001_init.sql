-- Health checks: one row per target per cron run (every two minutes), kept
-- for seven days. Times are epoch milliseconds.
CREATE TABLE checks (
  target_id  TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  state      TEXT    NOT NULL CHECK (state IN ('up', 'degraded', 'down')),
  code       INTEGER,
  latency_ms INTEGER,
  detail     TEXT
);
CREATE INDEX checks_target_at ON checks (target_id, at);
CREATE INDEX checks_at ON checks (at);

-- The latest result per target, and since when it has been in that state.
CREATE TABLE target_state (
  target_id  TEXT    PRIMARY KEY,
  state      TEXT    NOT NULL CHECK (state IN ('up', 'degraded', 'down')),
  since      INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  code       INTEGER,
  latency_ms INTEGER,
  detail     TEXT
);

-- Every action hdctl takes on something else (Argo sync, guest reboot,
-- workflow dispatch). Written as 'started' before the call and finished
-- after, so an action that died part-way still leaves a trace.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  target      TEXT    NOT NULL,
  params      TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('started', 'ok', 'error')),
  result      TEXT,
  finished_at INTEGER
);
CREATE INDEX audit_log_at ON audit_log (at);
