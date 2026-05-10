-- Refactor: deployments are the unit of "what runs," and they own the
-- source/monitor selection. Removes the now-vestigial selected flag on
-- log_sources (selection moves to deployments) and adds the two
-- selection columns plus a heartbeat-target spec.
--
-- No backfill: pre-refactor data is not preserved (no users yet).
-- Existing deployments rows (if any) get a default of all-sources +
-- wildcard monitors via NULL.

ALTER TABLE log_sources DROP COLUMN selected;

-- JSON array of log_source IDs to tail; NULL = all sources from the
-- connection.
ALTER TABLE deployments ADD COLUMN source_selection_json TEXT;

-- JSON array of monitor IDs that apply; NULL = wildcard (every
-- monitor scoped to this connection or null-scoped).
ALTER TABLE deployments ADD COLUMN monitor_selection_json TEXT;

-- Where heartbeat metrics go. NULL = port :9598 exposed only;
-- 'logtura' = pushed to logtura's collector; later: a destination_id
-- for "scrape into your own Prometheus."
ALTER TABLE deployments ADD COLUMN heartbeat_target TEXT;
