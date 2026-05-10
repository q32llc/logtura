import { newId } from "./crypto";

/**
 * Append-only ops_events log. Use it for anything we'd want to find
 * later via SQL: failed Fly API calls, stale credentials, deploy
 * failures, heartbeat silences. Worker tail captures everything in
 * real time, but tail is ephemeral — this is the durable trail.
 */
export interface RecordOpsEventInput {
  userId?: string | null;
  kind: string;
  severity?: "info" | "warn" | "error";
  message: string;
  deploymentId?: string | null;
  jobId?: string | null;
  connectionId?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function recordOpsEvent(
  db: D1Database,
  input: RecordOpsEventInput,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO ops_events
         (id, user_id, kind, severity, message, deployment_id, job_id, connection_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId("ev"),
        input.userId ?? null,
        input.kind,
        input.severity ?? "error",
        input.message,
        input.deploymentId ?? null,
        input.jobId ?? null,
        input.connectionId ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        Date.now(),
      )
      .run();
  } catch (err) {
    // Never let event recording break the caller. Logging-of-logging
    // failure goes to the worker console only.
    console.error("ops_event_record_failed", {
      kind: input.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
