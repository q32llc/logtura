import { describe, expect, it } from "vitest";
import {
  RUNNING_JOB_STALE_MS,
  aggregateStatus,
  isStaleRunningJob,
} from "../../src/jobs/driver";
import type { JobRecord } from "../../src/jobs/types";

function job(input: Partial<JobRecord>): JobRecord {
  const now = Date.now();
  return {
    id: input.id ?? "job_test",
    userId: input.userId ?? "usr_test",
    kind: input.kind ?? "fly_deploy.wait_running",
    status: input.status ?? "queued",
    parentJobId: input.parentJobId ?? null,
    payload: input.payload ?? {},
    result: input.result ?? null,
    lastError: input.lastError ?? null,
    attemptId: input.attemptId ?? null,
    lockKey: input.lockKey ?? null,
    lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    uxProgress: input.uxProgress ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    availableAt: input.availableAt ?? null,
  };
}

describe("job status aggregation", () => {
  it("treats a fresh running child as running", () => {
    const now = Date.now();
    expect(
      aggregateStatus(
        job({ kind: "fly_deploy", status: "succeeded" }),
        [
          job({ status: "succeeded" }),
          job({ status: "running", lastHeartbeatAt: now }),
        ],
        now,
      ),
    ).toBe("running");
  });

  it("treats a stale running child as failed", () => {
    const now = Date.now();
    const staleHeartbeat = now - RUNNING_JOB_STALE_MS - 1;
    const stale = job({ status: "running", lastHeartbeatAt: staleHeartbeat });

    expect(isStaleRunningJob(stale, now)).toBe(true);
    expect(
      aggregateStatus(
        job({ kind: "fly_deploy", status: "succeeded" }),
        [job({ status: "succeeded" }), stale],
        now,
      ),
    ).toBe("failed");
  });
});
