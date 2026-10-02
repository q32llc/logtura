-- Durable, public configuration commit receipts. Private uploads are never stored
-- here; request_hash is keyed by the service's private signing key.
CREATE TABLE deployment_push_receipts (
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  configuration_version INTEGER NOT NULL CHECK(configuration_version >= 0),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  revision TEXT NOT NULL,
  document_json TEXT NOT NULL,
  source_aliases_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(deployment_id, request_id)
);
CREATE TRIGGER deployment_push_receipt_immutable BEFORE UPDATE ON deployment_push_receipts
BEGIN
  SELECT RAISE(ABORT, 'LOGT_PUSH_RECEIPT_IMMUTABLE');
END;
-- Receipt writes do not advance account graph versions. Existing deployment,
-- credential, desired/applied, reporting and telemetry state are unchanged.
