-- CLI account credentials are separate from forwarder reporting credentials.
CREATE TABLE cli_device_authorizations (
  device_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  requester_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','denied'))
);
CREATE INDEX cli_device_expiry ON cli_device_authorizations(expires_at);
CREATE INDEX cli_device_requester ON cli_device_authorizations(requester_hash, expires_at);

CREATE TABLE cli_account_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_hash TEXT UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX cli_token_user ON cli_account_tokens(user_id, created_at);
