-- Destinations + Monitors + Sinks: where logs go, what's watched, how
-- the two are wired together. Three layers because each does one thing
-- and grows independently:
--   destinations: reusable endpoints (Slack workspace, generic webhook,
--                 eventually Datadog/Better Stack/S3). One per (user, name).
--   monitors:     selectors with intent (e.g., "errors", "anomaly score
--                 > X"). Optionally scoped to one connection; null = all.
--   sinks:        edges connecting a monitor to a destination, with an
--                 optional per-sink filter refinement.

CREATE TABLE destinations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- AES-GCM(JSON) — driver decides the shape. For webhook this holds
  -- {url, headers}. For slack: {webhookUrl, channel, teamName}.
  config_encrypted BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_destinations_user ON destinations(user_id);

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- null = applies to all connections; non-null = scoped to one
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  -- 'errors', 'level', 'pattern', 'anomaly', 'all'
  filter_kind TEXT NOT NULL,
  -- driver-shaped JSON, e.g. {"pattern": "ERROR.*"} or {"level": "error"}
  filter_config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_monitors_user ON monitors(user_id);
CREATE INDEX idx_monitors_connection ON monitors(connection_id);

CREATE TABLE sinks (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  -- optional per-sink filter refinement; null = no extra filter
  filter_kind TEXT,
  filter_config_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sinks_monitor ON sinks(monitor_id);
CREATE INDEX idx_sinks_destination ON sinks(destination_id);
