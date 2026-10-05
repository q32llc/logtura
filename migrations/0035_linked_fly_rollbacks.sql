-- Owner-authorized linked rollback intent. No resolved machine config or secrets
-- are stored here. Preparing retires reports before any provider lifecycle write.
CREATE TABLE linked_fly_rollbacks (
 deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 request_json TEXT NOT NULL,
 binding_request_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('prepared','completed')),
 configuration_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 fence_version INTEGER NOT NULL,
 fence_sequence INTEGER NOT NULL,
 fence_revision TEXT NOT NULL,
 completed_at INTEGER,
 PRIMARY KEY(deployment_id,request_id),
 FOREIGN KEY(deployment_id,binding_request_id) REFERENCES linked_fly_binding_receipts(deployment_id,request_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX linked_fly_rollback_pending ON linked_fly_rollbacks(deployment_id) WHERE status='prepared';
CREATE TRIGGER linked_fly_rollback_prepare_guard BEFORE INSERT ON linked_fly_rollbacks
BEGIN
 SELECT CASE WHEN NEW.status<>'prepared' OR NEW.completed_at IS NOT NULL
  OR NEW.fence_version<>NEW.configuration_version OR NEW.fence_sequence<>json_extract(NEW.request_json,'$.expectedSequence') OR NEW.fence_revision<>json_extract(NEW.request_json,'$.revision') OR NOT EXISTS (
  SELECT 1 FROM deployments d JOIN configuration_versions v ON v.user_id=d.user_id
  JOIN deployment_configuration_state s ON s.deployment_id=d.id
  JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
  JOIN linked_fly_binding_receipts b ON b.deployment_id=d.id AND b.user_id=d.user_id AND b.request_id=NEW.binding_request_id
  WHERE d.id=NEW.deployment_id AND d.user_id=NEW.user_id AND d.managed=0 AND d.target_kind='fly'
   AND json_extract(b.request_json,'$.previousMachineId')<>json_extract(b.request_json,'$.machineId')
   AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.machineId')
   AND d.image_digest=json_extract(NEW.request_json,'$.expectedImageDigest')
   AND json_valid(COALESCE(d.metadata_json,'{}'))
   AND (json_extract(d.metadata_json,'$.appName') IS NULL OR json_extract(d.metadata_json,'$.appName')=json_extract(b.request_json,'$.appName'))
   AND (json_extract(d.metadata_json,'$.orgSlug') IS NULL OR json_extract(d.metadata_json,'$.orgSlug')=json_extract(b.request_json,'$.orgSlug'))
   AND (json_extract(d.metadata_json,'$.region') IS NULL OR json_extract(d.metadata_json,'$.region')=json_extract(b.request_json,'$.region'))
   AND NEW.request_id=json_extract(NEW.request_json,'$.requestId') AND NEW.binding_request_id=json_extract(NEW.request_json,'$.bindingRequestId')
   AND v.version=json_extract(NEW.request_json,'$.expectedConfigurationVersion') AND r.configuration_version=v.version AND NEW.configuration_version=v.version
   AND s.desired_sequence=json_extract(NEW.request_json,'$.expectedSequence') AND r.revision=json_extract(NEW.request_json,'$.revision')
   AND s.active_instance_id IS json_extract(NEW.request_json,'$.expectedInstanceId')
   AND NOT EXISTS (SELECT 1 FROM linked_fly_rollbacks prior WHERE prior.deployment_id=d.id AND prior.binding_request_id=b.request_id)
 ) THEN RAISE(ABORT,'LOGT_FLY_ROLLBACK_CONFLICT') END;
END;
CREATE TRIGGER linked_fly_rollback_prepare_apply AFTER INSERT ON linked_fly_rollbacks
BEGIN
 UPDATE deployment_configuration_state SET active_instance_id=NULL,last_report_sequence=0,applied_sequence=NULL,applied_at=NULL
 WHERE deployment_id=NEW.deployment_id;
END;
CREATE TRIGGER linked_fly_rollback_activation_guard BEFORE UPDATE OF active_instance_id ON deployment_configuration_state
WHEN NEW.active_instance_id IS NOT NULL AND EXISTS (SELECT 1 FROM linked_fly_rollbacks WHERE deployment_id=NEW.deployment_id AND status='prepared')
BEGIN SELECT RAISE(ABORT,'LOGT_FLY_ROLLBACK_PENDING'); END;
CREATE TRIGGER linked_fly_rollback_binding_guard BEFORE INSERT ON linked_fly_binding_receipts
WHEN EXISTS (SELECT 1 FROM linked_fly_rollbacks WHERE deployment_id=NEW.deployment_id AND status='prepared')
BEGIN SELECT RAISE(ABORT,'LOGT_FLY_BINDING_CONFLICT'); END;
CREATE TRIGGER linked_fly_rollback_complete_guard BEFORE UPDATE ON linked_fly_rollbacks
WHEN NEW.status<>OLD.status
BEGIN
 SELECT CASE WHEN OLD.status<>'prepared' OR NEW.status<>'completed' OR NEW.completed_at IS NULL
  OR NEW.deployment_id IS NOT OLD.deployment_id OR NEW.user_id IS NOT OLD.user_id OR NEW.request_id IS NOT OLD.request_id
  OR NEW.request_json IS NOT OLD.request_json OR NEW.binding_request_id IS NOT OLD.binding_request_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.fence_version IS NOT OLD.fence_version OR NEW.fence_sequence IS NOT OLD.fence_sequence OR NEW.fence_revision IS NOT OLD.fence_revision
  OR NEW.configuration_version<>OLD.fence_version+1 OR NOT EXISTS (
   SELECT 1 FROM deployments d JOIN configuration_versions v ON v.user_id=d.user_id
   JOIN deployment_configuration_state s ON s.deployment_id=d.id
   JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
   JOIN linked_fly_binding_receipts b ON b.deployment_id=d.id AND b.user_id=d.user_id AND b.request_id=OLD.binding_request_id
   WHERE d.id=OLD.deployment_id AND d.user_id=OLD.user_id AND d.managed=0 AND d.target_kind='fly'
    AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.machineId')
    AND d.image_digest=json_extract(OLD.request_json,'$.expectedImageDigest')
    AND v.version=OLD.fence_version AND r.configuration_version=v.version
    AND s.active_instance_id IS NULL AND s.desired_sequence=OLD.fence_sequence
    AND r.revision=OLD.fence_revision
  ) THEN RAISE(ABORT,'LOGT_FLY_ROLLBACK_CONFLICT') END;
END;
CREATE TRIGGER linked_fly_rollback_complete_apply AFTER UPDATE ON linked_fly_rollbacks
WHEN NEW.status='completed'
BEGIN
 UPDATE deployments SET
  external_id='fly:'||(SELECT json_extract(request_json,'$.appName') FROM linked_fly_binding_receipts WHERE deployment_id=NEW.deployment_id AND request_id=NEW.binding_request_id)||':'||
   (SELECT json_extract(request_json,'$.previousMachineId') FROM linked_fly_binding_receipts WHERE deployment_id=NEW.deployment_id AND request_id=NEW.binding_request_id),
  image_digest=(SELECT json_extract(request_json,'$.previousImageDigest') FROM linked_fly_binding_receipts WHERE deployment_id=NEW.deployment_id AND request_id=NEW.binding_request_id),
  metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.machineId',(SELECT json_extract(request_json,'$.previousMachineId') FROM linked_fly_binding_receipts WHERE deployment_id=NEW.deployment_id AND request_id=NEW.binding_request_id)),
  status='running',bundle_outdated=1,updated_at=NEW.completed_at
 WHERE id=NEW.deployment_id AND user_id=NEW.user_id;
 UPDATE deployment_configuration_revisions SET configuration_version=NEW.configuration_version
 WHERE deployment_id=NEW.deployment_id AND sequence=NEW.fence_sequence;
 SELECT CASE WHEN (SELECT version FROM configuration_versions WHERE user_id=NEW.user_id) IS NOT NEW.configuration_version
  THEN RAISE(ABORT,'LOGT_FLY_ROLLBACK_CONFLICT') END;
END;

-- Explicit rebases append immutable acknowledgements; original rollback intent
-- and provider payload fingerprints are never rewritten by graph reconciliation.
CREATE TABLE linked_fly_rollback_rebases (
 deployment_id TEXT NOT NULL,
 rollback_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 request_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(deployment_id,rollback_id,request_id),
 FOREIGN KEY(deployment_id,rollback_id) REFERENCES linked_fly_rollbacks(deployment_id,request_id) ON DELETE CASCADE
);
CREATE TRIGGER linked_fly_rollback_rebase_guard BEFORE INSERT ON linked_fly_rollback_rebases
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM linked_fly_rollbacks p JOIN deployments d ON d.id=p.deployment_id AND d.user_id=p.user_id
  JOIN configuration_versions v ON v.user_id=d.user_id JOIN deployment_configuration_state s ON s.deployment_id=d.id
  JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
  JOIN linked_fly_binding_receipts b ON b.deployment_id=d.id AND b.user_id=d.user_id AND b.request_id=p.binding_request_id
  WHERE p.deployment_id=NEW.deployment_id AND p.request_id=NEW.rollback_id AND p.status='prepared'
   AND d.managed=0 AND d.target_kind='fly' AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.machineId')
   AND d.image_digest=json_extract(p.request_json,'$.expectedImageDigest') AND s.active_instance_id IS NULL
   AND NEW.request_id=json_extract(NEW.request_json,'$.requestId')
   AND v.version=json_extract(NEW.request_json,'$.configurationVersion') AND r.configuration_version=v.version
   AND s.desired_sequence=json_extract(NEW.request_json,'$.sequence') AND r.revision=json_extract(NEW.request_json,'$.revision')
   AND v.version>=p.fence_version AND s.desired_sequence>=p.fence_sequence
 ) THEN RAISE(ABORT,'LOGT_FLY_ROLLBACK_CONFLICT') END;
END;
CREATE TRIGGER linked_fly_rollback_rebase_apply AFTER INSERT ON linked_fly_rollback_rebases
BEGIN
 UPDATE linked_fly_rollbacks SET configuration_version=json_extract(NEW.request_json,'$.configurationVersion'),
  fence_version=json_extract(NEW.request_json,'$.configurationVersion'),fence_sequence=json_extract(NEW.request_json,'$.sequence'),fence_revision=json_extract(NEW.request_json,'$.revision')
 WHERE deployment_id=NEW.deployment_id AND request_id=NEW.rollback_id AND status='prepared';
END;
CREATE TRIGGER linked_fly_rollback_fence_guard BEFORE UPDATE ON linked_fly_rollbacks
WHEN NEW.status=OLD.status
BEGIN
 SELECT CASE WHEN OLD.status<>'prepared' OR NEW.completed_at IS NOT OLD.completed_at
  OR NEW.deployment_id IS NOT OLD.deployment_id OR NEW.user_id IS NOT OLD.user_id OR NEW.request_id IS NOT OLD.request_id
  OR NEW.request_json IS NOT OLD.request_json OR NEW.binding_request_id IS NOT OLD.binding_request_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.configuration_version<>NEW.fence_version OR NEW.fence_version<OLD.fence_version OR NEW.fence_sequence<OLD.fence_sequence OR NOT EXISTS (
   SELECT 1 FROM linked_fly_rollback_rebases a WHERE a.deployment_id=OLD.deployment_id AND a.rollback_id=OLD.request_id
    AND json_extract(a.request_json,'$.configurationVersion')=NEW.fence_version AND json_extract(a.request_json,'$.sequence')=NEW.fence_sequence
    AND json_extract(a.request_json,'$.revision')=NEW.fence_revision
  ) THEN RAISE(ABORT,'LOGT_FLY_ROLLBACK_CONFLICT') END;
END;
CREATE TRIGGER linked_fly_rollback_rebase_immutable BEFORE UPDATE ON linked_fly_rollback_rebases
BEGIN SELECT RAISE(ABORT,'LOGT_FLY_ROLLBACK_IMMUTABLE'); END;
