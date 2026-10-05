-- Extend the existing receipt CAS to same-machine image updates. Existing
-- replacement receipts and their immutable configuration versions remain intact.
DROP TRIGGER linked_fly_binding_guard;
DROP TRIGGER linked_fly_binding_apply;
CREATE TRIGGER linked_fly_binding_guard BEFORE INSERT ON linked_fly_binding_receipts
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM linked_fly_binding_receipts
  WHERE deployment_id=NEW.deployment_id AND json_extract(request_json,'$.instanceId')=json_extract(NEW.request_json,'$.instanceId'))
  THEN RAISE(ABORT,'LOGT_FLY_BINDING_CONFLICT') END;
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM deployments d
  JOIN configuration_versions v ON v.user_id=d.user_id
  JOIN deployment_configuration_state s ON s.deployment_id=d.id
  JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
  JOIN deployment_instance_receipts i ON i.deployment_id=d.id AND i.user_id=d.user_id AND i.instance_id=s.active_instance_id
  WHERE d.id=NEW.deployment_id AND d.user_id=NEW.user_id AND d.managed=0 AND d.target_kind='fly'
   AND d.external_id='fly:'||json_extract(NEW.request_json,'$.appName')||':'||json_extract(NEW.request_json,'$.previousMachineId')
   AND d.image_digest IS json_extract(NEW.request_json,'$.expectedImageDigest')
   AND json_valid(COALESCE(d.metadata_json,'{}'))
   AND (json_extract(d.metadata_json,'$.appName') IS NULL OR json_extract(d.metadata_json,'$.appName')=json_extract(NEW.request_json,'$.appName'))
   AND (json_extract(d.metadata_json,'$.orgSlug') IS NULL OR json_extract(d.metadata_json,'$.orgSlug')=json_extract(NEW.request_json,'$.orgSlug'))
   AND (json_extract(d.metadata_json,'$.region') IS NULL OR json_extract(d.metadata_json,'$.region')=json_extract(NEW.request_json,'$.region'))
   AND v.version=json_extract(NEW.request_json,'$.expectedConfigurationVersion') AND r.configuration_version=v.version
   AND s.active_instance_id=json_extract(NEW.request_json,'$.instanceId')
   AND s.desired_sequence=json_extract(NEW.request_json,'$.expectedSequence') AND r.revision=json_extract(NEW.request_json,'$.revision')
   AND i.sequence=s.desired_sequence AND i.revision=r.revision
   AND NEW.request_id=json_extract(NEW.request_json,'$.requestId')
   AND NEW.configuration_version=v.version+(json_extract(NEW.request_json,'$.machineId')<>json_extract(NEW.request_json,'$.previousMachineId'))
 ) THEN RAISE(ABORT,'LOGT_FLY_BINDING_CONFLICT') END;
END;
CREATE TRIGGER linked_fly_binding_apply AFTER INSERT ON linked_fly_binding_receipts
BEGIN
 UPDATE deployments SET
  external_id='fly:'||json_extract(NEW.request_json,'$.appName')||':'||json_extract(NEW.request_json,'$.machineId'),
  image_digest=json_extract(NEW.request_json,'$.imageDigest'),
  metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.appName',json_extract(NEW.request_json,'$.appName'),
   '$.machineId',json_extract(NEW.request_json,'$.machineId'),'$.orgSlug',json_extract(NEW.request_json,'$.orgSlug'),'$.region',json_extract(NEW.request_json,'$.region')),
  updated_at=NEW.created_at
 WHERE id=NEW.deployment_id AND user_id=NEW.user_id;
 UPDATE deployment_configuration_revisions SET configuration_version=NEW.configuration_version
 WHERE deployment_id=NEW.deployment_id AND sequence=json_extract(NEW.request_json,'$.expectedSequence');
 SELECT CASE WHEN (SELECT version FROM configuration_versions WHERE user_id=NEW.user_id) IS NOT NEW.configuration_version
  THEN RAISE(ABORT,'LOGT_FLY_BINDING_CONFLICT') END;
END;
