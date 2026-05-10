-- Heartbeat metadata. Each deployment carries a token the running
-- container uses to authenticate to POST /api/heartbeat/:id; receiving
-- the request bumps last_seen_at. The cron alerter uses
-- last_alert_sent_at to avoid re-emailing on every tick.

ALTER TABLE deployments ADD COLUMN heartbeat_token TEXT;
ALTER TABLE deployments ADD COLUMN last_alert_sent_at INTEGER;
