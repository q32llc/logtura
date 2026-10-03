-- Opt-in request identities fence late resource INSERTs against cancellation.
-- Ordinary base64 IDs are 26 characters; only UUID receipt IDs occupy this namespace.
-- Keep the guard in WHEN: hosted D1 rejects nested inline CASE END; END; bodies.
CREATE TABLE resource_creation_requests (
 request_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('monitor','destination','sink')),
 resource_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','completed','cancelled','deleted')),
 created_at INTEGER NOT NULL
);
CREATE TRIGGER resource_creation_requests_identity BEFORE UPDATE ON resource_creation_requests
WHEN NEW.request_id != OLD.request_id OR NEW.user_id != OLD.user_id OR NEW.kind != OLD.kind OR NEW.resource_id != OLD.resource_id OR NEW.created_at != OLD.created_at
 OR NOT (NEW.status = OLD.status OR OLD.status='pending' AND NEW.status IN ('completed','cancelled') OR OLD.status='completed' AND NEW.status='deleted')
BEGIN SELECT RAISE(ABORT,'creation_request_immutable'); END;
CREATE TRIGGER monitors_creation_fence BEFORE INSERT ON monitors
WHEN length(NEW.id)=44 AND NEW.id GLOB 'mon_req_*' AND NOT EXISTS(SELECT 1 FROM resource_creation_requests WHERE resource_id=NEW.id AND kind='monitor' AND user_id=NEW.user_id AND status='pending')
BEGIN
 SELECT RAISE(ABORT,'creation_request_cancelled');
END;
CREATE TRIGGER monitors_creation_complete AFTER INSERT ON monitors
BEGIN UPDATE resource_creation_requests SET status='completed' WHERE resource_id=NEW.id AND status='pending'; END;
CREATE TRIGGER monitors_creation_deleted AFTER DELETE ON monitors
BEGIN UPDATE resource_creation_requests SET status='deleted' WHERE resource_id=OLD.id AND status='completed'; END;
CREATE TRIGGER destinations_creation_fence BEFORE INSERT ON destinations
WHEN length(NEW.id)=44 AND NEW.id GLOB 'dst_req_*' AND NOT EXISTS(SELECT 1 FROM resource_creation_requests WHERE resource_id=NEW.id AND kind='destination' AND user_id=NEW.user_id AND status='pending')
BEGIN
 SELECT RAISE(ABORT,'creation_request_cancelled');
END;
CREATE TRIGGER destinations_creation_complete AFTER INSERT ON destinations
BEGIN UPDATE resource_creation_requests SET status='completed' WHERE resource_id=NEW.id AND status='pending'; END;
CREATE TRIGGER destinations_creation_deleted AFTER DELETE ON destinations
BEGIN UPDATE resource_creation_requests SET status='deleted' WHERE resource_id=OLD.id AND status='completed'; END;
CREATE TRIGGER sinks_creation_fence BEFORE INSERT ON sinks
WHEN length(NEW.id)=44 AND NEW.id GLOB 'snk_req_*' AND NOT EXISTS(SELECT 1 FROM resource_creation_requests WHERE resource_id=NEW.id AND kind='sink' AND user_id=(SELECT user_id FROM monitors WHERE id=NEW.monitor_id) AND status='pending')
BEGIN
 SELECT RAISE(ABORT,'creation_request_cancelled');
END;
CREATE TRIGGER sinks_creation_complete AFTER INSERT ON sinks
BEGIN UPDATE resource_creation_requests SET status='completed' WHERE resource_id=NEW.id AND status='pending'; END;
CREATE TRIGGER sinks_creation_deleted AFTER DELETE ON sinks
BEGIN UPDATE resource_creation_requests SET status='deleted' WHERE resource_id=OLD.id AND status='completed'; END;
