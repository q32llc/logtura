import { newId } from "../crypto";
import {
  type JobKind,
  type JobRecord,
  type JobRow,
  type QueueEnvelope,
  jobRowToRecord,
} from "./types";

const MAX_BACKOFF_MS = 60 * 1000;
const BASE_BACKOFF_MS = 5 * 1000;

export interface EnqueueInput<P> {
  userId: string;
  kind: JobKind;
  payload: P;
  /**
   * If set, only one queued/running job with this key may exist at a
   * time. A second enqueue with the same key short-circuits to return
   * the existing job (deduped: true).
   */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface EnqueueResult {
  job: JobRecord;
  deduped: boolean;
}

export class JobDriver {
  constructor(
    private readonly db: D1Database,
    private readonly queue: Queue<QueueEnvelope>,
  ) {}

  /**
   * Insert a job row + send a CF queue message. Returns deduped:true
   * when an existing active job with the same dedupeKey was found and
   * no new row/message was created.
   */
  async enqueue<P extends Record<string, unknown>>(
    input: EnqueueInput<P>,
  ): Promise<EnqueueResult> {
    if (input.dedupeKey) {
      const active = await this.activeForDedupeKey(input.dedupeKey);
      if (active) return { job: active, deduped: true };
    }

    const id = newId("job");
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO jobs
         (id, user_id, kind, status, payload_json, dedupe_key, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.userId,
        input.kind,
        JSON.stringify(input.payload),
        input.dedupeKey ?? null,
        input.maxAttempts ?? 3,
        now,
        now,
      )
      .run();

    await this.queue.send({ jobId: id });

    const job = await this.getById(id);
    if (!job) throw new Error(`Job ${id} disappeared after insert`);
    return { job, deduped: false };
  }

  async getById(id: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .bind(id)
      .first<JobRow>();
    return row ? jobRowToRecord(row) : null;
  }

  async activeForDedupeKey(key: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE dedupe_key = ? AND status IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(key)
      .first<JobRow>();
    return row ? jobRowToRecord(row) : null;
  }

  async latestForDedupeKey(key: string): Promise<JobRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM jobs WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(key)
      .first<JobRow>();
    return row ? jobRowToRecord(row) : null;
  }

  /**
   * Atomically transition queued → running. Returns null if the row
   * was already claimed by another worker (or didn't exist).
   */
  async claim(id: string): Promise<JobRecord | null> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        `UPDATE jobs
         SET status = 'running',
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .bind(now, now, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;
    return this.getById(id);
  }

  async markSucceeded(
    id: string,
    result: Record<string, unknown> | null,
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE jobs
         SET status = 'succeeded',
             result_json = ?,
             error = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(result ? JSON.stringify(result) : null, now, now, id)
      .run();
  }

  async markFailed(id: string, error: string): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(error, now, now, id)
      .run();
  }

  /**
   * Return job to the queue with a delay, leaving error message for
   * observability. Sends a delayed CF queue message.
   */
  async markRequeued(
    id: string,
    delayMs: number,
    error: string | null,
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE jobs
         SET status = 'queued',
             error = ?,
             available_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(error, now + delayMs, now, id)
      .run();
    await this.queue.send(
      { jobId: id },
      { delaySeconds: Math.ceil(delayMs / 1000) },
    );
  }

  /**
   * Default backoff curve used when a handler throws and the job has
   * remaining attempts. Capped at MAX_BACKOFF_MS.
   */
  retryBackoffMs(attemptCount: number): number {
    return Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** Math.max(0, attemptCount - 1),
    );
  }
}
