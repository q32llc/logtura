import type { Env } from "./env";
import { decryptSecret, encryptSecret, newId, newToken } from "./crypto";
import type { DiscoveredSource } from "./providers";

export interface UserRow {
  id: string;
  github_id: string;
  github_login: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  display_name: string;
  external_account_id: string | null;
  provider_installation_id: string | null;
  /** AES-GCM(JSON-stringified credential object) — opaque blob, parsed by driver */
  credentials_encrypted: ArrayBuffer;
  credential_version?: string;
  credentials_refresh_nonce?: string | null;
  created_at: number;
  updated_at: number;
  last_discovered_at: number | null;
}

export interface LogSourceRow {
  id: string;
  connection_id: string;
  source_kind: string;
  external_id: string;
  display_name: string;
  metadata_json: string | null;
  discovered_at: number;
}

const now = () => Date.now();

export async function upsertGithubUser(
  db: D1Database,
  input: {
    githubId: string;
    githubLogin: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
  },
): Promise<UserRow> {
  const existing = await db
    .prepare("SELECT * FROM users WHERE github_id = ?")
    .bind(input.githubId)
    .first<UserRow>();

  const ts = now();
  if (existing) {
    await db
      .prepare(
        `UPDATE users SET github_login = ?, email = ?, name = ?, avatar_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.githubLogin,
        input.email,
        input.name,
        input.avatarUrl,
        ts,
        existing.id,
      )
      .run();
    return {
      ...existing,
      github_login: input.githubLogin,
      email: input.email,
      name: input.name,
      avatar_url: input.avatarUrl,
      updated_at: ts,
    };
  }

  const id = newId("usr");
  await db
    .prepare(
      `INSERT INTO users (id, github_id, github_login, email, name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.githubId,
      input.githubLogin,
      input.email,
      input.name,
      input.avatarUrl,
      ts,
      ts,
    )
    .run();
  return {
    id,
    github_id: input.githubId,
    github_login: input.githubLogin,
    email: input.email,
    name: input.name,
    avatar_url: input.avatarUrl,
    created_at: ts,
    updated_at: ts,
  };
}

export async function getUserById(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
}

export async function listConnections(
  db: D1Database,
  userId: string,
): Promise<ConnectionRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM connections WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<ConnectionRow>();
  return result.results ?? [];
}

export async function getConnection(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<ConnectionRow | null> {
  return db
    .prepare("SELECT * FROM connections WHERE id = ? AND user_id = ?")
    .bind(connectionId, userId)
    .first<ConnectionRow>();
}

export async function getConnectionByProviderInstallation(
  db: D1Database,
  userId: string,
  provider: string,
  providerInstallationId: string,
): Promise<ConnectionRow | null> {
  return db
    .prepare(
      `SELECT * FROM connections
       WHERE user_id = ? AND provider = ? AND provider_installation_id = ?
       LIMIT 1`,
    )
    .bind(userId, provider, providerInstallationId)
    .first<ConnectionRow>();
}

/**
 * Replace a connection's encrypted credentials in place. Used by the
 * "Reconnect" flow — token rotated in the provider's dashboard, or
 * scopes added — without forcing the user to recreate the connection
 * (which would also recreate deployments that reference it).
 *
 * displayName + externalAccountId are optional updates; pass null to
 * leave them untouched. Returns the updated row.
 */
export async function updateConnectionCredentials(
  db: D1Database,
  env: Env,
  userId: string,
  connectionId: string,
  input: {
    credentials: unknown;
    expectedProvider?: string;
    externalAccountId?: string | null;
    providerInstallationId?: string | null;
    displayName?: string | null;
  },
): Promise<ConnectionRow | null> {
  const existing = await getConnection(db, userId, connectionId);
  if (!existing || (input.expectedProvider !== undefined && existing.provider !== input.expectedProvider)) return null;
  const json = JSON.stringify(input.credentials);
  const ct = await encryptSecret(json, env.CREDENTIAL_ENCRYPTION_KEY);
  const ts = now();
  const updated = await db
    .prepare(
      `UPDATE connections
       SET credentials_encrypted = ?,
           external_account_id = ?,
           provider_installation_id = ?,
           display_name = ?,
           updated_at = ?
       WHERE id = ? AND user_id = ? AND provider = ? AND credentials_encrypted = ?
         AND external_account_id IS ? AND provider_installation_id IS ? AND display_name = ? RETURNING id`,
    )
    .bind(
      ct,
      input.externalAccountId ?? existing.external_account_id,
      input.providerInstallationId ?? existing.provider_installation_id,
      input.displayName ?? existing.display_name,
      ts,
      connectionId,
      userId,
      existing.provider,
      existing.credentials_encrypted,
      existing.external_account_id,
      existing.provider_installation_id,
      existing.display_name,
    )
    .first<{id:string}>();
  if (!updated) return null;
  return getConnection(db, userId, connectionId);
}

/** OAuth renewal is compare-and-swap on the exact credential snapshot, owner
 * and provider. A reconnect or concurrent renewal wins over this stale result.
 * The nonce classifies this write as renewal without changing credential intent. */
export async function refreshConnectionCredentials(db:D1Database,env:Env,connection:ConnectionRow,credentials:unknown):Promise<boolean>{
  const encrypted=await encryptSecret(JSON.stringify(credentials),env.CREDENTIAL_ENCRYPTION_KEY);
  const result=await db.prepare(`UPDATE connections SET credentials_encrypted=?,credentials_refresh_nonce=?,updated_at=?
    WHERE id=? AND user_id=? AND provider=? AND credential_version=? AND credentials_encrypted=?`)
    .bind(encrypted,newToken(),Date.now(),connection.id,connection.user_id,connection.provider,connection.credential_version??"",connection.credentials_encrypted).run();
  return result.meta.changes===1;
}

export async function createConnection(
  db: D1Database,
  env: Env,
  input: {
    userId: string;
    provider: string;
    displayName: string;
    externalAccountId: string | null;
    providerInstallationId?: string | null;
    credentials: unknown;
  },
): Promise<ConnectionRow> {
  const id = newId("con");
  const ts = now();
  const json = JSON.stringify(input.credentials);
  const ct = await encryptSecret(json, env.CREDENTIAL_ENCRYPTION_KEY);
  await db
    .prepare(
      `INSERT INTO connections (id, user_id, provider, display_name, external_account_id, provider_installation_id, credentials_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.provider,
      input.displayName,
      input.externalAccountId,
      input.providerInstallationId ?? null,
      ct,
      ts,
      ts,
    )
    .run();
  return {
    id,
    user_id: input.userId,
    provider: input.provider,
    display_name: input.displayName,
    external_account_id: input.externalAccountId,
    provider_installation_id: input.providerInstallationId ?? null,
    credentials_encrypted: ct.buffer.slice(
      ct.byteOffset,
      ct.byteOffset + ct.byteLength,
    ) as ArrayBuffer,
    created_at: ts,
    updated_at: ts,
    last_discovered_at: null,
  };
}

/**
 * Returns the raw credential object that the driver originally stored.
 * Callers cast to their driver's credential type.
 */
export async function decryptConnectionCredentials<T = unknown>(
  env: Env,
  conn: ConnectionRow,
): Promise<T> {
  const buf = new Uint8Array(conn.credentials_encrypted);
  const json = await decryptSecret(buf, env.CREDENTIAL_ENCRYPTION_KEY);
  return JSON.parse(json) as T;
}

export async function deleteConnection(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM connections WHERE id = ? AND user_id = ?")
    .bind(connectionId, userId)
    .run();
}

export async function markDiscovered(
  db: D1Database,
  connectionId: string,
): Promise<void> {
  await db
    .prepare("UPDATE connections SET last_discovered_at = ? WHERE id = ?")
    .bind(now(), connectionId)
    .run();
}

export async function listSources(
  db: D1Database,
  connectionId: string,
): Promise<LogSourceRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM log_sources WHERE connection_id = ? ORDER BY source_kind, display_name",
    )
    .bind(connectionId)
    .all<LogSourceRow>();
  return result.results ?? [];
}

/** Every source visible to a user, across all their connections.
 *  Used by the deployment Configure tab's flat source picker —
 *  connections are derived from the picker's selection, so the UI
 *  needs one query that returns everything orderable by connection
 *  + name. */
export async function listAllSourcesForUser(
  db: D1Database,
  userId: string,
): Promise<LogSourceRow[]> {
  const result = await db
    .prepare(
      `SELECT s.* FROM log_sources s
       JOIN connections c ON c.id = s.connection_id
       WHERE c.user_id = ?
       ORDER BY s.connection_id, s.source_kind, s.display_name`,
    )
    .bind(userId)
    .all<LogSourceRow>();
  return result.results ?? [];
}

/** Fetch a specific set of source IDs scoped to a user. Validates
 *  ownership via the connection FK (a user can only see sources
 *  whose connection they own). Used by bundle assembly to pull the
 *  selected sources without first knowing which connections they
 *  belong to. */
export async function getSourcesByIdsForUser(
  db: D1Database,
  userId: string,
  sourceIds: string[],
): Promise<LogSourceRow[]> {
  if (sourceIds.length === 0) return [];
  const placeholders = sourceIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT s.* FROM log_sources s
       JOIN connections c ON c.id = s.connection_id
       WHERE c.user_id = ? AND s.id IN (${placeholders})
       ORDER BY s.connection_id, s.source_kind, s.display_name`,
    )
    .bind(userId, ...sourceIds)
    .all<LogSourceRow>();
  return result.results ?? [];
}

/** Look up multiple connections by id, filtered to the user.
 *  Caller already has the list of needed connection IDs (typically
 *  derived from selected sources) and wants the full rows in one
 *  trip. */
export async function getConnectionsByIds(
  db: D1Database,
  userId: string,
  connectionIds: string[],
): Promise<ConnectionRow[]> {
  if (connectionIds.length === 0) return [];
  const placeholders = connectionIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT * FROM connections
       WHERE user_id = ? AND id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .bind(userId, ...connectionIds)
    .all<ConnectionRow>();
  return result.results ?? [];
}

export async function upsertSources(
  db: D1Database,
  connectionId: string,
  discovered: DiscoveredSource[],
): Promise<void> {
  const ts = now();
  for (const d of discovered) {
    const id = newId("src");
    const meta = d.metadata ? JSON.stringify(d.metadata) : null;
    await db
      .prepare(
        `INSERT OR IGNORE INTO log_sources
         (id, connection_id, source_kind, external_id, display_name, metadata_json, discovered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        connectionId,
        d.sourceKind,
        d.externalId,
        d.displayName,
        meta,
        ts,
      )
      .run();
    await db
      .prepare(
        `UPDATE log_sources SET display_name = ?, metadata_json = ?, discovered_at = ?
         WHERE connection_id = ? AND source_kind = ? AND external_id = ?`,
      )
      .bind(
        d.displayName,
        meta,
        ts,
        connectionId,
        d.sourceKind,
        d.externalId,
      )
      .run();
  }
}

// --- Destinations ---------------------------------------------------------

export interface DestinationRow {
  id: string;
  user_id: string;
  kind: string;
  display_name: string;
  config_encrypted: ArrayBuffer;
  created_at: number;
  updated_at: number;
}

export async function listDestinations(
  db: D1Database,
  userId: string,
): Promise<DestinationRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM destinations WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<DestinationRow>();
  return r.results ?? [];
}

export async function getDestination(
  db: D1Database,
  userId: string,
  id: string,
): Promise<DestinationRow | null> {
  return db
    .prepare("SELECT * FROM destinations WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<DestinationRow>();
}

export async function createDestination(
  db: D1Database,
  env: Env,
  input: {
    userId: string;
    kind: string;
    displayName: string;
    config: unknown;
  },
): Promise<DestinationRow> {
  const id = newId("dst");
  const ts = now();
  const ct = await encryptSecret(
    JSON.stringify(input.config),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await db
    .prepare(
      `INSERT INTO destinations
       (id, user_id, kind, display_name, config_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.userId, input.kind, input.displayName, ct, ts, ts)
    .run();
  return {
    id,
    user_id: input.userId,
    kind: input.kind,
    display_name: input.displayName,
    config_encrypted: ct.buffer.slice(
      ct.byteOffset,
      ct.byteOffset + ct.byteLength,
    ) as ArrayBuffer,
    created_at: ts,
    updated_at: ts,
  };
}

export async function decryptDestinationConfig<T = unknown>(
  env: Env,
  d: DestinationRow,
): Promise<T> {
  const buf = new Uint8Array(d.config_encrypted);
  const json = await decryptSecret(buf, env.CREDENTIAL_ENCRYPTION_KEY);
  return JSON.parse(json) as T;
}

export async function deleteDestination(
  db: D1Database,
  userId: string,
  id: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM destinations WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}

// --- Monitors -------------------------------------------------------------

export interface MonitorRow {
  id: string;
  user_id: string;
  connection_id: string | null;
  display_name: string;
  /** JSON array of FilterStep objects; null/empty = pass-through. */
  filter_steps_json: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/**
 * Pipeline step shapes. Stored as JSON in monitors.filter_steps_json
 * and sinks.filter_steps_json. The generator emits one Vector transform
 * per step.
 */
export type FilterStep =
  | { kind: "errors" }
  | { kind: "level"; level: string; mode?: "include" | "exclude" }
  | {
      kind: "match";
      pattern: string;
      mode: "include" | "exclude";
      field?: string;
    }
  | { kind: "rate_limit"; per_minute: number }
  | { kind: "dedup"; window_secs: number; fields?: string[] }
  | { kind: "sample"; rate: number }
  /** Roll up bursts of events into one summary per window. Useful at
   *  the head of an Errors-style monitor: instead of streaming 10k
   *  individual error events to Slack (which Slack rate-limits and
   *  the channel hates), emit one "140,211 errors in 5 min, top
   *  messages: …" line per window. group_by lets you summarize per
   *  script/source; empty = global rollup. */
  | {
      kind: "rollup";
      window_secs: number;
      group_by?: string[];
      max_samples?: number;
    };

export function parseFilterSteps(json: string | null): FilterStep[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed as FilterStep[];
  } catch {
    /* fall through */
  }
  return [];
}

export async function listMonitors(
  db: D1Database,
  userId: string,
): Promise<MonitorRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM monitors WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<MonitorRow>();
  return r.results ?? [];
}

export async function listMonitorsForConnection(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<MonitorRow[]> {
  // Applicable monitors = scoped to this connection OR scoped to all
  // connections (connection_id is null). Both apply at config-gen time.
  const r = await db
    .prepare(
      `SELECT * FROM monitors
       WHERE user_id = ?
         AND enabled = 1
         AND (connection_id = ? OR connection_id IS NULL)
       ORDER BY created_at ASC`,
    )
    .bind(userId, connectionId)
    .all<MonitorRow>();
  return r.results ?? [];
}

export async function getMonitor(
  db: D1Database,
  userId: string,
  id: string,
): Promise<MonitorRow | null> {
  return db
    .prepare("SELECT * FROM monitors WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<MonitorRow>();
}

export async function createMonitor(
  db: D1Database,
  input: {
    userId: string;
    connectionId: string | null;
    displayName: string;
    filterSteps: FilterStep[];
    enabled?: boolean;
  },
): Promise<MonitorRow> {
  const id = newId("mon");
  const ts = now();
  const stepsJson =
    input.filterSteps.length > 0 ? JSON.stringify(input.filterSteps) : null;
  await db
    .prepare(
      `INSERT INTO monitors
       (id, user_id, connection_id, display_name, filter_steps_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.connectionId,
      input.displayName,
      stepsJson,
      input.enabled === false ? 0 : 1,
      ts,
      ts,
    )
    .run();
  return {
    id,
    user_id: input.userId,
    connection_id: input.connectionId,
    display_name: input.displayName,
    filter_steps_json: stepsJson,
    enabled: input.enabled === false ? 0 : 1,
    created_at: ts,
    updated_at: ts,
  };
}

export async function updateMonitor(
  db: D1Database,
  userId: string,
  id: string,
  patch: Partial<{
    displayName: string;
    filterSteps: FilterStep[];
    connectionId: string | null;
    enabled: boolean;
  }>,
): Promise<MonitorRow | null> {
  const existing = await getMonitor(db, userId, id);
  if (!existing) return null;
  const ts = now();
  const steps =
    patch.filterSteps === undefined
      ? existing.filter_steps_json
      : patch.filterSteps.length === 0
        ? null
        : JSON.stringify(patch.filterSteps);
  await db
    .prepare(
      `UPDATE monitors
       SET display_name = ?, filter_steps_json = ?,
           connection_id = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(
      patch.displayName ?? existing.display_name,
      steps,
      patch.connectionId === undefined
        ? existing.connection_id
        : patch.connectionId,
      patch.enabled === undefined
        ? existing.enabled
        : patch.enabled
          ? 1
          : 0,
      ts,
      id,
      userId,
    )
    .run();
  return getMonitor(db, userId, id);
}

export async function deleteMonitor(
  db: D1Database,
  userId: string,
  id: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM monitors WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}

// --- Sinks ----------------------------------------------------------------

export interface SinkRow {
  id: string;
  monitor_id: string;
  destination_id: string;
  /** JSON array of FilterStep objects; null/empty = pass-through. */
  filter_steps_json: string | null;
  created_at: number;
}

export async function listSinksForMonitor(
  db: D1Database,
  monitorId: string,
): Promise<SinkRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM sinks WHERE monitor_id = ? ORDER BY created_at ASC",
    )
    .bind(monitorId)
    .all<SinkRow>();
  return r.results ?? [];
}

export async function listSinksForUser(
  db: D1Database,
  userId: string,
): Promise<SinkRow[]> {
  // Sinks aren't directly user-scoped; we join via monitors.
  const r = await db
    .prepare(
      `SELECT sinks.* FROM sinks
       JOIN monitors ON monitors.id = sinks.monitor_id
       WHERE monitors.user_id = ?
       ORDER BY sinks.created_at ASC`,
    )
    .bind(userId)
    .all<SinkRow>();
  return r.results ?? [];
}

/** Default pipeline steps inserted when a new sink is created with no
 *  explicit steps — see "dedup by default" feedback. Customers can
 *  remove it explicitly. */
export const DEFAULT_SINK_STEPS: FilterStep[] = [
  { kind: "dedup", window_secs: 300, fields: ["message"] },
];

export async function createSink(
  db: D1Database,
  input: {
    monitorId: string;
    destinationId: string;
    filterSteps?: FilterStep[];
  },
): Promise<SinkRow> {
  const id = newId("snk");
  const ts = now();
  const steps = input.filterSteps ?? DEFAULT_SINK_STEPS;
  const stepsJson = steps.length > 0 ? JSON.stringify(steps) : null;
  await db
    .prepare(
      `INSERT INTO sinks
       (id, monitor_id, destination_id, filter_steps_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.monitorId, input.destinationId, stepsJson, ts)
    .run();
  return {
    id,
    monitor_id: input.monitorId,
    destination_id: input.destinationId,
    filter_steps_json: stepsJson,
    created_at: ts,
  };
}

export async function updateSinkSteps(
  db: D1Database,
  userId: string,
  sinkId: string,
  steps: FilterStep[],
): Promise<void> {
  const stepsJson = steps.length > 0 ? JSON.stringify(steps) : null;
  await db
    .prepare(
      `UPDATE sinks SET filter_steps_json = ?
       WHERE id = ? AND monitor_id IN
         (SELECT id FROM monitors WHERE user_id = ?)`,
    )
    .bind(stepsJson, sinkId, userId)
    .run();
}

export async function deleteSink(
  db: D1Database,
  userId: string,
  id: string,
): Promise<void> {
  // Verify ownership via monitor join.
  await db
    .prepare(
      `DELETE FROM sinks WHERE id = ? AND monitor_id IN
       (SELECT id FROM monitors WHERE user_id = ?)`,
    )
    .bind(id, userId)
    .run();
}

// --- Default monitors -----------------------------------------------------

/**
 * Idempotently create the default "Errors" monitor for a user if they
 * don't have any monitors yet. Called after first signup or first
 * connection.
 */
export async function ensureDefaultErrorsMonitor(
  db: D1Database,
  userId: string,
): Promise<MonitorRow | null> {
  const existing = await listMonitors(db, userId);
  if (existing.length > 0) return null;
  return createMonitor(db, {
    userId,
    connectionId: null,
    displayName: "Errors",
    // errors → rollup-by-message-30s. The rollup keeps Slack and email
    // sane during error storms — instead of 140k individual messages
    // overflowing the channel, you get one "X events in 30s, top
    // samples: …" line per window per script. Users can edit the
    // pipeline anytime; default just protects them from day-one floods.
    filterSteps: [
      { kind: "errors" },
      {
        kind: "rollup",
        window_secs: 30,
        group_by: ["script"],
        max_samples: 5,
      },
    ],
  });
}

// --- Deployments ---------------------------------------------------------
//
// A deployment is the unit of "this runs." It owns: which sources from
// its connection to tail, which monitors apply, the deploy target,
// managed flag, and runtime state.

export type DeploymentStatus =
  | "pending"
  | "running"
  | "crashed"
  | "stopped"
  | "detached";

export interface DeploymentRow {
  id: string;
  user_id: string;
  connection_id: string;
  deploy_target_id: string | null;
  target_kind: string;
  display_name: string;
  managed: number;
  external_id: string | null;
  status: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  runtime_env_encrypted?: ArrayBuffer | null;
  graph_selection_json?: string | null;
  source_selection_json: string | null;
  monitor_selection_json: string | null;
  heartbeat_target: string | null;
  heartbeat_token: string | null;
  last_alert_sent_at: number | null;
  /** Where Vector's internal_metrics get shipped. See migration 0011
   *  for the full description; in short: null/"none" = no sink,
   *  "logtura" = ship to us (no time series stored), <destination_id>
   *  = via a configured destination driver. */
  metrics_target: string | null;
  /** JSON-encoded MetricsSnapshot. Latest counter values per
   *  component, plus derived rates and a lifetime_offset that
   *  survives Vector restarts. See src/metrics-snapshot.ts. */
  metrics_snapshot_json: string | null;
  /** 1 = the generated bundle differs from what's running. Cleared
   *  on successful deploy or manual "mark as deployed." See
   *  migration 0013 for the semantics. */
  bundle_outdated: number;
  /** Forwarder image digest the running machine is pinned to. Set
   *  by the deploy job after resolving ghcr.io/.../forwarder:latest
   *  to a concrete sha256. Null on legacy deployments that haven't
   *  redeployed since the digest-pin landed. See migration 0016. */
  image_digest: string | null;
}

export interface DeploymentSelection {
  /** Null = all sources from the connection. Otherwise: log_source IDs. */
  sourceIds: string[] | null;
  /** Null = wildcard (every applicable monitor). Otherwise: monitor IDs. */
  monitorIds: string[] | null;
}

export function parseDeploymentSelection(
  d: DeploymentRow,
): DeploymentSelection {
  return {
    sourceIds: d.source_selection_json
      ? (JSON.parse(d.source_selection_json) as string[])
      : null,
    monitorIds: d.monitor_selection_json
      ? (JSON.parse(d.monitor_selection_json) as string[])
      : null,
  };
}

export async function listDeployments(
  db: D1Database,
  userId: string,
): Promise<DeploymentRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM deployments WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<DeploymentRow>();
  return r.results ?? [];
}

export async function listDeploymentsForConnection(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<DeploymentRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM deployments
       WHERE user_id = ? AND connection_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(userId, connectionId)
    .all<DeploymentRow>();
  return r.results ?? [];
}

export async function getDeployment(
  db: D1Database,
  userId: string,
  id: string,
): Promise<DeploymentRow | null> {
  return db
    .prepare("SELECT * FROM deployments WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<DeploymentRow>();
}

export interface CreateDeploymentInput {
  userId: string;
  /** Anchor connection — kept on the deployments row for app
   *  naming and as the fallback when sourceIds is null. The real
   *  connection set is derived from selected sources at bundle
   *  time, so this is not authoritative for what gets forwarded. */
  connectionId: string;
  displayName: string;
  targetKind: string;
  managed?: boolean;
  deployTargetId?: string | null;
  sourceIds?: string[] | null;
  monitorIds?: string[] | null;
  heartbeatTarget?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function createDeployment(
  db: D1Database,
  input: CreateDeploymentInput,
): Promise<DeploymentRow> {
  const id = newId("dep");
  const ts = now();
  // Per-deployment heartbeat token. The running container uses this to
  // authenticate to POST /api/heartbeat/:id; receiving the request
  // bumps last_seen_at. Random 32 bytes encoded as URL-safe base64.
  const heartbeatToken = newToken();
  await db
    .prepare(
      `INSERT INTO deployments
       (id, user_id, connection_id, deploy_target_id, target_kind, display_name,
        managed, status, metadata_json, source_selection_json,
        monitor_selection_json, heartbeat_target, heartbeat_token,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.connectionId,
      input.deployTargetId ?? null,
      input.targetKind,
      input.displayName,
      input.managed ? 1 : 0,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.sourceIds ? JSON.stringify(input.sourceIds) : null,
      input.monitorIds ? JSON.stringify(input.monitorIds) : null,
      input.heartbeatTarget ?? "logtura",
      heartbeatToken,
      ts,
      ts,
    )
    .run();
  const r = await getDeployment(db, input.userId, id);
  if (!r) throw new Error("deployment vanished after insert");
  return r;
}

// Note: a previous iteration of this file shipped a
// `deployment_connections` join table + helpers
// (listConnectionsForDeployment, setDeploymentConnections) that's
// since been replaced by source-driven derivation. Connections are
// now computed at bundle assembly from `SELECT DISTINCT connection_id
// FROM log_sources WHERE id IN (selected_source_ids)`. The table
// itself stays in the schema (migration 0014) for back-compat with
// rows already in prod but is no longer read or written.

/**
 * Ensure a deployment row has a heartbeat_token; generate + persist
 * one if missing (e.g. rows that predate migration 0007). Returns the
 * token, persistent across calls.
 */
export async function ensureHeartbeatToken(
  db: D1Database,
  deployment: DeploymentRow,
): Promise<string> {
  if (deployment.heartbeat_token) return deployment.heartbeat_token;
  const token = newToken();
  await db
    .prepare(
      "UPDATE deployments SET heartbeat_token = ?, updated_at = ? WHERE id = ?",
    )
    .bind(token, now(), deployment.id)
    .run();
  return token;
}

// --- Deploy targets -------------------------------------------------------

export interface DeployTargetRow {
  id: string;
  user_id: string;
  kind: string;
  display_name: string;
  external_account_id: string | null;
  credentials_encrypted: ArrayBuffer | null;
  created_at: number;
  updated_at: number;
}

export async function listDeployTargets(
  db: D1Database,
  userId: string,
): Promise<DeployTargetRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM deploy_targets WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<DeployTargetRow>();
  return r.results ?? [];
}

export async function getDeployTargetByKind(
  db: D1Database,
  userId: string,
  kind: string,
  externalAccountId?: string | null,
): Promise<DeployTargetRow | null> {
  if (externalAccountId) {
    return db
      .prepare(
        "SELECT * FROM deploy_targets WHERE user_id = ? AND kind = ? AND external_account_id = ? LIMIT 1",
      )
      .bind(userId, kind, externalAccountId)
      .first<DeployTargetRow>();
  }
  return db
    .prepare(
      "SELECT * FROM deploy_targets WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(userId, kind)
    .first<DeployTargetRow>();
}

export async function upsertDeployTarget(
  db: D1Database,
  env: Env,
  input: {
    userId: string;
    kind: string;
    displayName: string;
    externalAccountId: string | null;
    credentials: unknown;
  },
): Promise<DeployTargetRow> {
  // One row per (user, kind, external_account_id). Re-running the
  // connect flow rotates the token in place.
  const existing = await getDeployTargetByKind(
    db,
    input.userId,
    input.kind,
    input.externalAccountId,
  );
  const ts = now();
  const ct = await encryptSecret(
    JSON.stringify(input.credentials),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  if (existing) {
    await db
      .prepare(
        `UPDATE deploy_targets SET display_name = ?, credentials_encrypted = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(input.displayName, ct, ts, existing.id)
      .run();
    return { ...existing, display_name: input.displayName, updated_at: ts };
  }
  const id = newId("dpt");
  await db
    .prepare(
      `INSERT INTO deploy_targets
       (id, user_id, kind, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.kind,
      input.displayName,
      input.externalAccountId,
      ct,
      ts,
      ts,
    )
    .run();
  const r = await db
    .prepare("SELECT * FROM deploy_targets WHERE id = ?")
    .bind(id)
    .first<DeployTargetRow>();
  if (!r) throw new Error("deploy_target vanished after insert");
  return r;
}

/**
 * Mark every deployment owned by `userId` as having an out-of-date
 * bundle. Called from any endpoint that mutates config the
 * generator reads (connection credentials, source selection,
 * monitor/sink/destination CRUD, deployment selection). Cheap and
 * coarse — we don't try to figure out the exact subset of affected
 * deployments. The bool flip is what surfaces the "Redeploy" CTA
 * in the UI; sometimes over-conservative beats silently stale.
 *
 * Skips deployments that are already marked outdated (no-op write).
 */
export async function markUserDeploymentsOutdated(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE deployments SET bundle_outdated = 1, updated_at = ?
       WHERE user_id = ? AND bundle_outdated = 0`,
    )
    .bind(now(), userId)
    .run();
}

/** Clear the outdated flag for one deployment — called by the
 *  fly_deploy job after a successful machine update, and by the
 *  manual "Mark as deployed" button for users who self-deploy. */
export async function markDeploymentDeployed(
  db: D1Database,
  userId: string,
  deploymentId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE deployments SET bundle_outdated = 0, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(now(), deploymentId, userId)
    .run();
}

export async function decryptDeployTargetCredentials<T = unknown>(
  env: Env,
  target: DeployTargetRow,
): Promise<T> {
  if (!target.credentials_encrypted) {
    throw new Error("deploy_target has no stored credentials");
  }
  const buf = new Uint8Array(target.credentials_encrypted);
  const json = await decryptSecret(buf, env.CREDENTIAL_ENCRYPTION_KEY);
  return JSON.parse(json) as T;
}

export async function getDeployTargetById(
  db: D1Database,
  userId: string,
  id: string,
): Promise<DeployTargetRow | null> {
  return db
    .prepare("SELECT * FROM deploy_targets WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<DeployTargetRow>();
}

export async function updateDeployment(
  db: D1Database,
  userId: string,
  id: string,
  patch: Partial<{
    displayName: string;
    managed: boolean;
    sourceIds: string[] | null;
    monitorIds: string[] | null;
    heartbeatTarget: string | null;
    metricsTarget: string | null;
    status: DeploymentStatus;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
    imageDigest: string | null;
  }>,
): Promise<DeploymentRow | null> {
  const existing = await getDeployment(db, userId, id);
  if (!existing) return null;
  const ts = now();
  await db
    .prepare(
      `UPDATE deployments SET
         display_name = ?, managed = ?, status = ?, external_id = ?,
         metadata_json = ?, source_selection_json = ?,
         monitor_selection_json = ?, heartbeat_target = ?,
         metrics_target = ?, image_digest = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(
      patch.displayName ?? existing.display_name,
      patch.managed === undefined
        ? existing.managed
        : patch.managed
          ? 1
          : 0,
      patch.status ?? existing.status,
      patch.externalId === undefined
        ? existing.external_id
        : patch.externalId,
      patch.metadata === undefined
        ? existing.metadata_json
        : patch.metadata
          ? JSON.stringify(patch.metadata)
          : null,
      patch.sourceIds === undefined
        ? existing.source_selection_json
        : patch.sourceIds
          ? JSON.stringify(patch.sourceIds)
          : null,
      patch.monitorIds === undefined
        ? existing.monitor_selection_json
        : patch.monitorIds
          ? JSON.stringify(patch.monitorIds)
          : null,
      patch.heartbeatTarget === undefined
        ? existing.heartbeat_target
        : patch.heartbeatTarget,
      patch.metricsTarget === undefined
        ? existing.metrics_target
        : patch.metricsTarget,
      patch.imageDigest === undefined
        ? existing.image_digest
        : patch.imageDigest,
      ts,
      id,
      userId,
    )
    .run();
  return getDeployment(db, userId, id);
}

export async function deleteDeployment(
  db: D1Database,
  userId: string,
  id: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM deployments WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}
