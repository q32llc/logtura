-- Manual renderer environment overrides belong to the deployment and remain
-- encrypted. Reporting tokens stay derived from the current deployment token.
ALTER TABLE deployments ADD COLUMN runtime_env_encrypted BLOB;
CREATE TRIGGER configuration_deployment_runtime_environment AFTER UPDATE OF runtime_env_encrypted ON deployments
WHEN OLD.runtime_env_encrypted IS NOT NEW.runtime_env_encrypted
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN (OLD.user_id,NEW.user_id);
  UPDATE deployments SET bundle_outdated=1 WHERE id=NEW.id AND bundle_outdated=0;
END;
