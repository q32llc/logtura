export type JobKind = "discovery" | "fly_deploy";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRow {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  payload_json: string;
  result_json: string | null;
  error: string | null;
  attempt_count: number;
  max_attempts: number;
  dedupe_key: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  available_at: number | null;
}

export interface JobRecord {
  id: string;
  userId: string;
  kind: JobKind;
  status: JobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attemptCount: number;
  maxAttempts: number;
  dedupeKey: string | null;
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

/** Discovery job payload — just the connection to discover for. */
export interface DiscoveryPayload {
  connectionId: string;
}

/** Discovery job result. */
export interface DiscoveryResult {
  sourceCount: number;
  durationMs: number;
}

/** fly_deploy payload — which deployment to ship, using which target. */
export interface FlyDeployPayload {
  deploymentId: string;
  deployTargetId: string;
  /** Optional override; when omitted, the handler resolves user's
   *  default org via Fly's GraphQL. */
  orgSlug?: string;
  /** Optional override; defaults to "iad". */
  region?: string;
}

export interface FlyDeployResult {
  appName: string;
  machineId: string;
  orgSlug: string;
  region: string;
  appUrl: string;
}

export function dedupeKeyForDiscovery(connectionId: string): string {
  return `discovery:${connectionId}`;
}

export function dedupeKeyForFlyDeploy(deploymentId: string): string {
  return `fly_deploy:${deploymentId}`;
}

export function jobRowToRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    payload: row.payload_json
      ? (JSON.parse(row.payload_json) as Record<string, unknown>)
      : {},
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : null,
    error: row.error,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    availableAt: row.available_at,
  };
}
