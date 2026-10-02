-- Private provider install intent survives job/process failure. Generated files,
-- environment and rollback config are encrypted, never job/ops-event payloads.
CREATE TABLE managed_installations (
 id TEXT PRIMARY KEY,
 deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 app_name TEXT NOT NULL,
 org_slug TEXT NOT NULL,
 region TEXT NOT NULL,
 configuration_version INTEGER NOT NULL CHECK(configuration_version >= 0),
 payload_encrypted BLOB NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','installed','completed','obsolete')),
 machine_id TEXT,
 installed_configuration_version INTEGER CHECK(installed_configuration_version >= 0),
 lease_token TEXT,
 lease_until INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE UNIQUE INDEX managed_installation_active ON managed_installations(deployment_id)
 WHERE phase IN ('prepared','dispatched','installed');
CREATE INDEX managed_installation_owner ON managed_installations(user_id,deployment_id,created_at);
CREATE TRIGGER managed_installation_intent_immutable BEFORE UPDATE ON managed_installations
WHEN OLD.id IS NOT NEW.id OR OLD.deployment_id IS NOT NEW.deployment_id
 OR OLD.user_id IS NOT NEW.user_id OR OLD.app_name IS NOT NEW.app_name
 OR OLD.org_slug IS NOT NEW.org_slug OR OLD.region IS NOT NEW.region OR OLD.configuration_version IS NOT NEW.configuration_version
 OR OLD.payload_encrypted IS NOT NEW.payload_encrypted OR OLD.created_at IS NOT NEW.created_at
BEGIN
 SELECT RAISE(ABORT,'LOGT_INSTALL_INTENT_IMMUTABLE');
END;
