export type JobKind =
  | "discovery"
  | "fly_deploy"
  | "fly_rollback"
  | "fly_deploy.discharge_create_app"
  | "fly_deploy.ensure_checkpoint"
  | "fly_deploy.create_or_update_machine"
  | "fly_deploy.wait_running";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRow {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  parent_job_id: string | null;
  payload_json: string;
  result_json: string | null;
  last_error: string | null;
  attempt_id: string | null;
  lock_key: string | null;
  last_heartbeat_at: number | null;
  ux_progress_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  available_at: number | null;
}

/** UX-only progress hint set by ctx.progress() and surfaced by the
 *  aggregate /api/jobs/:id endpoint. Not load-bearing — null is fine. */
export interface UxProgress {
  /** Short human label, e.g. "Building image". */
  label: string;
  /** Optional secondary detail, e.g. "layer 3 of 7". */
  detail?: string;
  /** Optional 0–1 progress for a determinate operation. */
  fraction?: number;
}

export interface JobRecord {
  id: string;
  userId: string;
  kind: JobKind;
  status: JobStatus;
  parentJobId: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  lastError: string | null;
  attemptId: string | null;
  lockKey: string | null;
  lastHeartbeatAt: number | null;
  uxProgress: UxProgress | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  availableAt: number | null;
}

/** Body of every CF queue message: just the jobId. */
export interface QueueEnvelope {
  jobId: string;
}

// ----- Per-kind payload + result types ----------------------------

export interface DiscoveryPayload {
  connectionId: string;
}
export interface DiscoveryResult {
  sourceCount: number;
  durationMs: number;
}

/** fly_deploy is the parent. Its kids do the real work. The parent
 *  payload carries the inputs every step needs to look up. */
export interface FlyDeployPayload {
  deploymentId: string;
  deployTargetId: string;
  orgSlug?: string;
  region?: string;
}
export interface FlyRollbackPayload extends FlyDeployPayload {rollbackId:string;deadline:number;}

/** Step 1: discharge the Fly token, resolve org slug, create app
 *  (idempotent). Each provider step independently loads discharged auth;
 *  credentials never enter persisted queue payloads or results. */
export interface FlyDischargeCreateAppPayload {
  parentPayload: FlyDeployPayload;
  appName: string;
  /** Absent on pre-issued-runtime queued app steps. */
  issuedRuntime?: boolean;
}

/** Machine installation: follows checkpoint preparation for new chains,
 * or app creation directly for pre-runtime queued chains. */
export interface FlyCreateOrUpdateMachinePayload {
  parentPayload: FlyDeployPayload;
  appName: string;
  orgSlug: string;
  region: string;
  /** Stable checkpoint reference prepared by the preceding storage step. */
  volumeId?: string;
  /** Exact retained intent when storage preparation is bypassed for recovery. */
  installationId?: string;
  /** Fixed deadline retained by asynchronous replacement continuations. */
  installDeadline?: number;
}

/** Poll health and, for issued-runtime installations, the exact accepted
 * runtime acknowledgement. Enqueue a sibling at +5s until the deadline. */
export interface FlyWaitRunningPayload {
  parentPayload: FlyDeployPayload;
  appName: string;
  machineId: string;
  /** ms epoch by which the machine must be running, else fail. */
  pollDeadline: number;
  /** Graph base installed by this attempt; absent only on pre-fence queued jobs. */
  configurationVersion?: number;
  /** Durable private provider installation, absent on pre-journal jobs. */
  installationId?: string;
}

export interface FlyDeployResult {
  appName: string;
  machineId?: string;
  orgSlug: string;
  region: string;
  appUrl: string;
  machineState?: string;
}

export function lockKeyForFlyDeploy(deploymentId: string): string {
  return `fly_deploy:${deploymentId}`;
}

export function lockKeyForDiscovery(connectionId: string): string {
  return `discovery:${connectionId}`;
}

export function jobRowToRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    parentJobId: row.parent_job_id,
    payload: row.payload_json
      ? (JSON.parse(row.payload_json) as Record<string, unknown>)
      : {},
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : null,
    lastError: row.last_error,
    attemptId: row.attempt_id,
    lockKey: row.lock_key,
    lastHeartbeatAt: row.last_heartbeat_at,
    uxProgress: row.ux_progress_json
      ? (JSON.parse(row.ux_progress_json) as UxProgress)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    availableAt: row.available_at,
  };
}
