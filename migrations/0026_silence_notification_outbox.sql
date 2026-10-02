-- Narrow stale-heartbeat scans, independent of encrypted deployment payloads.
CREATE INDEX deployments_silence_candidates
  ON deployments(last_seen_at, id, last_alert_sent_at)
  WHERE status = 'running' AND last_seen_at IS NOT NULL;

-- Notification delivery is independent of the atomic crashed transition.
-- A heartbeat epoch has at most one notification; deletion removes private data.
CREATE TABLE silence_notifications (
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  observed_last_seen_at INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  capture_batch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  PRIMARY KEY (deployment_id, observed_last_seen_at)
);
CREATE INDEX silence_notifications_ready
  ON silence_notifications(next_attempt_at, deployment_id)
  WHERE completed_at IS NULL;
CREATE INDEX silence_notifications_completed
  ON silence_notifications(completed_at)
  WHERE completed_at IS NOT NULL;
CREATE INDEX silence_notifications_capture ON silence_notifications(capture_batch);
