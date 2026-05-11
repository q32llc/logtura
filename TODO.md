# TODO

> **How to use this file**
>
> - Anything not yet shipped lives under "Pending."
> - When something is done, **check the box** (`[x]`) and move it to "Done" with a one-line note (date + commit/PR if relevant).
> - Keep items short. Link to docs / commits / threads instead of writing essays here.
> - If a pending item gets stale (no longer relevant), delete it instead of carrying dead weight.

---

## Pending

### Managed deploy on Fly
- [ ] Org picker — currently hardcodes `personal`. Resolve user's orgs via Fly GraphQL and let them pick one per deployment.
- [ ] Region picker — currently hardcodes `iad`. Surface a region dropdown driven by Fly's `/v1/platform/regions`.
- [ ] Machine sizing — currently `shared-cpu-1x / 256MB`. Make it configurable for users tailing a lot of sources.
- [ ] Detach button — destroy the Fly machine + app from logtura's UI when the user wants to walk away.
- [ ] Surface live machine state — poll Fly's machines API after deploy and reflect "running / crashed / stopped" in the deployment header (currently we only know what the deploy job returned).
- [ ] Logs/console link — deep link to the Fly machine's log stream from the Run tab.

### Other managed deploy targets
- [ ] DigitalOcean App Platform — driver exists; no managed deploy yet.
- [ ] AWS / Fargate — driver exists; no managed deploy yet.
- [ ] GCP Cloud Run — driver exists; no managed deploy yet.

### Memory / sources
- [ ] **Drop `wrangler tail` for direct Cloudflare WebSocket Tail API** (C-style optimization). Each `wrangler tail` invocation spawns a full node process (~40 MB resident); a 24-worker deploy needs ~1 GB just for the tails. A single Vector source consuming the WebSocket directly is ~30× cheaper and removes the entire node dependency from the forwarder image's hot path. Currently we paper over this with `memory_mb: 4096` on the Fly machine — see `containers/forwarder/Dockerfile` + `src/providers/cloudflare.ts` source block.
- [ ] Per-source memory budgeting and source-count cap on managed deploys, so a wildcard-selecting user can't OOM regardless of memory size.

### Providers
- [ ] Render — Vercel-style log streaming. Driver + discovery + tailing source.
- [ ] Vercel — log drains.
- [ ] Heroku — `heroku logs --tail` / log drains.
- [ ] AWS CloudWatch Logs — most-requested.
- [ ] Generic syslog / file-tail — for self-hosted users.

### Streaming anomaly detection (research artifact)
- [ ] Survey existing OSS (OTel contrib, drain3, isolation forest implementations) before claiming gaps.
- [ ] Decide: rust port of Vector or pure transform plugin?
- [ ] Publish a paper/blog with logtura attribution if the result is novel.

### Reliability / ops
- [ ] **Post-deploy SaaS smoke script** — `scripts/smoke.mjs` that hits `/api/providers` + `/api/destinations/drivers`, asserts the expected ids are present and each has a non-null connectFlow. Run after `pnpm run deploy`. Would have caught "Supabase didn't deploy" on 2026-05-11 where the registry shipped with only 3 providers. ~15 lines.
- [ ] **Forwarder healthcheck endpoint** — `/api/deployments/:id/health` that hits Fly Machines API for the deployment's app + Vector's `/health` over Fly internal network, returns `{ status: "healthy" | "oom_looping" | "vector_unhealthy" | "stopped", details }`. Would have surfaced the wrangler-OOM loop on the cf-errors-to-slack deployment without needing to manually tail Fly logs.
- [ ] **End-to-end event probe** — push a synthetic event through an `internal_logs`-shaped source after deploy, wait 60s, assert it arrived at the configured sink. Requires a "probe sink" abstraction we don't have today. Most expensive option, only build if (1) and (2) prove insufficient.
- [ ] Stale deployment alerter is wired but unverified end-to-end. Smoke test: stop a forwarder, confirm Postmark email fires within a cron tick.
- [ ] Heartbeat token rotation — currently lifetime token per deployment. Design a rotation flow.
- [ ] Job dead-letter visibility — failed jobs stay in `jobs` table but no UI surfaces them.

### UX polish
- [ ] Marketing/home page review for LLM tells (em-dashes, "not X — Y" contrastives).
- [ ] Empty states across the app — currently a few panels show `—` instead of guidance.
- [ ] Mobile/narrow-viewport layout pass.

---

## Done

- [x] **2026-05-10** — Managed deploy on Fly via Machines API (`fly_deploy` job + Run tab UI). Commit `d75a278`.
- [x] **2026-05-10** — Fly cli_session click-flow connect: 404-during-pending bug fixed (`ed1ac3c`).
- [x] **2026-05-10** — Deploy tab + Fly cli_session token storage (`69abfa0`).
- [x] **2026-05-10** — Deployment Detail tabs (Overview / Configure / Bundle) with editable config (`59352c3`).
- [x] **2026-05-10** — Readable destination env var names + dedup across sinks (`a9c1b74`).
- [x] **2026-05-10** — Surface credential expiry even when token still fresh (`095e041`).
- [x] **2026-05-10** — Don't inline expired credentials (`146412c`).
- [x] **2026-05-10** — Inline credential values + "create a new one" link in bundle UI (`1aeb9b7`).
- [x] **2026-05-10** — Lazy-init heartbeat token for pre-migration deployments (`a125a53`).
- [x] **2026-05-10** — Three-in-one: source normalization, filter pipeline, heartbeat + email-on-silence (`aa67675`).
- [x] **2026-05-10** — Refactor: deployments are the unit of "what runs" (`b609345`).
- [x] **2026-05-10** — Logo SVG + 512×512 PNG via git-lfs (`ff29124`, `a774d36`).
