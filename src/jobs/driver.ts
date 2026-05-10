import { newId, newToken } from "../crypto";
import {
  type JobKind,
  type JobRecord,
  type JobRow,
  type JobStatus,
  type QueueEnvelope,
  type UxProgress,
  jobRowToRecord,
} from "./types";

export interface EnqueueInput<P> {
  userId: string;
  kind: JobKind;
  payload: P;
  /** When set: if a queued/running job with the same lockKey exists,
   *  enqueue is a no-op and returns the existing job (deduped:true).
   *  Use for "user clicked Deploy twice in a row." */
  lockKey?: string;
  /** Parent job id. Top-level jobs (the ones the UI polls) leave
   *  this null; their step kids set it. Sub-steps of a kid become
   *  *more siblings* of the same parent — the tree is FLAT. */
  parentJobId?: string | null;
  /** Defer the queue message by this many seconds. Used by handlers
   *  that re-enqueue themselves to poll something. */
  delaySecs?: number;
}

export interface EnqueueResult {
  job: JobRecord;
  deduped: boolean;
}

/**
 * v2 job driver. See migrations/0009_jobs_v2.sql for the schema
 * rationale and the principles that motivated this rewrite.
 *
 * Key invariants this driver preserves:
 *   - Every claim mints a fresh `attempt_id`. Terminal writes
 *     (`complete`) include `WHERE attempt_id = ?` so a stale handler
 *     cannot clobber a row that's been re-claimed by a later attempt.
 *   - There is no app-level retry counter. CF Queue retries the
 *     transport (the message envelope), and `claim` is the gate that
 *     decides whether the work runs again. App-visible "retries" are
 *     implemented by handlers calling `enqueueSibling` with a delay.
 *   - Long work is decomposed into chained kid jobs. Each handler
 *     does `< 25s` of real work and (optionally) calls
 *     `enqueueSibling` BEFORE returning, so there's never a moment
 *     where every kid is terminal but the next step isn't queued yet.
 */
export class JobDriver {
  constructor(
    private readonly db: D1Database,
    private readonly queue: Queue<QueueEnvelope>,
  ) {}

  async enqueue<P extends Record<string, unknown>>(
    input: EnqueueInput<P>,
  ): Promise<EnqueueResult> {
    if (input.lockKey) {
      const active = await this.activeForLockKey(input.lockKey);
      if (active) return { job: active, deduped: true };
    }

    const id = newId("job");
    const now = Date.now();
    const availableAt =
      input.delaySecs && input.delaySecs > 0
        ? now + input.delaySecs * 1000
        : null;
    await this.db
      .prepare(
        `INSERT INTO jobs
         (id, user_id, kind, status, parent_job_id, payload_json,
          lock_key, created_at, updated_at, available_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.userId,
        input.kind,
        input.parentJobId ?? null,
        JSON.stringify(input.payload),
        input.lockKey ?? null,
        now,
        now,
        availableAt,
      )
      .run();

    await this.queue.send(
      { jobId: id },
      input.delaySecs && input.delaySecs > 0
        ? { delaySeconds: input.delaySecs }
        : undefined,
    );

    const job = await this.getById(id);
    if (!job) throw new Error(`Job ${id} disappeared after insert`);
    return { job, deduped: false };
  }

  /** Enqueue a sibling of `currentJob` — same parent_job_id (or
   *  currentJob's id if it had no parent), inheriting userId. The
   *  spawn-before-markDone discipline means the handler should call
   *  this BEFORE returning, so the rollup view never sees an
   *  "all-kids-terminal" state in between. */
  async enqueueSibling<P extends Record<string, unknown>>(
    currentJob: JobRecord,
    input: { kind: JobKind; payload: P; lockKey?: string; delaySecs?: number },
  ): Promise<EnqueueResult> {
    return this.enqueue({
      userId: currentJob.userId,
      parentJobId: currentJob.parentJobId ?? currentJob.id,
      kind: input.kind,
      payload: input.payload,
      lockKey: input.lockKey,
      delaySecs: input.delaySecs,
    });
  }

  async getById(id: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .bind(id)
      .first<JobRow>();
    return row ? jobRowToRecord(row) : null;
  }

  async listChildren(parentJobId: string): Promise<JobRecord[]> {
    const r = await this.db
      .prepare(
        "SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY created_at ASC",
      )
      .bind(parentJobId)
      .all<JobRow>();
    return (r.results ?? []).map(jobRowToRecord);
  }

  async latestForLockKey(key: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM jobs WHERE lock_key = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(key)
      .first<JobRow>();
    return row ? jobRowToRecord(row) : null;
  }

  async activeForLockKey(key: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE lock_key = ? AND status IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(key)
      .first<JobRow>();
    return row ? jobRowToRecord(row) : null;
  }

  /** Atomically transition queued→running and mint a fresh
   *  attempt_id. Returns null if the row was already claimed
   *  (status not queued) or doesn't exist. */
  async claim(id: string): Promise<JobRecord | null> {
    const now = Date.now();
    const attemptId = newToken();
    const result = await this.db
      .prepare(
        `UPDATE jobs
         SET status = 'running',
             attempt_id = ?,
             started_at = COALESCE(started_at, ?),
             last_heartbeat_at = ?,
             updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .bind(attemptId, now, now, now, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;
    return this.getById(id);
  }

  /** Set the optional UX progress hint for this job. attempt_id-gated
   *  so a stale handler can't overwrite a re-claimed row. Best-effort
   *  — the rollup endpoint reads progress; nothing else acts on it. */
  async setProgress(
    id: string,
    attemptId: string,
    progress: UxProgress | null,
  ): Promise<boolean> {
    const now = Date.now();
    const r = await this.db
      .prepare(
        `UPDATE jobs SET ux_progress_json = ?, updated_at = ?
         WHERE id = ? AND attempt_id = ? AND status = 'running'`,
      )
      .bind(progress ? JSON.stringify(progress) : null, now, id, attemptId)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Bump last_heartbeat_at if the caller is still the active claimer.
   *  Returns false if attempt_id no longer matches (caller is a
   *  zombie writer; should stop). */
  async heartbeat(id: string, attemptId: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        `UPDATE jobs SET last_heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND attempt_id = ? AND status = 'running'`,
      )
      .bind(now, now, id, attemptId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Write a terminal state. Refuses if attempt_id no longer matches
   *  (means a later attempt has already claimed and we're a stale
   *  zombie). Returns true if the write landed. */
  async complete(
    id: string,
    attemptId: string,
    status: "succeeded" | "failed",
    body: { result?: Record<string, unknown> | null; error?: string | null },
  ): Promise<boolean> {
    const now = Date.now();
    const r = await this.db
      .prepare(
        `UPDATE jobs
         SET status = ?,
             result_json = ?,
             last_error = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ? AND attempt_id = ? AND status = 'running'`,
      )
      .bind(
        status,
        body.result !== undefined && body.result !== null
          ? JSON.stringify(body.result)
          : null,
        body.error ?? null,
        now,
        now,
        id,
        attemptId,
      )
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
}

/** Aggregate a parent's status from its kids. Used by the
 *  job-status endpoint and anyone else that wants "how's it going"
 *  without writing to the parent row.
 *
 *  Rule (matches user's call):
 *    - any kid failed       → failed
 *    - all kids succeeded   → succeeded
 *    - else                 → running
 *
 *  When a job has no kids (leaf or yet-to-spawn parent), we fall
 *  back to its own status. */
export function aggregateStatus(
  parent: JobRecord,
  kids: JobRecord[],
): JobStatus {
  if (kids.length === 0) return parent.status;
  let allSucceeded = true;
  for (const k of kids) {
    if (k.status === "failed") return "failed";
    if (k.status !== "succeeded") allSucceeded = false;
  }
  return allSucceeded ? "succeeded" : "running";
}
