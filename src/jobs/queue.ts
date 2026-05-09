import type { Env } from "../env";
import { JobDriver } from "./driver";
import { runDiscovery } from "./handlers/discovery";
import type { QueueEnvelope } from "./types";

/**
 * Cloudflare Queue consumer. Each message is a `{ jobId }` envelope;
 * we claim the row, dispatch to a handler, and ack/retry based on the
 * outcome. App-level retry (with backoff) is handled here too — the
 * CF Queue retry is reserved for transport-level failures (claim
 * race, tempporary D1 outage).
 */
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
      // Reach here only on a transport-level failure inside processOne
      // itself (e.g. couldn't even update the jobs table). Let CF
      // queue retry transport-level — handler-level errors are caught
      // inside processOne and resolved via app-level retry/fail.
      console.error("queue batch transport error", err);
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
    // Already claimed by another worker, or no longer queued. Ignore.
    console.log("job_claim_skipped", { jobId });
    return;
  }

  console.log("job_started", {
    jobId: job.id,
    kind: job.kind,
    attempt: job.attemptCount,
  });

  try {
    let result: Record<string, unknown> | null = null;
    switch (job.kind) {
      case "discovery":
        result = (await runDiscovery(env, job)) as unknown as Record<
          string,
          unknown
        >;
        break;
      default:
        throw new Error(`unknown job kind: ${job.kind}`);
    }
    await driver.markSucceeded(job.id, result);
    console.log("job_succeeded", { jobId: job.id, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Job failed";
    console.warn("job_failed_attempt", {
      jobId: job.id,
      attempt: job.attemptCount,
      max: job.maxAttempts,
      error: message,
    });
    if (job.attemptCount < job.maxAttempts) {
      const delay = driver.retryBackoffMs(job.attemptCount);
      await driver.markRequeued(job.id, delay, message);
    } else {
      await driver.markFailed(job.id, message);
    }
  }
}
