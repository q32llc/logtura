-- Multi-connection deployments: a single forwarder can now tail
-- sources from multiple connections (e.g. Cloudflare workers AND
-- Fly apps) in one Vector config.
--
-- We add a join table rather than retrofitting `deployments` with a
-- JSON array because (a) ON DELETE CASCADE keeps the link clean
-- when a connection is removed, (b) queries by connection (for
-- bundle assembly, the connection-detail page's "deployments using
-- this connection" list) stay indexable, and (c) FK semantics
-- prevent dangling references.
--
-- `deployments.connection_id` stays around as the "primary"
-- connection for now — used for app naming, default selection in
-- the UI, and back-compat with anything still reading it. The
-- join table is authoritative for bundle assembly: every row in
-- deployment_connections contributes its selected sources to the
-- generated config.

CREATE TABLE deployment_connections (
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  -- When this connection was added to the deployment. Lets the UI
  -- order them in a stable way and surface a "newest connection"
  -- hint without an arbitrary tiebreak.
  added_at INTEGER NOT NULL,
  PRIMARY KEY (deployment_id, connection_id)
);

CREATE INDEX idx_deployment_connections_deployment
  ON deployment_connections(deployment_id);
CREATE INDEX idx_deployment_connections_connection
  ON deployment_connections(connection_id);

-- Backfill: every existing deployment's primary connection becomes
-- its sole row in the join table. Idempotent — if the migration
-- gets reapplied, the PK conflict skips already-backfilled rows.
INSERT OR IGNORE INTO deployment_connections (deployment_id, connection_id, added_at)
SELECT id, connection_id, created_at FROM deployments;
