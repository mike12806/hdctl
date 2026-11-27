-- More notification sources: Uptime Kuma, Proxmox (guests, backups), the
-- network (UniFi) and DNS (Pi-hole). See src/notify/sources.ts.

-- incidents.source had a CHECK listing the first four sources, and SQLite
-- can't change a CHECK in place, so the table is rebuilt without it: the
-- code is what knows the sources (SOURCES in src/notify/types.ts), and a new
-- one shouldn't need another rebuild.
CREATE TABLE incidents_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key               TEXT    NOT NULL,
  source            TEXT    NOT NULL,
  severity          TEXT    NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  subject           TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  body              TEXT    NOT NULL,
  url               TEXT    NOT NULL,
  link              TEXT,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  seen              INTEGER NOT NULL DEFAULT 1,
  notified_at       INTEGER,
  notified_severity TEXT    CHECK (notified_severity IN ('critical', 'warning', 'info')),
  announced         INTEGER NOT NULL DEFAULT 0,
  acked_at          INTEGER,
  acked_by          TEXT,
  resolved_at       INTEGER,
  resolution        TEXT
);
INSERT INTO incidents_new (id, key, source, severity, subject, title, body, url, link, first_seen_at, last_seen_at, seen, notified_at, notified_severity, announced, acked_at, acked_by, resolved_at, resolution)
  SELECT id, key, source, severity, subject, title, body, url, link, first_seen_at, last_seen_at, seen, notified_at, notified_severity, announced, acked_at, acked_by, resolved_at, resolution FROM incidents;
DROP TABLE incidents;
ALTER TABLE incidents_new RENAME TO incidents;
CREATE UNIQUE INDEX incidents_open_key ON incidents (key) WHERE resolved_at IS NULL;
CREATE INDEX incidents_source_open ON incidents (source) WHERE resolved_at IS NULL;
CREATE INDEX incidents_resolved_at ON incidents (resolved_at);

-- Devices that turned notifications on before these sources existed get them
-- too, as a new device would. Each can turn any of them off.
UPDATE push_subscriptions SET sources = sources || ',kuma,proxmox,network,dns';
