-- Immutable activation receipts make interrupted activation retryable without
-- replacing the active instance twice. No existing runtime identity is changed.
CREATE TABLE deployment_instance_receipts (
 deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 request_json TEXT NOT NULL,
 instance_id TEXT NOT NULL,
 configuration_version INTEGER NOT NULL CHECK(configuration_version >= 0),
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 revision TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(deployment_id,request_id)
);
CREATE TRIGGER deployment_instance_receipt_immutable BEFORE UPDATE ON deployment_instance_receipts
BEGIN
 SELECT RAISE(ABORT,'LOGT_INSTANCE_RECEIPT_IMMUTABLE');
END;
