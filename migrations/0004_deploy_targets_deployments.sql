-- Deploy targets + Deployments. Orthogonal axes:
--   deploy_targets: customer's cloud-account credentials (Fly token,
--                   DO token, AWS keys, GCP service-account, etc.).
--                   One per (user, kind, account_id).
--   deployments:    a running forwarder instance for a connection,
--                   either logtura-managed (managed=1) or self-managed
--                   (managed=0, no creds needed). Detach is a soft
--                   transition managed=1 → managed=0.
--
-- "Other" is a target id for "customer didn't tell us where" and
-- never has stored credentials; it just produces the generic bundle.

CREATE TABLE deploy_targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- e.g. fly org slug, DO team id, AWS account id
  external_account_id TEXT,
  -- AES-GCM(JSON) — driver decides shape. Only present for named
  -- targets where logtura-managed is possible.
  credentials_encrypted BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_deploy_targets_user ON deploy_targets(user_id);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  deploy_target_id TEXT REFERENCES deploy_targets(id) ON DELETE SET NULL,
  -- denormalized so detached/deleted target rows don't lose context
  target_kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- 1 = logtura is responsible for the deploy; 0 = customer self-managed
  managed INTEGER NOT NULL DEFAULT 0,
  -- e.g. fly app name, DO app id; null until deployed
  external_id TEXT,
  -- 'pending', 'running', 'crashed', 'stopped', 'detached'
  status TEXT NOT NULL DEFAULT 'pending',
  -- driver-shaped JSON for any extra runtime info (region, machine
  -- size, last-deployed bundle hash, etc.)
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX idx_deployments_user ON deployments(user_id);
CREATE INDEX idx_deployments_connection ON deployments(connection_id);
