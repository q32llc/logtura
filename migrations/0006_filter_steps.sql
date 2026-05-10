-- Replace single-filter columns with a pipeline-step list. Each row's
-- filter_steps_json is a JSON array of step objects:
--
--   { "kind": "errors" }
--   { "kind": "level", "level": "error", "mode": "include" | "exclude" }
--   { "kind": "match", "pattern": "...", "mode": "include" | "exclude" }
--   { "kind": "rate_limit", "per_minute": 60 }
--   { "kind": "dedup", "window_secs": 300, "fields": ["message"] }
--   { "kind": "sample", "rate": 0.1 }
--
-- The generator emits one Vector transform per step in order. NULL or
-- empty array = pass-through.
--
-- No backfill: old rows lose their single filter (no users yet).

ALTER TABLE monitors DROP COLUMN filter_kind;
ALTER TABLE monitors DROP COLUMN filter_config_json;
ALTER TABLE monitors ADD COLUMN filter_steps_json TEXT;

ALTER TABLE sinks DROP COLUMN filter_kind;
ALTER TABLE sinks DROP COLUMN filter_config_json;
ALTER TABLE sinks ADD COLUMN filter_steps_json TEXT;
