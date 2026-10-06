# Convergence acceptance evidence

The planned capabilities are published and deployed in coordinated 0.3.5.
All 15 public packages are usable without a hosted account, the service consumes
the actual registry-backed public operations, and the original deployment remains
current and forwarding. The signed-in production website and published CLI have
been exercised in both directions. Major runtime/frontend/vault decisions remain
in their separate plan as originally scoped.

Read [the full requirement baseline audit](convergence-baseline-audit.md) for the
case-to-test mapping and [the 0.3.5 rollout](service-rollout-0.3.5.md) for exact
source, archive, image, backup, rehearsal and deployment receipts. Historical
milestones in the original plan describe intermediate states, not current gaps.

| Requirement | Completed authoritative evidence |
| --- | --- |
| Independent packaged CLI/library | All 15 actual npm 0.3.5 archives match the immutable original tested bytes; ordinary JS/TS consumers, both CLI aliases and runtime execute outside the workspace. Network-denied standalone generation proves no service dependency. Provider credentials and infrastructure remain necessary for provider operations. |
| Shared packaged service backend | `.tmp/service-035-registry` builds with installed public modules, not workspace packages; types, Worker, website, native D1 lifecycle and missing-entry negative control pass. Production uploaded Worker/website match that exact artifact. Hosted OAuth, persistence, sessions and jobs remain service adapters. |
| Portable configuration/loaded manifests | Stable identities, canonical hashes, private references, strict schemas, lossless supported-field round trips and actual loaded-file/env readiness are tested. Original graph hash `bc54fc48…` remains unchanged; accepted runtime `114ce418…` reports generator 0.3.5 and desired/applied sequence 3. |
| Website ↔ CLI | Required installed browser/CLI/workerd/Vector journey covers graph changes, apply and failure recovery. Production CLI-created disposable identity → website edit → CLI pull/push → reload → verified owned deletion passed in 0.3.4. Original website-created deployment is pulled/applied by published 0.3.5 CLI and shows In sync on reload. |
| Thorough deterministic baseline | Exact service-main run `37398309631` passes all registered unit/native projects, actual generated provider/destination transports, independently measured UI, isolated installed packages and full local E2E with both injected-failure cleanup paths. Local core/backend baseline is 1,891 tests across 151 files. Detailed assertions are mapped in the baseline audit. |
| High owned CI coverage | Exact public-main reports: 99.24% lines, 97.70% statements, 99.33% functions, 95.58% branches. Exact service backend: 95.78/95.57/98.14/91.92%; separate UI: 94.97/93.81/96.53/90.75% in the same order. LCOV/JSON consistency, module floors, HTML uploads and 95% changed executable lines all pass. Codecov is not used. |
| Required checks and reviews | Both repositories are public. OSS `main` and service `master` require strict up-to-date `test`, including admins, and prohibit force pushes/deletion. The deliberately failing PR is closed and unmerged. Full fresh audits of all 24 public PRs and service release PR 1 found no reviews, comments or threads and no uninspected pagination. |
| Remote lifecycle | Actual-registry Cloudflare `run-nQBrbj` passes schema 17→37, real HTTP lifecycle and legacy reporting, with Worker/D1/queue absence verified. Reusable explicitly selected runners support remote target/identity/fixture capabilities and owned run-ledger reconciliation. Ordinary CI uses local workerd/Miniflare without cloud credentials. |
| Actual runtime delivery | The runtime delivery matrix covers all registered provider/destination rows through actual generated Vector parsers/transports/encoders, including Bun sidecars, Supabase refresh, Datadog protobuf/Zstd and Prometheus Snappy. Fixtures are distinguished from live account claims. Actual-registry Fly `run-UbbX6R` proves owned Worker source → webhook delivery, mounted restart, update and rollback. |
| Existing production compatibility | Fresh retained/candidate schema-37 native replays preserve all 846 rows, 31 tables, migration history and 24 deployment fields, with zero outbound requests. Production version `6dd30d3f…` has byte/binding/asset verification and natural persisted telemetry. No migration runs for 0.3.5. |
| Original forwarder/rollback | Published 0.3.4 CLI completed original replacement, explicit rollback, both cleanup modes and restoration. Published 0.3.5 CLI updates the sole mounted original machine in place with its original encrypted checkpoint. Accepted manifest/state is current; actual original sink receives/sends a natural event after upgrade. The known delayed restore readback is now bounded pending work with a strict regression. |
| Cleanup/privacy | No active canary machine, Worker or tail remains. Older volumes are absent; the two latest are detached `pending_destroy` tombstones after acknowledged DELETE, without claiming absence or billing facts. Original checkpoint is attached. Production configuration/SQL/settings/credentials remain private and ignored; actual credential values were absent from the complete repository history audit. |
| Dependencies and support window | Compatible tested Hono/router/test-tool patches ship, Vector is pinned at 0.55.0, and the baseline audit explicitly defines 0.3.x legacy configuration/schema-1/reporting support. Major upgrades, interpolation changes and future credential vault design retain their separate decision plan. |
| Coordinated defaults/release | Reviewed protected version merges are public `c287447c…` and service `eebf3792…`; both exact-main checks and image build pass. Immutable `v0.3.5` publication run `37400216202` passes every registry archive and installed consumer. Documentation changes remain subject to the same protected test gate. |

Supporting decision/evidence files: [runtime delivery matrix](runtime-delivery-matrix.md),
[dependency upgrade plan](dependency-upgrade-plan.md),
[production smoke access](production-smoke-testing.md),
[CLI creation](cli-deployment-creation.md),
[replacement](linked-fly-replacement.md), [rollback](linked-fly-rollback.md),
[cleanup](linked-fly-cleanup.md), and the preceding
[0.3.4 production round trip](service-rollout-0.3.4.md).
