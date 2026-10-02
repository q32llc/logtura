import type { Env } from "../env";
import { recordOpsEvent } from "../ops-events";
import { JobDriver } from "./driver";
import { runDiscovery } from "./handlers/discovery";
import { runFlyEnsureCheckpoint } from "./handlers/fly-checkpoint";
import {
  runFlyDeploy,
  runFlyDischargeCreateApp,
  runFlyCreateOrUpdateMachine,
  runFlyWaitRunning,
} from "./handlers/fly-deploy";
import type { JobKind, JobRecord, QueueEnvelope, UxProgress } from "./types";

/** Cap each handler invocation well below CF Workers' 30s subrequest
 *  budget. When the timer fires, we abort the in-flight handler and
 *  write a terminal `failed` state from the same Worker invocation
 *  before CF kills us. attempt_id gating prevents the runaway-but-
 *  not-yet-killed handler from clobbering future re-claims. */
const SELF_KILL_BUDGET_MS = 25_000;

/**
 * Handler context. Handlers run inside a budget-bound `processOne`
 * that injects an AbortSignal into every fetch. They can:
 *
 *   - `enqueueSibling(...)` to chain follow-up steps. Spawn-before-
 *     return so the rollup never sees an "all kids terminal" gap.
 *   - `events.record(...)` to write to ops_events for the audit trail.
 *   - read `signal` and pass it to `fetch` so the self-kill works.
 */
export interface JobHandlerCtx {
  env: Env;
  driver: JobDriver;
  job: JobRecord;
  signal: AbortSignal;
  enqueueSibling: <P extends Record<string, unknown>>(input: {
    kind: JobKind;
    payload: P;
    lockKey?: string;
    delaySecs?: number;
  }) => Promise<JobRecord>;
  events: {
    record: (input: {
      kind: string;
      severity?: "info" | "warn" | "error";
      message: string;
      payload?: Record<string, unknown> | null;
    }) => Promise<void>;
  };
  /** UX-only status hint surfaced by the aggregate /api/jobs/:id
   *  endpoint. Use for "what's the user looking at right now"
   *  ("Building image", "Pushing layer 3 of 7"). Not load-bearing —
   *  pass null to clear. */
  progress: (input: UxProgress | null) => Promise<void>;
}

export type JobHandler = (
  ctx: JobHandlerCtx,
) => Promise<unknown>;

/**
 * Dispatch table. Adding a new job kind = add a handler here. There
 * is no per-kind retry/dedupe metadata — those live at enqueue time
 * (lockKey, delaySecs) and are decided by the caller.
 */
const HANDLERS: Partial<Record<JobKind, JobHandler>> = {
  discovery: runDiscovery,
  fly_deploy: runFlyDeploy,
  "fly_deploy.discharge_create_app": runFlyDischargeCreateApp,
  "fly_deploy.ensure_checkpoint": runFlyEnsureCheckpoint,
  "fly_deploy.create_or_update_machine": runFlyCreateOrUpdateMachine,
  "fly_deploy.wait_running": runFlyWaitRunning,
};

export async function processQueueBatch(
  batch: MessageBatch<QueueEnvelope>,
  env: Env,
): Promise<void> {
  const driver = new JobDriver(env.DB, env.JOBS_QUEUE);

  for (const msg of batch.messages) {
    try {
      await processOne(env, driver, msg.body.jobId);
      msg.ack();
    } catch (err) {
      // Reach here only if processOne itself threw — i.e., a D1
      // outage made even the terminal write fail. CF Queue will
      // redeliver; on redelivery, claim() filters status='queued'
      // and a row stuck in 'running' will be no-op'd. Self-kill +
      // attempt_id gating cover the more common "claimed-then-died"
      // case from inside processOne.
      console.error("queue_batch_transport_error", { err: errStr(err) });
      msg.retry();
    }
  }
}

async function processOne(
  env: Env,
  driver: JobDriver,
  jobId: string,
): Promise<void> {
  const job = await driver.claim(jobId);
  if (!job) {
    console.log("job_claim_skipped", { jobId });
    return;
  }
  if (!job.attemptId) {
    // claim() always sets attempt_id; this is just a type guard.
    throw new Error(`job ${jobId} claimed without attempt_id`);
  }
  const attemptId = job.attemptId;

  console.log("job_started", { jobId: job.id, kind: job.kind });

  const handler = HANDLERS[job.kind];
  if (!handler) {
    await driver.complete(job.id, attemptId, "failed", {
      error: `unknown job kind: ${job.kind}`,
    });
    return;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new Error(`self-killed: ${SELF_KILL_BUDGET_MS}ms budget`));
  }, SELF_KILL_BUDGET_MS);

  const ctx: JobHandlerCtx = {
    env,
    driver,
    job,
    signal: ac.signal,
    enqueueSibling: async (input) => {
      const r = await driver.enqueueSibling(job, input);
      return r.job;
    },
    events: {
      record: (input) =>
        recordOpsEvent(env.DB, {
          userId: job.userId,
          jobId: job.id,
          deploymentId: extractDeploymentId(job),
          kind: input.kind,
          severity: input.severity ?? "info",
          message: input.message,
          payload: input.payload ?? null,
        }),
    },
    progress: async (input) => {
      await driver.setProgress(job.id, attemptId, input);
    },
  };

  try {
    const result = await Promise.race([
      handler(ctx),
      abortPromise(ac.signal),
    ]);
    const resultObj =
      result == null
        ? null
        : typeof result === "object"
          ? (result as Record<string, unknown>)
          : { value: result };
    const wrote = await driver.complete(job.id, attemptId, "succeeded", {
      result: resultObj,
    });
    if (!wrote) {
      console.warn("job_complete_skipped_attempt_mismatch", {
        jobId: job.id,
        kind: job.kind,
        attemptId,
      });
    } else {
      console.log("job_succeeded", { jobId: job.id, kind: job.kind });
    }
  } catch (err) {
    const message = errStr(err);
    console.warn("job_failed", { jobId: job.id, kind: job.kind, error: message });
    await driver.complete(job.id, attemptId, "failed", { error: message });
  } finally {
    clearTimeout(timer);
  }
}

/** A promise that rejects when the signal aborts. Lets us race a
 *  handler against the self-kill timer without depending on the
 *  handler to actively check signal.aborted. */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
  });
}

function errStr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Best-effort: pull deploymentId out of common payload shapes for
 *  the ops_events deployment_id column. Lets the audit trail filter
 *  by deployment without each handler having to remember. */
function extractDeploymentId(job: JobRecord): string | null {
  const p = job.payload as Record<string, unknown>;
  const direct = p.deploymentId;
  if (typeof direct === "string") return direct;
  const parent = p.parentPayload as Record<string, unknown> | undefined;
  if (parent && typeof parent.deploymentId === "string")
    return parent.deploymentId;
  return null;
}
