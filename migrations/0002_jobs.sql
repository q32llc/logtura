-- Background jobs. Adgiro-style schema, simplified for v0:
-- no parent/child trees, no concurrency_key, no ops-events.
-- Add those columns when we need them.
--
-- dedupe_key acts as both:
--   - the "active dedupe" lock — only one queued/running job per key
--   - the "subject" of the job — find the latest job for a connection by
--     `WHERE dedupe_key = 'discovery:<conn_id>' ORDER BY created_at DESC`
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  dedupe_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  available_at INTEGER
);

CREATE INDEX idx_jobs_user ON jobs(user_id);
CREATE INDEX idx_jobs_dedupe_status ON jobs(dedupe_key, status);
CREATE INDEX idx_jobs_dedupe_created ON jobs(dedupe_key, created_at);
