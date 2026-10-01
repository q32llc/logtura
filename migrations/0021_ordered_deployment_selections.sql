-- Null retains the existing flat-selector behavior, including legacy wildcard
-- discovery. Modern graphs retain connection/source/monitor/sink ordering and
-- the provider's explicit all-source selection mode.
ALTER TABLE deployments ADD COLUMN graph_selection_json TEXT;
CREATE TRIGGER configuration_deployment_graph_selection AFTER UPDATE OF graph_selection_json ON deployments
WHEN OLD.graph_selection_json IS NOT NEW.graph_selection_json
BEGIN
  UPDATE configuration_versions SET version=version+1 WHERE user_id IN (OLD.user_id,NEW.user_id);
  UPDATE deployments SET bundle_outdated=1 WHERE id=NEW.id AND bundle_outdated=0;
END;
-- Existing website writers only change flat selectors. Override each section
-- independently so a monitor edit cannot disable an all-source provider stream,
-- and a source edit cannot discard monitor/sink ordering. Modern writers reset
-- these read-only override flags by writing their full selection last.
CREATE TRIGGER deployment_legacy_source_override
AFTER UPDATE OF connection_id,source_selection_json ON deployments
WHEN NEW.graph_selection_json IS NOT NULL AND
  (OLD.connection_id IS NOT NEW.connection_id OR
   OLD.source_selection_json IS NOT NEW.source_selection_json)
BEGIN
  UPDATE deployments SET graph_selection_json=json_set(graph_selection_json,'$.legacySources',json('true')) WHERE id=NEW.id;
END;
CREATE TRIGGER deployment_legacy_monitor_override
AFTER UPDATE OF monitor_selection_json ON deployments
WHEN NEW.graph_selection_json IS NOT NULL AND OLD.monitor_selection_json IS NOT NEW.monitor_selection_json
BEGIN
  UPDATE deployments SET graph_selection_json=json_set(graph_selection_json,'$.legacyMonitors',json('true')) WHERE id=NEW.id;
END;
