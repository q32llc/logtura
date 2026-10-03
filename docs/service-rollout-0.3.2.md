# Service rollout 0.3.2

Status: public protected main and private exact candidate CI passed. Public
PR 10 merged as `fe3c174093614ae785b3ce562cf8c3ebbac60071`; immutable `v0.3.2`
points there. Public main run `37126637678` and private source
`1d5dfe4aef3079dd92a82c7a4d8d2ce8e8741fbe` run `37126126595` are green.

The original tag run `37126668173` passed every runtime, coverage and packed
consumer gate before npm publication. npm acknowledged core, cloudflare-shared
and custom-vector, but custom-vector visibility exceeded the three-minute
window. Its subsequently visible archive matches the original tested hash.
Recovery run `37127516003` uses the original fifteen tested archives and checks
existing immutable hashes before publishing missing packages. It also stopped at the next acknowledged package's visibility timeout; 0.3.2 is not yet a verified complete release or production deployment.
Production remains the verified 0.3.1 service.

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

The fresh schema-32 backup captured at 13:39 UTC is 601,782 bytes with SHA-256
`57c69e93150af8fbaf211813086949f463f67f4da109293969ed0ae2edb8e887`.
The captured current 0.3.1 Worker replay passes native heartbeat/metrics and
invalid-token checks with all 24 deployment fields preserved, no outbound calls
and no production mutation. Served rollback website bytes match the previously
verified artifact. The actual-registry 0.3.2 candidate replay is still pending.

Release-observation follow-up: protected public [PR 11](https://github.com/logtura/logtura/pull/11)
publishes each missing archive once in dependency order, then checks the complete
release within a bounded ten-minute window. It retains pre-dispatch collision
checks, acknowledged attempts and exact final hashes. Its 18 safety tests pass in
both layouts, including timeout without republish, post-acknowledgement integrity
mismatch and historical recovery. New 0.3.2 transport gates are mandatory for
recovery; older immutable tags retain their original gate set. PR 11 still needs
required CI and protected merge before another recovery dispatch.
