-- ops_events: durable, append-only audit of "things going wrong" (and
-- occasionally interesting things going right). Job error messages
-- already land in jobs.error, but that's per-attempt and gets
-- overwritten on retry; this table preserves the trail. Also a place
-- to record provider-side failures (Fly API 4xx with body, GitHub
-- token revoked, Postmark delivery failed) so the user — and us —
-- can see what happened without `wrangler tail` archaeology.

CREATE TABLE IF NOT EXISTS ops_events (
  id TEXT PRIMARY KEY,
  -- user_id is nullable so we can record system-level events
  -- (cron, queue transport) that aren't tied to a specific user.
  user_id TEXT,
  -- short kebab-case identifier: "fly_api_error", "deploy_failed",
  -- "credential_stale", "heartbeat_silence_alert", etc.
  kind TEXT NOT NULL,
  -- "info" | "warn" | "error". Loose convention; not enforced.
  severity TEXT NOT NULL DEFAULT 'error',
  -- Free-form summary. Keep it short; structured detail goes in
  -- payload_json.
  message TEXT NOT NULL,
  -- Optional foreign refs to make filtering by deployment/job/etc
  -- cheap. Indexed below.
  deployment_id TEXT,
  job_id TEXT,
  connection_id TEXT,
  -- Arbitrary JSON for whatever else the caller wants to record
  -- (response body excerpts, stack hints, request URLs).
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_events_user_created
  ON ops_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_events_deployment
  ON ops_events(deployment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_events_job
  ON ops_events(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_events_kind
  ON ops_events(kind, created_at DESC);
