-- Account-wide configuration versions cover both website and CLI mutations.
-- Runtime heartbeat/metrics/status updates intentionally do not advance them.
CREATE TABLE configuration_versions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0)
);
INSERT INTO configuration_versions(user_id) SELECT id FROM users;
CREATE TRIGGER configuration_user_insert AFTER INSERT ON users BEGIN
  INSERT INTO configuration_versions(user_id) VALUES (NEW.id);
END;

-- A guard is inserted and deleted in one D1 batch transaction. A stale guard
-- aborts the entire batch before any graph mutation can execute.
CREATE TABLE configuration_write_guards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0)
);
CREATE TRIGGER configuration_guard_check BEFORE INSERT ON configuration_write_guards
WHEN NOT EXISTS (SELECT 1 FROM configuration_versions WHERE user_id=NEW.user_id AND version=NEW.expected_version)
BEGIN
  SELECT RAISE(ABORT, 'LOGT_CONFIG_CONFLICT');
END;

CREATE TRIGGER configuration_connections_insert AFTER INSERT ON connections
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER configuration_connections_delete AFTER DELETE ON connections
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER configuration_connections_update AFTER UPDATE ON connections
WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id OR OLD.provider IS NOT NEW.provider OR OLD.display_name IS NOT NEW.display_name OR OLD.external_account_id IS NOT NEW.external_account_id OR OLD.credentials_encrypted IS NOT NEW.credentials_encrypted OR OLD.provider_installation_id IS NOT NEW.provider_installation_id
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN (OLD.user_id, NEW.user_id);
END;

CREATE TRIGGER configuration_destinations_insert AFTER INSERT ON destinations
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER configuration_destinations_delete AFTER DELETE ON destinations
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER configuration_destinations_update AFTER UPDATE ON destinations
WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id OR OLD.kind IS NOT NEW.kind OR OLD.display_name IS NOT NEW.display_name OR OLD.config_encrypted IS NOT NEW.config_encrypted
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN (OLD.user_id, NEW.user_id);
END;

CREATE TRIGGER configuration_monitors_insert AFTER INSERT ON monitors
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER configuration_monitors_delete AFTER DELETE ON monitors
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER configuration_monitors_update AFTER UPDATE ON monitors
WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id OR OLD.connection_id IS NOT NEW.connection_id OR OLD.display_name IS NOT NEW.display_name OR OLD.enabled IS NOT NEW.enabled OR OLD.filter_steps_json IS NOT NEW.filter_steps_json
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN (OLD.user_id, NEW.user_id);
END;

CREATE TRIGGER configuration_deploy_targets_insert AFTER INSERT ON deploy_targets
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER configuration_deploy_targets_delete AFTER DELETE ON deploy_targets
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER configuration_deploy_targets_update AFTER UPDATE ON deploy_targets
WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id OR OLD.kind IS NOT NEW.kind OR OLD.display_name IS NOT NEW.display_name OR OLD.external_account_id IS NOT NEW.external_account_id OR OLD.credentials_encrypted IS NOT NEW.credentials_encrypted
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN (OLD.user_id, NEW.user_id);
END;

CREATE TRIGGER configuration_deployments_insert AFTER INSERT ON deployments
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER configuration_deployments_delete AFTER DELETE ON deployments
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER configuration_deployments_update AFTER UPDATE ON deployments
WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id OR OLD.connection_id IS NOT NEW.connection_id OR OLD.deploy_target_id IS NOT NEW.deploy_target_id OR OLD.target_kind IS NOT NEW.target_kind OR OLD.display_name IS NOT NEW.display_name OR OLD.managed IS NOT NEW.managed OR OLD.external_id IS NOT NEW.external_id OR OLD.source_selection_json IS NOT NEW.source_selection_json OR OLD.monitor_selection_json IS NOT NEW.monitor_selection_json OR OLD.heartbeat_target IS NOT NEW.heartbeat_target OR OLD.heartbeat_token IS NOT NEW.heartbeat_token OR OLD.metrics_target IS NOT NEW.metrics_target
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN (OLD.user_id, NEW.user_id);
END;

CREATE TRIGGER configuration_log_sources_insert AFTER INSERT ON log_sources
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=(SELECT user_id FROM connections WHERE id=NEW.connection_id);
END;

CREATE TRIGGER configuration_log_sources_delete AFTER DELETE ON log_sources
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=(SELECT user_id FROM connections WHERE id=OLD.connection_id);
END;

CREATE TRIGGER configuration_log_sources_update AFTER UPDATE ON log_sources
WHEN OLD.id IS NOT NEW.id OR OLD.connection_id IS NOT NEW.connection_id OR OLD.source_kind IS NOT NEW.source_kind OR OLD.external_id IS NOT NEW.external_id OR OLD.display_name IS NOT NEW.display_name OR OLD.metadata_json IS NOT NEW.metadata_json
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN ((SELECT user_id FROM connections WHERE id=OLD.connection_id), (SELECT user_id FROM connections WHERE id=NEW.connection_id));
END;

CREATE TRIGGER configuration_sinks_insert AFTER INSERT ON sinks
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=(SELECT user_id FROM monitors WHERE id=NEW.monitor_id);
END;

CREATE TRIGGER configuration_sinks_delete AFTER DELETE ON sinks
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=(SELECT user_id FROM monitors WHERE id=OLD.monitor_id);
END;

CREATE TRIGGER configuration_sinks_update AFTER UPDATE ON sinks
WHEN OLD.id IS NOT NEW.id OR OLD.monitor_id IS NOT NEW.monitor_id OR OLD.destination_id IS NOT NEW.destination_id OR OLD.filter_steps_json IS NOT NEW.filter_steps_json
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN ((SELECT user_id FROM monitors WHERE id=OLD.monitor_id), (SELECT user_id FROM monitors WHERE id=NEW.monitor_id));
END;

CREATE TRIGGER configuration_deployment_connections_insert AFTER INSERT ON deployment_connections
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=(SELECT user_id FROM deployments WHERE id=NEW.deployment_id);
END;

CREATE TRIGGER configuration_deployment_connections_delete AFTER DELETE ON deployment_connections
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id=(SELECT user_id FROM deployments WHERE id=OLD.deployment_id);
END;

CREATE TRIGGER configuration_deployment_connections_update AFTER UPDATE ON deployment_connections
WHEN OLD.deployment_id IS NOT NEW.deployment_id OR OLD.connection_id IS NOT NEW.connection_id OR OLD.added_at IS NOT NEW.added_at
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN ((SELECT user_id FROM deployments WHERE id=OLD.deployment_id), (SELECT user_id FROM deployments WHERE id=NEW.deployment_id));
END;

