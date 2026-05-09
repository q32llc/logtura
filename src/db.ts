import type { Env } from "./env";
import { decryptSecret, encryptSecret, newId } from "./crypto";
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
  /** AES-GCM(JSON-stringified credential object) — opaque blob, parsed by driver */
  credentials_encrypted: ArrayBuffer;
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
  selected: number;
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

export async function createConnection(
  db: D1Database,
  env: Env,
  input: {
    userId: string;
    provider: string;
    displayName: string;
    externalAccountId: string | null;
    credentials: unknown;
  },
): Promise<ConnectionRow> {
  const id = newId("con");
  const ts = now();
  const json = JSON.stringify(input.credentials);
  const ct = await encryptSecret(json, env.CREDENTIAL_ENCRYPTION_KEY);
  await db
    .prepare(
      `INSERT INTO connections (id, user_id, provider, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.provider,
      input.displayName,
      input.externalAccountId,
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

export async function upsertSources(
  db: D1Database,
  connectionId: string,
  discovered: DiscoveredSource[],
): Promise<void> {
  const ts = now();
  for (const d of discovered) {
    const id = newId("src");
    const meta = d.metadata ? JSON.stringify(d.metadata) : null;
    // INSERT OR IGNORE keeps the existing selected state if the source already
    // existed; only new sources start selected = 1.
    await db
      .prepare(
        `INSERT OR IGNORE INTO log_sources
         (id, connection_id, source_kind, external_id, display_name, metadata_json, selected, discovered_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
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

export async function setSourceSelections(
  db: D1Database,
  connectionId: string,
  selectedIds: Set<string>,
): Promise<void> {
  const all = await listSources(db, connectionId);
  for (const s of all) {
    const sel = selectedIds.has(s.id) ? 1 : 0;
    if (sel !== s.selected) {
      await db
        .prepare("UPDATE log_sources SET selected = ? WHERE id = ?")
        .bind(sel, s.id)
        .run();
    }
  }
}
