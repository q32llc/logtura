-- Provider storage reservations survive queue/process/response loss. This is
-- operational state: creating/recovering a reservation does not edit the graph.
CREATE TABLE managed_checkpoints (
 id TEXT PRIMARY KEY,
 deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 app_name TEXT NOT NULL,
 org_slug TEXT NOT NULL,
 region TEXT NOT NULL,
 configuration_version INTEGER NOT NULL CHECK(configuration_version >= 0),
 volume_name TEXT NOT NULL,
 size_gb INTEGER NOT NULL CHECK(size_gb >= 1),
 cpu_kind TEXT NOT NULL CHECK(cpu_kind IN ('shared','performance')),
 cpus INTEGER NOT NULL CHECK(cpus >= 1),
 memory_mb INTEGER NOT NULL CHECK(memory_mb >= 1),
 phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','ready','obsolete')),
 volume_id TEXT,
 lease_token TEXT,
 lease_until INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(app_name,volume_name),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK(phase != 'ready' OR volume_id IS NOT NULL),
 CHECK(phase IN ('ready','obsolete') OR volume_id IS NULL)
);
CREATE UNIQUE INDEX managed_checkpoint_active ON managed_checkpoints(deployment_id)
 WHERE phase IN ('prepared','dispatched','ready');
CREATE INDEX managed_checkpoint_owner ON managed_checkpoints(user_id,deployment_id,created_at);
CREATE TRIGGER managed_checkpoint_intent_immutable BEFORE UPDATE ON managed_checkpoints
WHEN OLD.id IS NOT NEW.id OR OLD.deployment_id IS NOT NEW.deployment_id
 OR OLD.user_id IS NOT NEW.user_id OR OLD.app_name IS NOT NEW.app_name
 OR OLD.org_slug IS NOT NEW.org_slug OR OLD.region IS NOT NEW.region
 OR OLD.configuration_version IS NOT NEW.configuration_version
 OR OLD.volume_name IS NOT NEW.volume_name OR OLD.size_gb IS NOT NEW.size_gb
 OR OLD.cpu_kind IS NOT NEW.cpu_kind OR OLD.cpus IS NOT NEW.cpus
 OR OLD.memory_mb IS NOT NEW.memory_mb OR OLD.created_at IS NOT NEW.created_at
 OR (OLD.volume_id IS NOT NULL AND OLD.volume_id IS NOT NEW.volume_id)
BEGIN
 SELECT RAISE(ABORT,'LOGT_CHECKPOINT_INTENT_IMMUTABLE');
END;
CREATE TRIGGER managed_checkpoint_phase_monotonic BEFORE UPDATE OF phase ON managed_checkpoints
WHEN OLD.phase IS NOT NEW.phase AND NOT (
 (OLD.phase='prepared' AND NEW.phase IN ('dispatched','obsolete'))
 OR (OLD.phase='dispatched' AND NEW.phase IN ('ready','obsolete'))
 OR (OLD.phase='ready' AND NEW.phase='obsolete')
)
BEGIN
 SELECT RAISE(ABORT,'LOGT_CHECKPOINT_PHASE_REGRESSION');
END;
