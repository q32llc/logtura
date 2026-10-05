-- Public owner maintenance reservation: private provider payloads stay in CLI archives.
CREATE TABLE linked_fly_cleanups (
 deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,request_json TEXT NOT NULL,binding_request_id TEXT NOT NULL,
 rollback_request_id TEXT,status TEXT NOT NULL CHECK(status IN ('prepared','completed')),
 fence_version INTEGER NOT NULL,fence_sequence INTEGER NOT NULL,fence_revision TEXT NOT NULL,
 created_at INTEGER NOT NULL,completed_at INTEGER,
 PRIMARY KEY(deployment_id,request_id),UNIQUE(deployment_id,binding_request_id),
 FOREIGN KEY(deployment_id,binding_request_id) REFERENCES linked_fly_binding_receipts(deployment_id,request_id) ON DELETE CASCADE,
 FOREIGN KEY(deployment_id,rollback_request_id) REFERENCES linked_fly_rollbacks(deployment_id,request_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX linked_fly_cleanup_pending ON linked_fly_cleanups(deployment_id) WHERE status='prepared';
CREATE TRIGGER linked_fly_cleanup_prepare_guard BEFORE INSERT ON linked_fly_cleanups
BEGIN
 SELECT CASE WHEN NEW.status<>'prepared' OR NEW.completed_at IS NOT NULL
 OR NEW.request_id IS NOT json_extract(NEW.request_json,'$.requestId')
 OR NEW.binding_request_id IS NOT json_extract(NEW.request_json,'$.bindingRequestId')
 OR NEW.rollback_request_id IS NOT json_extract(NEW.request_json,'$.rollbackRequestId')
 OR NEW.fence_version IS NOT json_extract(NEW.request_json,'$.expectedConfigurationVersion')
 OR NEW.fence_sequence IS NOT json_extract(NEW.request_json,'$.expectedSequence')
 OR NEW.fence_revision IS NOT json_extract(NEW.request_json,'$.revision')
 OR NOT EXISTS (
 SELECT 1 FROM deployments d
 JOIN linked_fly_binding_receipts b ON b.deployment_id=d.id AND b.user_id=d.user_id AND b.request_id=NEW.binding_request_id
 JOIN configuration_versions v ON v.user_id=d.user_id
 JOIN deployment_configuration_state s ON s.deployment_id=d.id
 JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
 WHERE d.id=NEW.deployment_id AND d.user_id=NEW.user_id AND d.managed=0 AND d.target_kind='fly'
 AND ((NEW.rollback_request_id IS NULL AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.machineId')) OR (NEW.rollback_request_id IS NOT NULL AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.previousMachineId')))
 AND d.image_digest=json_extract(NEW.request_json,'$.imageDigest')
 AND json_valid(COALESCE(d.metadata_json,'{}'))
 AND (json_extract(d.metadata_json,'$.appName') IS NULL OR json_extract(d.metadata_json,'$.appName')=json_extract(b.request_json,'$.appName'))
 AND (json_extract(d.metadata_json,'$.orgSlug') IS NULL OR json_extract(d.metadata_json,'$.orgSlug')=json_extract(b.request_json,'$.orgSlug'))
 AND (json_extract(d.metadata_json,'$.region') IS NULL OR json_extract(d.metadata_json,'$.region')=json_extract(b.request_json,'$.region'))
 AND json_extract(b.request_json,'$.previousMachineId')<>json_extract(b.request_json,'$.machineId')
 AND s.active_instance_id IS json_extract(NEW.request_json,'$.expectedInstanceId')
 AND ((NEW.rollback_request_id IS NULL AND s.active_instance_id IS NOT NULL AND s.applied_sequence=json_extract(NEW.request_json,'$.expectedSequence') AND s.last_report_sequence>0)
  OR (NEW.rollback_request_id IS NOT NULL AND s.active_instance_id IS NULL AND s.applied_sequence IS NULL AND EXISTS (
   SELECT 1 FROM linked_fly_rollbacks rollback WHERE rollback.deployment_id=NEW.deployment_id AND rollback.request_id=NEW.rollback_request_id
    AND rollback.binding_request_id=NEW.binding_request_id AND rollback.status='completed'
    AND d.image_digest=json_extract(b.request_json,'$.previousImageDigest')
  )))
 AND v.version=NEW.fence_version AND r.configuration_version=v.version AND s.desired_sequence=NEW.fence_sequence AND r.revision=NEW.fence_revision
 AND NOT EXISTS (SELECT 1 FROM linked_fly_rollbacks prior WHERE prior.deployment_id=d.id AND prior.status='prepared')
 ) THEN RAISE(ABORT,'LOGT_FLY_CLEANUP_CONFLICT') END;
END;
CREATE TRIGGER linked_fly_cleanup_activation_guard BEFORE UPDATE OF active_instance_id ON deployment_configuration_state
WHEN NEW.active_instance_id IS NOT OLD.active_instance_id AND EXISTS (SELECT 1 FROM linked_fly_cleanups WHERE deployment_id=NEW.deployment_id AND status='prepared')
BEGIN SELECT RAISE(ABORT,'LOGT_FLY_CLEANUP_PENDING'); END;
CREATE TRIGGER linked_fly_cleanup_binding_guard BEFORE INSERT ON linked_fly_binding_receipts
WHEN EXISTS (SELECT 1 FROM linked_fly_cleanups WHERE deployment_id=NEW.deployment_id AND status='prepared')
BEGIN SELECT RAISE(ABORT,'LOGT_FLY_BINDING_CONFLICT'); END;
CREATE TRIGGER linked_fly_cleanup_rollback_guard BEFORE INSERT ON linked_fly_rollbacks
WHEN EXISTS (SELECT 1 FROM linked_fly_cleanups WHERE deployment_id=NEW.deployment_id AND (status='prepared' OR binding_request_id=NEW.binding_request_id))
BEGIN SELECT RAISE(ABORT,'LOGT_FLY_ROLLBACK_CONFLICT'); END;
CREATE TRIGGER linked_fly_cleanup_complete_guard BEFORE UPDATE ON linked_fly_cleanups
WHEN NEW.status<>OLD.status
BEGIN
 SELECT CASE WHEN OLD.status<>'prepared' OR NEW.status<>'completed' OR NEW.completed_at IS NULL
 OR NEW.deployment_id IS NOT OLD.deployment_id OR NEW.user_id IS NOT OLD.user_id OR NEW.request_id IS NOT OLD.request_id
 OR NEW.request_json IS NOT OLD.request_json OR NEW.binding_request_id IS NOT OLD.binding_request_id OR NEW.rollback_request_id IS NOT OLD.rollback_request_id
 OR NEW.created_at IS NOT OLD.created_at OR NEW.fence_version IS NOT OLD.fence_version OR NEW.fence_sequence IS NOT OLD.fence_sequence OR NEW.fence_revision IS NOT OLD.fence_revision
 OR NOT EXISTS (
 SELECT 1 FROM linked_fly_cleanups p JOIN deployments d ON d.id=p.deployment_id AND d.user_id=p.user_id
 JOIN linked_fly_binding_receipts b ON b.deployment_id=d.id AND b.user_id=d.user_id AND b.request_id=p.binding_request_id
 JOIN configuration_versions v ON v.user_id=d.user_id
 JOIN deployment_configuration_state s ON s.deployment_id=d.id
 JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
 WHERE p.deployment_id=OLD.deployment_id AND p.request_id=OLD.request_id AND d.managed=0 AND d.target_kind='fly'
 AND ((p.rollback_request_id IS NULL AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.machineId')) OR (p.rollback_request_id IS NOT NULL AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.previousMachineId')))
 AND d.image_digest=json_extract(p.request_json,'$.imageDigest')
 AND json_valid(COALESCE(d.metadata_json,'{}'))
 AND (json_extract(d.metadata_json,'$.appName') IS NULL OR json_extract(d.metadata_json,'$.appName')=json_extract(b.request_json,'$.appName'))
 AND (json_extract(d.metadata_json,'$.orgSlug') IS NULL OR json_extract(d.metadata_json,'$.orgSlug')=json_extract(b.request_json,'$.orgSlug'))
 AND (json_extract(d.metadata_json,'$.region') IS NULL OR json_extract(d.metadata_json,'$.region')=json_extract(b.request_json,'$.region'))
 AND json_extract(b.request_json,'$.previousMachineId')<>json_extract(b.request_json,'$.machineId')
 AND s.active_instance_id IS json_extract(p.request_json,'$.expectedInstanceId')
 AND ((p.rollback_request_id IS NULL AND s.active_instance_id IS NOT NULL AND s.applied_sequence=json_extract(p.request_json,'$.expectedSequence') AND s.last_report_sequence>0)
  OR (p.rollback_request_id IS NOT NULL AND s.active_instance_id IS NULL AND s.applied_sequence IS NULL AND EXISTS (
   SELECT 1 FROM linked_fly_rollbacks rollback WHERE rollback.deployment_id=p.deployment_id AND rollback.request_id=p.rollback_request_id
    AND rollback.binding_request_id=p.binding_request_id AND rollback.status='completed'
    AND d.image_digest=json_extract(b.request_json,'$.previousImageDigest')
  )))
 AND v.version=OLD.fence_version AND r.configuration_version=v.version AND s.desired_sequence=OLD.fence_sequence AND r.revision=OLD.fence_revision
 ) THEN RAISE(ABORT,'LOGT_FLY_CLEANUP_CONFLICT') END;
END;
CREATE TABLE linked_fly_cleanup_rebases (
 deployment_id TEXT NOT NULL,cleanup_id TEXT NOT NULL,request_id TEXT NOT NULL,request_json TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(deployment_id,cleanup_id,request_id),
 FOREIGN KEY(deployment_id,cleanup_id) REFERENCES linked_fly_cleanups(deployment_id,request_id) ON DELETE CASCADE
);
CREATE TRIGGER linked_fly_cleanup_rebase_guard BEFORE INSERT ON linked_fly_cleanup_rebases
BEGIN
 SELECT CASE WHEN NEW.request_id IS NOT json_extract(NEW.request_json,'$.requestId') OR NOT EXISTS (
 SELECT 1 FROM linked_fly_cleanups p JOIN deployments d ON d.id=p.deployment_id AND d.user_id=p.user_id
 JOIN linked_fly_binding_receipts b ON b.deployment_id=d.id AND b.user_id=d.user_id AND b.request_id=p.binding_request_id
 JOIN configuration_versions v ON v.user_id=d.user_id
 JOIN deployment_configuration_state s ON s.deployment_id=d.id
 JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
 WHERE p.deployment_id=NEW.deployment_id AND p.request_id=NEW.cleanup_id AND p.status='prepared' AND d.managed=0 AND d.target_kind='fly'
 AND ((p.rollback_request_id IS NULL AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.machineId')) OR (p.rollback_request_id IS NOT NULL AND d.external_id='fly:'||json_extract(b.request_json,'$.appName')||':'||json_extract(b.request_json,'$.previousMachineId')))
 AND d.image_digest=json_extract(p.request_json,'$.imageDigest')
 AND json_valid(COALESCE(d.metadata_json,'{}'))
 AND (json_extract(d.metadata_json,'$.appName') IS NULL OR json_extract(d.metadata_json,'$.appName')=json_extract(b.request_json,'$.appName'))
 AND (json_extract(d.metadata_json,'$.orgSlug') IS NULL OR json_extract(d.metadata_json,'$.orgSlug')=json_extract(b.request_json,'$.orgSlug'))
 AND (json_extract(d.metadata_json,'$.region') IS NULL OR json_extract(d.metadata_json,'$.region')=json_extract(b.request_json,'$.region'))
 AND json_extract(b.request_json,'$.previousMachineId')<>json_extract(b.request_json,'$.machineId')
 AND s.active_instance_id IS json_extract(p.request_json,'$.expectedInstanceId')
 AND ((p.rollback_request_id IS NULL AND s.active_instance_id IS NOT NULL AND s.applied_sequence=json_extract(p.request_json,'$.expectedSequence') AND s.last_report_sequence>0)
  OR (p.rollback_request_id IS NOT NULL AND s.active_instance_id IS NULL AND s.applied_sequence IS NULL AND EXISTS (
   SELECT 1 FROM linked_fly_rollbacks rollback WHERE rollback.deployment_id=p.deployment_id AND rollback.request_id=p.rollback_request_id
    AND rollback.binding_request_id=p.binding_request_id AND rollback.status='completed'
    AND d.image_digest=json_extract(b.request_json,'$.previousImageDigest')
  )))
 AND v.version=json_extract(NEW.request_json,'$.configurationVersion') AND r.configuration_version=v.version
 AND s.desired_sequence=json_extract(NEW.request_json,'$.sequence') AND r.revision=json_extract(NEW.request_json,'$.revision')
 AND v.version>=p.fence_version AND s.desired_sequence>=p.fence_sequence
 ) THEN RAISE(ABORT,'LOGT_FLY_CLEANUP_CONFLICT') END;
END;
CREATE TRIGGER linked_fly_cleanup_rebase_apply AFTER INSERT ON linked_fly_cleanup_rebases
BEGIN
 UPDATE linked_fly_cleanups SET fence_version=json_extract(NEW.request_json,'$.configurationVersion'),
 fence_sequence=json_extract(NEW.request_json,'$.sequence'),fence_revision=json_extract(NEW.request_json,'$.revision')
 WHERE deployment_id=NEW.deployment_id AND request_id=NEW.cleanup_id AND status='prepared';
END;
CREATE TRIGGER linked_fly_cleanup_fence_guard BEFORE UPDATE ON linked_fly_cleanups
WHEN NEW.status=OLD.status
BEGIN
 SELECT CASE WHEN OLD.status<>'prepared' OR NEW.completed_at IS NOT OLD.completed_at
 OR NEW.deployment_id IS NOT OLD.deployment_id OR NEW.user_id IS NOT OLD.user_id OR NEW.request_id IS NOT OLD.request_id
 OR NEW.request_json IS NOT OLD.request_json OR NEW.binding_request_id IS NOT OLD.binding_request_id OR NEW.rollback_request_id IS NOT OLD.rollback_request_id
 OR NEW.created_at IS NOT OLD.created_at OR NEW.fence_version<OLD.fence_version OR NEW.fence_sequence<OLD.fence_sequence OR NOT EXISTS (
  SELECT 1 FROM linked_fly_cleanup_rebases a WHERE a.deployment_id=OLD.deployment_id AND a.cleanup_id=OLD.request_id
   AND json_extract(a.request_json,'$.configurationVersion')=NEW.fence_version AND json_extract(a.request_json,'$.sequence')=NEW.fence_sequence AND json_extract(a.request_json,'$.revision')=NEW.fence_revision
 ) THEN RAISE(ABORT,'LOGT_FLY_CLEANUP_CONFLICT') END;
END;
CREATE TRIGGER linked_fly_cleanup_rebase_immutable BEFORE UPDATE ON linked_fly_cleanup_rebases
BEGIN SELECT RAISE(ABORT,'LOGT_FLY_CLEANUP_IMMUTABLE'); END;
