-- Honest driver names: each driver is one transport, not a whole
-- vendor. The umbrella "cloudflare" provider claimed support for
-- all of Cloudflare when we only tail workers + AI Gateway logs;
-- "fly" claimed all of Fly when we only tail app logs. Split into
-- single-transport drivers and back-fill existing rows.
--
-- Mapping:
--   cloudflare (cf_worker sources)   → cloudflare-worker-tail
--   cloudflare (cf_ai_gateway sources) → cloudflare-ai-gateway
--   fly (source connection)           → fly-log-tail
--
-- Mixed cloudflare connections (both kinds of sources) get split
-- into two rows that share the same encrypted credential. The
-- original keeps workers; a new -aigw sibling takes the AI Gateway
-- sources. Decoupling these is the architectural point: one
-- credential could in principle grant access to one but not the
-- other, and the generated bundle's env-var collision rule
-- (one connection per provider) means they can't coexist on the
-- same deployment under the new shape anyway.

-- Step A: split mixed connections — create the AI-Gateway sibling.
INSERT INTO connections (
  id, user_id, provider, display_name, external_account_id,
  credentials_encrypted, created_at, updated_at, last_discovered_at
)
SELECT
  c.id || '-aigw',
  c.user_id,
  'cloudflare-ai-gateway',
  c.display_name || ' (AI Gateway)',
  c.external_account_id,
  c.credentials_encrypted,
  c.created_at,
  c.updated_at,
  c.last_discovered_at
FROM connections c
WHERE c.provider = 'cloudflare'
  AND EXISTS (
    SELECT 1 FROM log_sources
    WHERE connection_id = c.id AND source_kind = 'cf_worker'
  )
  AND EXISTS (
    SELECT 1 FROM log_sources
    WHERE connection_id = c.id AND source_kind = 'cf_ai_gateway'
  );

-- Step B: re-point ai_gateway sources of mixed connections at
-- their new -aigw sibling. Order matters — must run after Step A
-- so the sibling exists, before Step C so we can still query
-- "is this connection mixed" by the old kind discriminator.
UPDATE log_sources
SET connection_id = connection_id || '-aigw'
WHERE source_kind = 'cf_ai_gateway'
  AND connection_id IN (
    SELECT c.id FROM connections c
    WHERE c.provider = 'cloudflare'
      AND EXISTS (
        SELECT 1 FROM log_sources
        WHERE connection_id = c.id AND source_kind = 'cf_worker'
      )
  );

-- Step C: rename every remaining cloudflare connection based on
-- which kind of source it now holds. After Step B, a connection's
-- sources are uniform (workers OR ai_gateway, not both). The
-- CASE-EXISTS uses ai_gateway as the discriminator so connections
-- with ONLY ai_gateway sources flip to the ai-gateway driver;
-- everything else (workers, or no sources at all) becomes
-- worker-tail.
UPDATE connections
SET provider = CASE
  WHEN EXISTS (
    SELECT 1 FROM log_sources
    WHERE connection_id = connections.id AND source_kind = 'cf_ai_gateway'
  )
  THEN 'cloudflare-ai-gateway'
  ELSE 'cloudflare-worker-tail'
END
WHERE provider = 'cloudflare';

-- Step D: Fly SOURCE connections (not the deploy_targets — those
-- keep `kind = 'fly'` since "Fly as a deploy target" is honest:
-- we deploy machines, set secrets, etc., not just one transport).
UPDATE connections
SET provider = 'fly-log-tail'
WHERE provider = 'fly';
