-- Track which forwarder image digest a deployment is actually
-- running. The deploy job resolves ghcr.io/q32llc/logtura-forwarder:latest
-- to a concrete digest before talking to Fly, then writes it here.
-- Lets the UI answer "what version is this deployment on" without
-- asking Fly, and lets a future redeploy detect "image is stale, the
-- :latest tag advanced" without polling the registry.
ALTER TABLE deployments
  ADD COLUMN image_digest TEXT;
