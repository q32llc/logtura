# Convergence baseline requirement audit

This audit maps the required baseline in `oss-service-convergence-plan.md` to
observable assertions in the shipped test sources. It supplements the current
release/deployment receipts in `convergence-acceptance.md`; a source mapping alone
is not evidence that a particular execution passed. Exact CI, registry, rehearsal and production receipts below provide the execution
evidence for the completed baseline.

| Required area | Assertions and execution boundary | Authoritative source |
| --- | --- | --- |
| Authentication/ownership | Missing and malformed OAuth inputs, state/nonce/path tampering, failed provider exchange/profile, secure sessions, stale/deleted owners, logout; account and report token authority never overlap. | `test/workerd/auth-baseline.test.ts`, `cli-auth.test.ts`, `deployment-state-routes.test.ts`, `tail-token-baseline.test.ts`; `packages/cli/test/account.test.ts` |
| Signed bundles and reporting authorization | Signed-link expiry/tampering, deployment identity mismatch, token rotation/revocation, old report fencing, private response rejection and legacy authorization. | `test/workerd/bundle-generation.test.ts`, `deployment-state-routes.test.ts`, `ingest-cache.test.ts`; `packages/core/test/service-client.test.ts` |
| Provider setup | Registered public driver credential verification/discovery fixtures and standalone connectors; native hosted adapters cover invalid credentials and selection, account scopes, pagination/empty/duplicate inventory, expired/failed OAuth, reconnect races and source preservation. Custom Vector has no hosted credential flow. | `packages/driver-*/test/`, `packages/{cloudflare-shared,supabase-shared}/test/`, `packages/cli/test/{provider-connectors,connect-inventory,prompt-adapters}.test.ts`; `test/workerd/{connect-adapters,provider-oauth-baseline,connection-inventory-baseline,reconnect,discovery-job}.test.ts` |
| Source inventory | Owned list/discovery/deletion, stable rediscovery IDs, metadata replacement, explicit/all/future discovery selections, multi-connection identity and legacy wildcard fallback. | `test/workerd/{connection-inventory-baseline,graph-reconciliation,multi-connection-deployment,deployment-selection,discovery-job}.test.ts`; `packages/core/test/reconcile.test.ts`; `packages/cli/test/graph.test.ts` |
| Destinations/monitor routing | Every destination's config validation/rendering, owned create/read/delete, monitor/sink mutations, source scope, disabled/enabled monitors, ordered filter steps, multiple sinks, malformed references and cross-user writes. | `test/workerd/{graph-crud-baseline,graph-reconciliation,happy-path}.test.ts`; `packages/destination-*/test/`; `packages/core/test/{render,graph,install}.test.ts`; `src/web/pages/{Destinations,Monitors}.test.tsx` |
| Bundle parity/artifacts | Same public renderer/install/backend operations under service/CLI adapters, deterministic output and stable IDs, manifest/config hashing, private refs, required env, arbitrary assets, safe literal shell construction, empty/heartbeat-only topology, multi-provider archives, mode/contents and signed downloads. | `test/workerd/{bundle-generation,portable-config,other-target,fly-target}.test.ts`; `packages/core/test/{config,manifest,install,fly-install,runtime-assets}.test.ts`; `packages/cli/test/{install-registry,config,fly-deploy}.test.ts`; `oss/scripts/test-packed.mjs`; `scripts/test-packed-service.mjs` |
| Actual runtime delivery | Unmodified generated Vector parsers/filters and sink encoders execute against controlled transports; normalized identity/timestamp/error fields, rejected nonmatching input, expected delivery, byte-preserving retry and positive metrics. Selected live Worker/Fly runs use owned webhook delivery, not synthetic Slack errors. | `docs/runtime-delivery-matrix.md`; required `test:flow`, `test:*runtime`, `test:custom-vector-flow`, `test:supabase-refresh-runtime`, `test:metrics-runtime`; `scripts/e2e-live-source.mjs` |
| Managed deployment lifecycle | Create/update/delete, valid target/names, deduplicated queue requests, provider failure/retry, lost create/update responses, private issued-install identity, credential expiry, readiness/report acceptance, stale bundles, mounted restart and legacy replacement/rollback. | `test/workerd/{deployment-crud-baseline,fly-deploy-job,managed-installations,managed-issued-installations,managed-runtime-queue,managed-replacement,managed-rollbacks,managed-cleanups}.test.ts`; `test/e2e/managed-runtime.ts` |
| Self-managed deployment lifecycle | Issued activation and durable binding, read-only preflight, desired/version races, lost service/provider acknowledgements, private journal validation and exact image/configuration fences. Stop-before-start, preserved checkpoint, explicit rollback/rebase and both cleanup modes. | `test/workerd/{deployment-state-routes,linked-fly-bindings,linked-fly-rollbacks,linked-fly-cleanups}.test.ts`; `packages/cli/test/{activation,fly-apply,fly-apply-crash,fly-replacement-store}.test.ts`; `packages/core/test/fly-replacement*.test.ts` |
| Heartbeat/silence | Legacy wire payloads and token scopes, metrics-only pending/crashed recovery, stopped status preservation, narrow indexed stale capture, clock/lease/alert boundaries, overlapping cron capture/delivery, failed sends, durable retry, deletion/cancellation and races with fresh heartbeat. | `test/workerd/{happy-path,deployment-ingest,ingest-cache,silence-alerter,silence-outbox-migration}.test.ts` |
| Metrics/checkpoints | JSON/NDJSON/batches, malformed/incomplete snapshots, per-field ordering/replays, actual restart/process epoch and counter reset, wide counts, errors/caps/rates, auth-cache expiry/rotation, competing isolates and actual native D1 losing writes. After three collisions, retained sample succeeds on retry with 503/Retry-After and no Worker exception. | `packages/core/test/metrics.test.ts`, `packages/cli/test/metrics.test.ts`; `test/workerd/{metrics-snapshot,ingest-cache,deployment-ingest}.test.ts`; `src/web/pages/DeploymentDetail.metrics.test.tsx` |
| CLI usability and privacy | Both executable aliases and plain JS/TS consumers outside the workspace; network-denied standalone generation; help/exit/filename/init behavior; credential prompts, env precedence/quiet mode/overwrite/redaction; source/sink/monitor edit, bundle/deploy/stats and space-containing paths. | `oss/scripts/test-packed.mjs`; `packages/cli/test/{command-baseline,config,local-env,prompt,provider-connectors,graph,fly-deploy,metrics}.test.ts` |
| Website | Real logged-in UI creation/config editing, invalid input, downloads, progress/failure, metrics and revision display, late/unmounted polling, reload/session state and CLI-made changes. Unit UI coverage is independently measured; installed CLI + real browser + workerd + actual Vector supplies transport proof. | `src/web/**/*.test.tsx`; `test/e2e/{browser,managed-runtime}.ts`; `scripts/e2e-local.ts`; production 0.3.4 creation/original browser receipts |
| Cleanup/failure isolation | Unique owner/target/run ledgers, no pre-existing baseline deletion, private no-follow/size/mode readers, uncertain dispatch never blindly repeated, owned row/resource cascades, interrupted subprocess cleanup and absence verification. All success/failure paths require teardown; detached volume DELETE acknowledgement is distinguished from absence. | `test/e2e/{lifecycle,run-ledger,file-ledger}.ts`; `test/harness/*.test.mjs`; `scripts/e2e-http.ts`, `scripts/e2e-cloudflare.mjs`, `scripts/e2e-live-source.mjs`; `packages/core/test/fly-replacement-cleanup.test.ts`; installed E2E injected failure paths |

## Portable configuration and synchronization invariants

- `packages/core/test/{config,manifest,graph,reconcile}.test.ts` exercises stable
  identity/canonical ordering, schema versions and malformed inputs, secret
  references/private payload typing, normalized component-key collisions and
  lossless supported-field round trips. Unknown schemas fail instead of dropping fields.
- `test/workerd/{config-version,deployment-reconciliation,deployment-push,
  deployment-push-receipts,deployment-configuration,deployment-state-routes}.test.ts`
  exercises atomic account/sequence fences, inventory/selector reconciliation,
  lost-response immutable receipts, stale/foreign writers, issued identities,
  duplicate/out-of-order reports and rejection of unsupported/retired reports.
- `packages/cli/test/{pull,push,deployment-link,file-transaction,activation}.test.ts`
  exercises private local config/env/link transactions, offline inspection,
  pending-write guards, response-loss recovery, changed-file preservation,
  explicit remote-state reconciliation and correct owner/origin checks.
- `packages/cli/test/{runtime-report,runtime-process}.test.ts` and
  `packages/core/test/runtime.test.ts` require the actual installed file/env bytes,
  generator/Vector identity and readiness before reporting. Durable private
  checkpoints retain report sequence across retries and restart; generated files
  alone are never success evidence.
- `packages/cli/test/create.test.ts` plus native `deployment-creation.test.ts`
  exercises CLI-owned creation/linking, concurrent identical/conflicting requests,
  immutable owned receipts, failed dispatch/export/local commit, explicit forced
  repair and verified deleted outcomes. Deletion does not recreate an identity.
- Final public command semantics are explicit: linked users pull, edit, push and
  then deploy; deployment refuses unsynchronized local edits before provider writes.
  No unissued local revision may masquerade as current service-applied state.
  Standalone generation/deployment does not require service linkage or an account.
- UI revision assertions distinguish legacy unknown, pending/unreported,
  replacement, applied and stale states. Reporting authority cannot edit account
  intent; a retired instance cannot replace the current applied observation.

## Coverage, packaging and release invariants

`vitest.config.ts` and `oss/vitest.config.ts` include every package project and
unexecuted production source in coverage, with package/module floors.
`vitest.ui.config.ts` includes production UI separately. CI runs report consistency,
missing/malformed report/base and child-failure regressions, uploads LCOV/JSON/HTML
and enforces 95% changed executable lines. Both repositories require up-to-date
`test` success even for admins. The deliberately untested PR failed and was closed
without merging. Codecov is not used.

Versioned consumers validate all 15 tarballs, exports/declarations, aliases and the
runtime binary. The isolated service build rejects missing package entries and
uses installed packages rather than workspace imports. Immutable tagged releases
retain original tested archives and compare every registry archive byte/integrity;
no timeout authorizes retagging or redispatching an uncertain publish.

Production release gates retain current Worker source/settings/version, a fresh
D1 export, both retained/candidate all-row native compatibility receipts, original
forwarder graph/config/image rollback material, exact registry-backed Worker/website
and OCI/runtime identity, owned remote staging/Fly receipts, durable dispatch logs
and actual uploaded-byte/binding verification. Final acceptance includes original
loaded-manifest acknowledgement and natural source-to-sink delivery.

## Decisions kept separate

Workerd/Miniflare integration needs no cloud credentials. Optional selected remote
HTTP/Cloudflare/live-source rehearsals prove their stated capabilities and ownership;
unsupported live provider accounts are never inferred from native fixture success.
Compatible dependency fixes ship with their tests; frontend/runtime major changes,
Vector interpolation changes and future credential vault design remain in their
separate documented decision plans rather than being silently marked complete.

## Reader compatibility policy

The 0.3.x release line supports unversioned legacy standalone configuration and
portable configuration/manifest schema 1. Public readers normalize supported
legacy configuration to schema 1; unknown schema versions fail explicitly.
Service upgrades preserve legacy heartbeat/metrics payloads and existing reporting
tokens. Forwarders without applied-manifest fields retain an unknown applied
revision rather than being declared current. These contracts remain supported
through the 0.3.x line; removal requires a separately reviewed migration, a new
release line and release notes describing the upgrade path. Additive optional
fields cannot become requirements for existing reporters within this window.

Linked deployment requires issued synchronized intent: `pull`, edit, `push`, then
`deploy`. Unsynchronized linked edits fail before provider writes. The plan's
conditional recovery for a locally applied unsynchronized revision is therefore
prevented at the public deployment boundary; lost acknowledgements of issued
revisions are recovered through durable receipts and activation journals.

## Review and default-branch evidence

A complete fresh GraphQL audit of all 24 public PRs inspected every review,
issue comment and review thread, with no uninspected pagination. There were zero
reviews/comments/threads, including no delayed CodeRabbit findings. Service PR 1
also had zero reviews/comments/threads before its protected merge. Public release
PRs 23/24 and service PR 1 merged only after their exact required checks succeeded;
no required check was bypassed. The negative-control public PR 1 was closed
without merging.

The exact public 0.3.5 main run `37397158694` passed, with owned report consistency
verified across 70 production files: lines 99.24%, statements 97.70%, functions
99.33% and branches 95.58%. Its LCOV, JSON and HTML artifacts are retained in CI.
The coordinated service merge is `eebf379242c1285f24f26b4f02c0f0a5be0aa36d`;
its required PR run `37396327179` passed and its image run `37398309619` passed.
Exact-main service test `37398309631` passed all installed E2E/failure-cleanup,
provider transport, native coverage, independent UI coverage and changed-line
gates. Downloaded LCOV/JSON reports pass their consistency verifier across 70
package, 80 service and 22 UI production files. Service lines/statements/functions/
branches are 95.78/95.57/98.14/91.92%; UI totals are
94.97/93.81/96.53/90.75%, meeting every required floor.
Immutable tag `v0.3.5` identifies public `c287447c…`; tag run `37400216202`
passed publication, all 15 original archive/registry integrity comparisons and
fresh installed consumers. Both actual-registry remote rehearsals passed, and
production Worker/website plus the original forwarder now run 0.3.5. See
[the complete rollout receipts](service-rollout-0.3.5.md).

## Phase and final acceptance evidence

| Plan deliverable | Completed evidence |
| --- | --- |
| Thorough local/remote baseline | Required exact-main service CI `37398309631` passes native routes, isolated installed packages, actual provider transports and full CLI/browser/workerd/Vector E2E, including both injected failures and teardown. Remote actual-registry Cloudflare `run-nQBrbj` passes lifecycle, schema 17→37 and verified Worker/D1/queue absence. |
| High owned coverage and required checks | The independently inspected counts above meet package, service and UI targets; all module and changed-line floors pass. Missing/malformed/duplicate reports, unavailable bases and child failures have regression tests. The failing control PR was blocked and closed. Both public repositories enforce strict `test`, including admins. |
| Portable contracts and shared packaged backend | Schema/identity/privacy/concurrency tests above pass; the actual-registry service artifact contains installed public modules, no workspace public packages, and passes its missing-entry negative control plus native D1/website checks. All 15 archives and declarations install independently; both aliases execute. |
| Website/CLI synchronization | Required local installed E2E covers the complete source/routing edit and apply path. Published production CLI creation → website edit → CLI pull/push → website reload passed on an owned disposable deployment, then verified deletion. The original website-created identity is updated with published CLI, accepted by the reporting protocol and visible In sync in the website. |
| Existing deployment and rollout | Fresh retained/candidate schema-37 replays preserve 846 rows, 31 tables, history and all 24 deployment fields, with zero outbound requests. Verified deployed bytes/settings/assets and natural telemetry retain the original graph. Published CLI 0.3.5 updates the sole original machine with its original checkpoint; desired/applied sequence 3 and generator 0.3.5 are accepted. Its actual original sink receives/sends a natural event after upgrade. |
| Recovery and resource disposition | Native/installed tests cover revision/response-loss/offline/lease/crash recovery. Production original rollback, both cleanup modes and final apply passed in 0.3.4; the bounded readback regression ships in 0.3.5. New actual-registry Fly delivery/restart/update/rollback passes; owned machines/Workers/tails are deleted. Two latest detached volume tombstones remain `pending_destroy` after acknowledged DELETE; older volumes are absent. No active canary remains, and tombstone absence is not claimed. |
| Dependency and reader decisions | Compatible tested patches and Vector 0.55.0 pin ship; older-reader support is explicitly defined above. Separate major/vault/interpolation decisions remain in the dependency plan as the original scope requires. |

Production SQL, provider settings, complete configuration and credentials remain
private and ignored. Committed docs contain receipts, counts and hashes, not raw
production payloads or secrets. The historical repository secret audit scanned
all reachable history and found zero matches for 22 actual credential values;
the single generic scanner finding was a verified natural-language phrase.
