-- Additive revision state: existing deployments remain legacy/unreported until
-- an owner issues a desired revision and activates a new forwarder instance.
-- Public manifests contain opaque private-value references, never secret values.
CREATE TABLE deployment_configuration_revisions (
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  revision TEXT NOT NULL,
  document_json TEXT NOT NULL,
  configuration_version INTEGER NOT NULL CHECK(configuration_version >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(deployment_id, sequence)
);
CREATE TABLE deployment_configuration_state (
  deployment_id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  desired_sequence INTEGER NOT NULL,
  applied_sequence INTEGER,
  active_instance_id TEXT,
  last_report_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_report_sequence >= 0),
  applied_at INTEGER,
  CHECK((applied_sequence IS NULL AND applied_at IS NULL) OR
        (applied_sequence IS NOT NULL AND applied_at IS NOT NULL)),
  CHECK(applied_sequence IS NULL OR applied_sequence <= desired_sequence),
  CHECK(last_report_sequence = 0 OR active_instance_id IS NOT NULL),
  FOREIGN KEY(deployment_id, desired_sequence)
    REFERENCES deployment_configuration_revisions(deployment_id, sequence),
  FOREIGN KEY(deployment_id, applied_sequence)
    REFERENCES deployment_configuration_revisions(deployment_id, sequence)
);
-- Account configuration versions fence graph changes; desired sequences fence
-- two writers issuing revisions from the same unchanged graph snapshot.
CREATE TRIGGER deployment_revision_sequence_guard
BEFORE INSERT ON deployment_configuration_revisions
WHEN NEW.sequence != COALESCE((SELECT desired_sequence FROM deployment_configuration_state
                              WHERE deployment_id=NEW.deployment_id),0)+1
BEGIN
  SELECT RAISE(ABORT, 'LOGT_REVISION_CONFLICT');
END;

CREATE TRIGGER configuration_deployment_state_insert AFTER INSERT ON deployment_configuration_state
BEGIN
  UPDATE configuration_versions SET version=version+1
    WHERE user_id=(SELECT user_id FROM deployments WHERE id=NEW.deployment_id);
END;
CREATE TRIGGER configuration_deployment_state_update AFTER UPDATE OF desired_sequence ON deployment_configuration_state
WHEN OLD.desired_sequence IS NOT NEW.desired_sequence
BEGIN
  UPDATE configuration_versions SET version=version+1
    WHERE user_id=(SELECT user_id FROM deployments WHERE id=NEW.deployment_id);
END;
CREATE TRIGGER configuration_deployment_state_delete AFTER DELETE ON deployment_configuration_state
BEGIN
  UPDATE configuration_versions SET version=version+1
    WHERE user_id=(SELECT user_id FROM deployments WHERE id=OLD.deployment_id);
END;
CREATE TRIGGER deployment_revision_immutable BEFORE UPDATE ON deployment_configuration_revisions
WHEN OLD.deployment_id IS NOT NEW.deployment_id OR OLD.sequence IS NOT NEW.sequence
  OR OLD.revision IS NOT NEW.revision OR OLD.document_json IS NOT NEW.document_json
BEGIN
  SELECT RAISE(ABORT, 'LOGT_REVISION_IMMUTABLE');
END;
