# Service rollout 0.3.2

Status: verified local candidate, not published or deployed. Public PR 10 aligns
all fifteen packages at 0.3.2 after the AI Gateway and Supabase parser fixes
passed their protected merges. Immutable 0.3.1 remains the current registry and
production release.

The private candidate updates Hono 4.12.18 → 4.13.12 and React Router DOM
6.30.3 → 6.30.6 within the existing majors. The [dependency decisions](dependency-upgrade-plan.md)
retain two Router 7 advisories accurately. No new schema migration is needed;
the checkpoint-contention correction already deployed in 0.3.1 remains intact.

Local validation passes 1,714 backend tests in 140 files, all 306 UI tests, both
typechecks and all fifteen isolated packed consumers. Backend coverage is 97.52%
lines/97.14% statements/94.61% branches; public coverage is 99.13% lines/98.42%
statements/96.67% branches, with module floors preserved. The packed service
compiles the actual Worker and website using isolated 0.3.2 public archives and
passes native D1 lifecycle checks plus the missing-core negative control.

The full local installed-CLI/browser/workerd/Vector journey also passes managed
creation, desired/applied website convergence, CLI-edited leased reapply, durable
restart, actual mountless legacy handoff, stop-before-legacy-restart rollback,
retained-candidate retirement and redeployment. Local candidate archives have a
clean source receipt; these are not actual npm 0.3.2 or production account proof.

Before publication, pass required exact public CI and merge through protection.
Tag the resulting tested main commit once as `v0.3.2`; never retarget it. Require
the tag workflow's complete runtime/coverage/consumer gates, publication receipt
and all fifteen exact registry integrities. Validate installed registry consumers.

Before service deployment, build a clean private artifact using those actual
registry archives, run disposable Cloudflare staging, replay a fresh production
schema-32 snapshot with preserved identities/tokens and no outbound provider
calls, and capture the currently deployed 0.3.1 Worker plus served assets for
rollback. Deploy only the verified artifact; compare actual uploaded/served bytes
and existing bindings/fields, then observe natural heartbeat/metrics progress.
Original forwarder replacement remains separate from the service upload.

Completion still requires the normal production account CLI/website round trip
and original forwarder upgrade with loaded-manifest and real delivery/rollback
proof. The pending new CLI grant and GitHub Cloudflare-secret transfer approvals
remain untouched; local staging does not prove the manual remote CI workflow ran.
