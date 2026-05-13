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
- [ ] **`logtura-http-client`** — new Rust crate (separate repo `logtura/logtura-http-client`). Clone of Vector's `http_client` source distributed as a static binary, with two new auth strategies the upstream doesn't have:
    - `bearer_refresh` — POST to a configurable `token_url` for a fresh bearer (the response is `{access_token, expires_in}`-shaped). Logtura's SaaS implements that endpoint for managed deploys. Generic; works for any backend that issues short-lived tokens.
    - `oauth_refresh` — RFC 6749 directly. Operator holds `client_id`/`client_secret`/`refresh_token`. **Supabase rotates refresh_tokens on every use** (probed 2026-05-12) — original is invalidated within a second. So `oauth_refresh` requires `refresh_token_file` on a persistent volume for the binary to write the new token. Optional and document the volume requirement; many use cases work fine with `bearer_refresh` instead.
    Both strategies handle the `401 → refresh → retry once → exit non-zero` cycle so Vector's exec source restarts on hard auth failures. Vector source config the driver emits is `type: exec` calling `logtura-http-client --config <path>`. TOML config shape mirrors upstream `http_client` so the eventual upstream PR is mechanical: add `bearer_refresh`/`oauth_refresh` to `auth.strategy`. Context: https://github.com/vectordotdev/vector/discussions/17192 — upstream maintainers acknowledged the gap.
    Once `logtura-http-client` ships, the supabase-edge-logs driver switches from `http_client` (24h-only OAuth) to `exec`-with-this-binary so OAuth-managed forwarders survive token rotation. PAT-paste path stays as the offline-friendly alternative.
- [x] **CF tail bridge** (replaces `wrangler tail` subprocess-per-worker). `logtura-cf-tail` is a sibling Rust repo next to `logtura-http-client`:
    - calls `POST /accounts/<id>/workers/scripts/<script>/tails` per selected worker, holds N WebSockets in one process, streams the merged event stream to stdout in `wrangler tail --format json` shape
    - handles tail TTL refresh by calling create-tail again before expiry
    - block-on-write backpressure so a burst worker pushes the CF WebSocket into backpressure instead of dropping events client-side
    The OSS CF worker-tail driver consolidates to ONE source per connection. Forwarder image drops the `wrangler@latest` Dockerfile install and the per-worker subprocess pile-up. Logpush is **not** an acceptable substitute — see memory `feedback_logpush_is_a_checkbox.md`; Logpush ships only request envelopes, no console output or stack traces, which is the data this product is built around.
- [ ] Per-source memory budgeting and source-count cap on managed deploys, so a wildcard-selecting user can't OOM regardless of memory size.

### Providers
- [ ] Render — Vercel-style log streaming. Driver + discovery + tailing source.
- [ ] Vercel OAuth / Integration install flow — `vercel-logs` currently supports Hobby-compatible Runtime Logs through a Vercel Access Token + optional Team ID. True OAuth requires creating a Vercel Integration and selecting REST API scopes (`user`, `team`, `project`, `deployment`); wire this once the integration credentials/slug exist.
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

### Architecture
- [ ] **Config naming idea: `filter` → `steps` and maybe `monitors` → `pipelines`.** Current CLI grammar keeps `monitors[].filter` because it is shipped and documented. But the chain can include `rollup`, `dedup`, `sample`, and `rate_limit`, so "filter" is semantically narrow. If/when we revise config language, support `steps` as the preferred alias and keep `filter` as backward-compatible input. Larger rename from `monitors` to `pipelines` needs product/UI review first.
- [ ] **`staticDockerfileDeps` on the driver contract.** Today the kitchen-sink build script (`scripts/build-forwarder-dockerfile.mjs`) instantiates each driver with mock connection + selection just to harvest `generatePipeline()`'s `dockerfileDeps`. Works but feels wrong — drivers shouldn't need to tolerate "called for dep introspection" inputs. The fix is a top-level `staticDockerfileDeps?: DockerfileDep[]` field on `ProviderDriver` that the build script reads directly. Defer until we add a 4th provider or a 3rd party writes a driver and trips over the mock-call convention.
- [ ] **Per-deploy image builds (instead of one kitchen-sink).** Today every managed deploy uses the same forwarder image with every driver's deps baked in. Heavy for users who only need one provider. Path forward when we want this: stand up a build broker (GH Actions `workflow_dispatch` is fine), the deploy job POSTs Dockerfile + vector.yaml, builder pushes to `ghcr.io/q32llc/logtura-deployment:<id>-<sha>`, deploy job pins Fly to that digest. The renderer already supports per-deploy Dockerfile gen via `renderDockerfile()` — only the build-and-push step is missing. Defer until image size or build time becomes a UX complaint, or until a 3rd-party driver author needs the path.
- [ ] **Hybrid forwarder base image.** Publish `ghcr.io/logtura/forwarder:vX.Y.Z` as a small floor — Vector + the set of *our own* small Rust pollers (`logtura-http-client` already; future `logtura-cf-tail`, `logtura-fly-tail`). Drivers that use those tools stop contributing dockerfileDeps; per-deployment Dockerfile becomes `FROM forwarder:tag` + `COPY vector.yaml`. Heavy third-party CLIs (wrangler, flyctl) stay opt-in via per-driver dockerfileDeps — they're large enough that baking them in costs everyone for a subset's benefit, and they update on their own cadence. The bundle/no-bundle decision is per-tool: small + universal + ours → bundle; large + driver-specific + third-party → inject. Worth doing once the CF/Fly Rust tailers are real candidates for the base.
- [ ] **Per-provider UX components instead of scattered if-blocks.** `if (driver.id === "supabase-edge-logs")` branches are sprinkled through `src/index.ts` (POST /connections defer-account-pick, reconnect's same rule, /api/providers oauthShortcut injection, OAuth start/callback, /supabase-projects + /supabase-pick-project endpoints) and `src/web/pages/ConnectionDetail.tsx` (picker render). Each new provider that's richer than paste-a-token will add another set. Right shape: one component per provider that owns its slice of ConnectionDetail (and similarly for NewConnection), plus its own backend routes co-located: `src/providers/connect/supabase/{adapter.tsx, routes.ts}`. Host page slots in `adapter.ConnectionDetailExtras` when present, falls back to default. No central registry of declarative hooks, no `formFields` enum the host renders — provider owns its UI end-to-end. Worth doing the next time a non-trivial provider lands (CloudWatch, Vercel, Render).

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
