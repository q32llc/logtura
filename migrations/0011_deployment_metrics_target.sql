-- metrics_target: where Vector's internal_metrics get shipped.
--
-- Same shape as heartbeat_target:
--   NULL or 'none'  → no metrics sink in the generated config
--   'logtura'       → POST to logtura's worker (last-received only;
--                     logtura does NOT store time series — that's
--                     where money goes; user wires Datadog/Grafana
--                     for graphs)
--   <destination_id> → route internal_metrics through a configured
--                     destination's sink (datadog_metrics,
--                     prometheus_remote_write, etc.)
--
-- The destination's `flows` field must include "metrics" — enforced
-- in the API layer, not in the schema.

ALTER TABLE deployments ADD COLUMN metrics_target TEXT;
