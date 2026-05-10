-- Optional UX-only progress hint per job. Handlers set this via
-- ctx.progress({label, detail?, fraction?}) at human-meaningful
-- moments ("Building image", "Pushing layer 3 of 7", "Waiting for
-- machine to start"). The aggregate /api/jobs/:id endpoint surfaces
-- the latest non-null progress from kids so the UI can show a live
-- status line without each handler having to know about the rollup.
--
-- Nullable; not load-bearing. If a handler never calls progress(),
-- the UI just doesn't show anything extra.
ALTER TABLE jobs ADD COLUMN ux_progress_json TEXT;
