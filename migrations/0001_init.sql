-- Users (one per GitHub identity)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Provider connections (Cloudflare account, etc.). One user has many.
-- credentials_encrypted holds AES-GCM(iv || ciphertext) of the API token.
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_account_id TEXT,
  credentials_encrypted BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_discovered_at INTEGER
);

CREATE INDEX idx_connections_user ON connections(user_id);

-- Discovered log sources for a connection.
-- source_kind examples: 'cf_worker', 'cf_ai_gateway'
-- external_id: provider-native id (worker name, gateway id)
-- selected: 1 = include in generated collector config, 0 = excluded
CREATE TABLE log_sources (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  metadata_json TEXT,
  selected INTEGER NOT NULL DEFAULT 1,
  discovered_at INTEGER NOT NULL,
  UNIQUE(connection_id, source_kind, external_id)
);

CREATE INDEX idx_log_sources_connection ON log_sources(connection_id);
