-- Drop + rewrite jobs table. Pre-launch, no data preservation.
--
-- The v2 shape supports the worker-queue patterns we actually need:
--   1. Each handler runs in <25s (self-kill before CF's 30s wall).
--   2. Long work is decomposed into a chain of small jobs that
--      enqueueSibling() the next step before markDone — so there's
--      never a moment where every kid is terminal but the next
--      hasn't been queued yet.
--   3. CF Queue's transport-level retry is the only retry mechanism;
--      no app-level retry counters needed.
--   4. attempt_id gating: every claim mints a fresh UUID; every
--      terminal write checks `WHERE id=? AND attempt_id=?`. A worker
--      that comes back from the dead can't clobber a row that's
--      already been re-claimed.
--   5. Tree shape is FLAT: every "step" is a sibling of its peers,
--      sharing parent_job_id. No grandchildren. The rollup query is
--      a single WHERE parent_job_id = ?.

DROP INDEX IF EXISTS idx_jobs_user;
DROP INDEX IF EXISTS idx_jobs_dedupe_status;
DROP INDEX IF EXISTS idx_jobs_dedupe_created;
DROP TABLE IF EXISTS jobs;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- queued | running | succeeded | failed
  status TEXT NOT NULL DEFAULT 'queued',
  -- Parent rollup. NULL = top-level job (the one the UI polls).
  -- Non-NULL = a step kid; siblings share parent_job_id.
  parent_job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  last_error TEXT,
  -- Refreshed at claim time. Used by terminal writes to refuse
  -- stale-handler clobber (the dead-but-still-running worker that
  -- comes back to write a result for a row that's been re-claimed).
  attempt_id TEXT,
  -- Coalesce duplicate enqueues: if a job with the same lock_key is
  -- already queued or running, the second enqueue returns the existing
  -- row instead of queueing again. NULL = no coalescing.
  lock_key TEXT,
  -- Bumped by handlers periodically. Lets a future sweeper detect
  -- "stuck for 10+ min" without falsely reclaiming live work. We
  -- don't ship the sweeper yet — self-kill + attempt_id gating cover
  -- the common cases; this is the seatbelt.
  last_heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  available_at INTEGER
);

CREATE INDEX idx_jobs_user ON jobs(user_id, created_at DESC);
CREATE INDEX idx_jobs_parent ON jobs(parent_job_id, created_at);
CREATE INDEX idx_jobs_lock ON jobs(lock_key, status);
CREATE INDEX idx_jobs_status_heartbeat ON jobs(status, last_heartbeat_at);
