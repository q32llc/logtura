-- Retain creation identity after deployment deletion: retry never recreates it.
CREATE TABLE deployment_creation_receipts (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, request_json TEXT NOT NULL,
 deployment_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,request_id)
);
CREATE TRIGGER deployment_creation_receipt_immutable BEFORE UPDATE ON deployment_creation_receipts
BEGIN SELECT RAISE(ABORT,'LOGT_CREATION_IMMUTABLE'); END;
