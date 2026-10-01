-- Opaque identities distinguish an explicit grant/token replacement from OAuth
-- access/refresh-token renewal. Existing ciphertext and reporting tokens remain.
ALTER TABLE connections ADD COLUMN credential_version TEXT NOT NULL DEFAULT '';
ALTER TABLE connections ADD COLUMN credentials_refresh_nonce TEXT;
UPDATE connections SET credential_version=lower(hex(randomblob(16)));
CREATE TRIGGER connection_credential_identity_insert AFTER INSERT ON connections
WHEN NEW.credential_version=''
BEGIN
  UPDATE connections SET credential_version=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER connection_credential_identity_replace AFTER UPDATE OF credentials_encrypted ON connections
WHEN OLD.credentials_encrypted IS NOT NEW.credentials_encrypted AND OLD.credentials_refresh_nonce IS NEW.credentials_refresh_nonce AND OLD.credential_version IS NEW.credential_version
BEGIN
  UPDATE connections SET credential_version=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
DROP TRIGGER configuration_connections_update;
CREATE TRIGGER configuration_connections_update AFTER UPDATE ON connections
WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id OR OLD.provider IS NOT NEW.provider OR OLD.display_name IS NOT NEW.display_name OR OLD.external_account_id IS NOT NEW.external_account_id OR OLD.provider_installation_id IS NOT NEW.provider_installation_id
  OR (OLD.credentials_encrypted IS NOT NEW.credentials_encrypted AND OLD.credentials_refresh_nonce IS NEW.credentials_refresh_nonce)
  OR (OLD.credential_version!='' AND OLD.credential_version IS NOT NEW.credential_version)
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN (OLD.user_id,NEW.user_id);
END;
