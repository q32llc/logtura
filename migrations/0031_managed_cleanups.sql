-- Explicit irreversible retirement; encrypted provider snapshots are immutable.
CREATE TABLE managed_cleanups (
 id TEXT PRIMARY KEY,
 deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 replacement_id TEXT NOT NULL REFERENCES managed_installations(id) ON DELETE CASCADE,
 installation_id TEXT NOT NULL REFERENCES managed_installations(id) ON DELETE CASCADE,
 rollback_id TEXT REFERENCES managed_rollbacks(id) ON DELETE CASCADE,
 app_name TEXT NOT NULL,
 survivor_id TEXT NOT NULL,
 retired_id TEXT NOT NULL,
 instance_id TEXT,
 external_id TEXT NOT NULL,
 payload_encrypted BLOB NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('prepared','deleting','deleted')),
 status TEXT NOT NULL CHECK(status IN ('pending','completed')),
 fence_version INTEGER NOT NULL CHECK(fence_version>=0),
 fence_sequence INTEGER NOT NULL CHECK(fence_sequence>0),
 fence_revision TEXT NOT NULL,
 lease_token TEXT,
 lease_until INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK(survivor_id!=retired_id),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK(status!='completed' OR phase='deleted')
);
CREATE UNIQUE INDEX managed_cleanup_active ON managed_cleanups(deployment_id) WHERE status='pending';
CREATE UNIQUE INDEX managed_cleanup_replacement ON managed_cleanups(replacement_id);
CREATE INDEX managed_cleanup_owner ON managed_cleanups(user_id,deployment_id,created_at);
CREATE TRIGGER managed_cleanup_immutable BEFORE UPDATE ON managed_cleanups
WHEN OLD.id IS NOT NEW.id OR OLD.deployment_id IS NOT NEW.deployment_id OR OLD.user_id IS NOT NEW.user_id
 OR OLD.replacement_id IS NOT NEW.replacement_id OR OLD.installation_id IS NOT NEW.installation_id OR OLD.rollback_id IS NOT NEW.rollback_id
 OR OLD.app_name IS NOT NEW.app_name OR OLD.survivor_id IS NOT NEW.survivor_id OR OLD.retired_id IS NOT NEW.retired_id
 OR OLD.instance_id IS NOT NEW.instance_id OR OLD.external_id IS NOT NEW.external_id OR OLD.payload_encrypted IS NOT NEW.payload_encrypted
 OR OLD.created_at IS NOT NEW.created_at OR OLD.fence_sequence IS NOT NEW.fence_sequence OR OLD.fence_revision IS NOT NEW.fence_revision
BEGIN SELECT RAISE(ABORT,'LOGT_CLEANUP_INTENT_IMMUTABLE'); END;
CREATE TRIGGER managed_cleanup_install_insert BEFORE INSERT ON managed_installations
WHEN NEW.phase IN ('prepared','dispatched','installed') AND EXISTS
 (SELECT 1 FROM managed_cleanups WHERE deployment_id=NEW.deployment_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'LOGT_CLEANUP_ACTIVE'); END;
CREATE TRIGGER managed_cleanup_install_update BEFORE UPDATE ON managed_installations
WHEN (NEW.phase IN ('prepared','dispatched','installed') OR NEW.lease_token IS NOT NULL) AND EXISTS
 (SELECT 1 FROM managed_cleanups WHERE deployment_id=NEW.deployment_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'LOGT_CLEANUP_ACTIVE'); END;
CREATE TRIGGER managed_cleanup_state_update BEFORE UPDATE OF active_instance_id,desired_sequence ON deployment_configuration_state
WHEN (NEW.active_instance_id IS NOT OLD.active_instance_id OR NEW.desired_sequence IS NOT OLD.desired_sequence) AND EXISTS
 (SELECT 1 FROM managed_cleanups WHERE deployment_id=NEW.deployment_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'LOGT_CLEANUP_ACTIVE'); END;
CREATE TRIGGER managed_cleanup_rollback_insert BEFORE INSERT ON managed_rollbacks
WHEN EXISTS (SELECT 1 FROM managed_cleanups WHERE deployment_id=NEW.deployment_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'LOGT_CLEANUP_ACTIVE'); END;
-- Same-batch ownership/fence proof. Installation/report races cannot reserve cleanup.
CREATE TRIGGER managed_cleanup_reserve BEFORE INSERT ON managed_cleanups
WHEN NOT EXISTS (
 SELECT 1 FROM deployments d JOIN configuration_versions v ON v.user_id=d.user_id
 JOIN deployment_configuration_state s ON s.deployment_id=d.id
 JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
 JOIN managed_installations original ON original.id=NEW.replacement_id AND original.deployment_id=d.id AND original.user_id=d.user_id
 JOIN managed_installations i ON i.id=NEW.installation_id AND i.deployment_id=d.id AND i.user_id=d.user_id
 WHERE d.id=NEW.deployment_id AND d.user_id=NEW.user_id AND d.managed=1 AND d.target_kind='fly'
 AND v.version=NEW.fence_version AND s.desired_sequence=NEW.fence_sequence AND r.revision=NEW.fence_revision
 AND s.active_instance_id IS NEW.instance_id AND d.external_id=NEW.external_id
 AND (
  (NEW.rollback_id IS NULL AND original.replacement_phase='installed' AND original.phase='completed' AND i.phase='completed' AND i.machine_id=NEW.survivor_id
   AND s.active_instance_id IS NOT NULL AND s.applied_sequence=s.desired_sequence AND s.last_report_sequence>0)
  OR (NEW.rollback_id IS NOT NULL AND original.phase='obsolete' AND s.active_instance_id IS NULL AND s.applied_sequence IS NULL
   AND EXISTS (SELECT 1 FROM managed_rollbacks b WHERE b.id=NEW.rollback_id AND b.deployment_id=d.id AND b.user_id=d.user_id
    AND b.replacement_id=NEW.replacement_id AND b.installation_id=NEW.installation_id AND b.status='completed' AND b.phase='rolled_back'))))
 OR EXISTS (SELECT 1 FROM managed_installations WHERE deployment_id=NEW.deployment_id AND (lease_until>NEW.created_at OR phase IN ('prepared','dispatched','installed')))
 OR EXISTS (SELECT 1 FROM managed_rollbacks WHERE deployment_id=NEW.deployment_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'LOGT_CLEANUP_CONFLICT'); END;
