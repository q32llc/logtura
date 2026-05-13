ALTER TABLE connections ADD COLUMN provider_installation_id TEXT;

CREATE INDEX idx_connections_provider_installation
  ON connections(user_id, provider, provider_installation_id);
