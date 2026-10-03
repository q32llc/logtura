-- Immutable private rollback inputs survive queue failure and later updates.
CREATE TABLE managed_rollbacks (
 id TEXT PRIMARY KEY,
 deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 replacement_id TEXT NOT NULL REFERENCES managed_installations(id) ON DELETE CASCADE,
 installation_id TEXT NOT NULL REFERENCES managed_installations(id) ON DELETE CASCADE,
 instance_id TEXT NOT NULL,
 external_id TEXT,
 payload_encrypted BLOB NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('creating','created','switching','installed','rolling_back','rolled_back')),
 machine_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','completed')),
 fence_version INTEGER NOT NULL CHECK(fence_version>=0),
 fence_sequence INTEGER NOT NULL CHECK(fence_sequence>0),
 fence_revision TEXT NOT NULL,
 lease_token TEXT,
 lease_until INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK(status!='completed' OR phase='rolled_back')
);
CREATE UNIQUE INDEX managed_rollback_active ON managed_rollbacks(deployment_id) WHERE status='pending';
CREATE UNIQUE INDEX managed_rollback_replacement ON managed_rollbacks(replacement_id);
CREATE INDEX managed_rollback_owner ON managed_rollbacks(user_id,deployment_id,created_at);
CREATE TRIGGER managed_rollback_immutable BEFORE UPDATE ON managed_rollbacks
WHEN OLD.id IS NOT NEW.id OR OLD.deployment_id IS NOT NEW.deployment_id OR OLD.user_id IS NOT NEW.user_id
 OR OLD.replacement_id IS NOT NEW.replacement_id OR OLD.installation_id IS NOT NEW.installation_id
 OR OLD.instance_id IS NOT NEW.instance_id OR OLD.external_id IS NOT NEW.external_id
 OR OLD.payload_encrypted IS NOT NEW.payload_encrypted OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT,'LOGT_ROLLBACK_INTENT_IMMUTABLE'); END;
-- Native installation claims and new CLI/server issuance cannot race a rollback.
CREATE TRIGGER managed_rollback_install_insert BEFORE INSERT ON managed_installations
WHEN NEW.phase IN ('prepared','dispatched','installed') AND EXISTS
 (SELECT 1 FROM managed_rollbacks WHERE deployment_id=NEW.deployment_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'LOGT_ROLLBACK_ACTIVE'); END;
CREATE TRIGGER managed_rollback_install_update BEFORE UPDATE ON managed_installations
WHEN (NEW.phase IN ('prepared','dispatched','installed') OR NEW.lease_token IS NOT NULL) AND EXISTS
 (SELECT 1 FROM managed_rollbacks WHERE deployment_id=NEW.deployment_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'LOGT_ROLLBACK_ACTIVE'); END;
CREATE TRIGGER managed_rollback_instance_update BEFORE UPDATE OF active_instance_id ON deployment_configuration_state
WHEN NEW.active_instance_id IS NOT NULL AND EXISTS
 (SELECT 1 FROM managed_rollbacks WHERE deployment_id=NEW.deployment_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'LOGT_ROLLBACK_ACTIVE'); END;
-- Abort the whole reservation batch if ownership/fences changed, including
-- an installation claimed after the read but before rollback reservation.
CREATE TRIGGER managed_rollback_reserve BEFORE INSERT ON managed_rollbacks
WHEN NOT EXISTS (SELECT 1 FROM deployments d JOIN configuration_versions v ON v.user_id=d.user_id
 JOIN deployment_configuration_state s ON s.deployment_id=d.id
 JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
 JOIN managed_installations i ON i.id=NEW.installation_id AND i.deployment_id=d.id AND i.user_id=d.user_id
 JOIN managed_installations original ON original.id=NEW.replacement_id AND original.deployment_id=d.id AND original.user_id=d.user_id
 WHERE d.id=NEW.deployment_id AND d.user_id=NEW.user_id AND d.managed=1 AND d.target_kind='fly'
 AND v.version=NEW.fence_version AND s.desired_sequence=NEW.fence_sequence AND r.revision=NEW.fence_revision
 AND s.active_instance_id=NEW.instance_id AND d.external_id IS NEW.external_id
 AND original.replacement_phase IN ('creating','created','switching','installed') AND original.phase!='obsolete'
 AND i.phase IN ('dispatched','installed','completed'))
 OR EXISTS (SELECT 1 FROM managed_installations WHERE deployment_id=NEW.deployment_id AND lease_until>NEW.created_at)
BEGIN SELECT RAISE(ABORT,'LOGT_ROLLBACK_CONFLICT'); END;
