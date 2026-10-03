# Convergence acceptance evidence

This is the current acceptance index for the [full plan](oss-service-convergence-plan.md),
not a replacement for its baseline matrix. The goal is still in progress. Historical
milestones in that plan describe intermediate states; the evidence below identifies
what has actually shipped and what still needs verification.

The [runtime delivery matrix](runtime-delivery-matrix.md) now proves all selected
provider/destination transport rows in native fixtures, including refreshable
Supabase auth and encoded metrics. The parser fixes are part of the immutable
0.3.2 tag, whose complete registry publication is still being recovered from the
original tested archives. See [current rollout evidence](service-rollout-0.3.2.md).

| Requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Standalone published CLI and libraries | All 15 npm 0.3.1 archives match the original immutable release manifest; isolated JavaScript, NodeNext/Bundler TypeScript, both CLI aliases, runtime binary and offline generation checks pass. Public [release](https://github.com/logtura/logtura/releases/tag/v0.3.1) retains archives and recovery receipts. | Preserve these checks for subsequent releases. |
| Service uses packaged public operations | `test:packed:service` compiles the actual service and website outside the workspace, verifies package isolation, rejects a missing core entry and runs native D1 lifecycle checks. Production 0.3.1 consumes actual registry archives. | No workspace-only build is accepted as release evidence. |
| Portable desired configuration and loaded manifests | Public config/manifest APIs, service revision APIs, CLI pull/push/apply and runtime reporting ship together. Full private CI exercises browser edits, installed CLI edits, native workerd, actual Vector and applied acknowledgement. | Production account round trip and original forwarder loaded-manifest proof remain open. |
| Thorough deterministic baseline | Workerd, package, UI, provider runtime and local browser/CLI/Vector suites pass in private [CI 37126126595](https://github.com/q32llc/logtura/actions/runs/37126126595). Public protected-main [CI 37126637678](https://github.com/logtura/logtura/actions/runs/37126637678) passes independently. | A final matrix audit must retain scope distinctions between fixture contracts and live delivery. |
| High owned coverage and failure enforcement | Vitest includes backend, package and UI production sources with per-package/module floors. CI uploads LCOV/JSON/HTML and enforces 95% changed executable lines. An intentionally untested public PR failed at 0/2 lines and was blocked, then closed without merging. No Codecov service is required. | Private branch protection remains unavailable under the repository's current GitHub plan; this external limitation is not represented as an enforced private merge gate. |
| Remote lifecycle and cleanup | `test:e2e:http` accepts a selected remote test account; `test:e2e:cloudflare` stages an audited artifact on disposable Worker/D1/queue resources. Actual npm-backed 0.3.1 staging passed and cleaned its resources. Ledgers, uncertain-dispatch fences and subprocess guards are tracked and tested. | The manual remote Actions workflow exists, but transferring Cloudflare credentials into GitHub secrets remains unapproved. Local staging success does not prove that workflow executed. |
| Live standalone source delivery | The reusable [source-delivery harness](live-source-canary.md) now selects an explicit stable release. Actual npm 0.3.1 passed Worker tail → generated Vector → owned webhook delivery, with normalized-event checks and resource removal. Repeated cleanup also passed without installed packages or a valid selected version. | This selected live integration does not imply every external provider has a live sandbox. The deterministic provider/destination matrix remains separate. |
| Released Fly backend, restart, update and rollback | Actual registry consumer receipt is private at `.tmp/live-fly-031-registry-consumer/consumer-receipt.json`. Disposable run `.tmp/live-fly-canary/run-V6mFSA/run.json` passes real source delivery, fresh reports after restart, new-manifest application and rollback, with phase fences. | The disposable operator receipt is live evidence, not a claim of original production forwarder upgrade. |
| Original forwarder compatibility and service rollout | [0.3.0](service-rollout-0.3.0.md) records additive schema migration; [0.3.1](service-rollout-0.3.1.md) records actual Worker/website byte verification, preserved bindings and stable deployment fields. Natural heartbeat and metrics advance after deployment. Fresh production-data native replay validates existing token behavior, wide counters and both retained rollback Workers without outbound provider calls. | Upgrade the original mountless forwarder separately, preserving logical identity, routing and rollback configuration. Verify loaded manifest and real delivery afterward. |
| Dependencies and runtime identity | Compatible test tooling updates and their reliability fix are shipped. [Dependency decisions](dependency-upgrade-plan.md) explicitly defer coordinated majors and Vector interpolation changes. Live registry Fly proof used the CI-built immutable image below. | Do not count deferred major upgrades as already performed; they retain their own decision and validation gates. |
| Default branches and immutable releases | Public protected PR 4 merged; immutable `v0.3.1` points to `ec4ca1d`. Release recovery reused the original tested archives and verified all 15 registry versions. Private production code `e8b48b5` has green exact-commit CI and is pushed to `master`. | Subsequent changes still require their own commit, push and appropriate CI evidence. |

The registry Fly run used OCI index
`sha256:c6d6fd32512f7cfb5244ac44dc52689c662340c7824691978e8211f9ae6de9bc`,
resolved by the packaged backend to Linux platform image
`sha256:861b56ee694a6a466c72cc497ead7d6069988b08156ceaa22d74ce3dd2364113`.
Its owned machine, Worker and tail are deleted. Volume deletion was acknowledged
and the detached `pending_destroy` tombstone was verified; absence is not claimed.
The original forwarder's config, instance and started state remained unchanged.

The production browser's ordinary GitHub sign-in works. The CLI reached its
normal device-approval screen, but the requested account grant was not approved
and expired without issuing a token. That is not an authentication success or a
production synchronization proof. Reissue the bounded request only when approval
is available, then pull/edit/apply, observe the loaded runtime report, inspect the
same deployment through the website, test rollback and revoke the canary grant.
Never replace that acceptance flow with a fabricated session or reporting token.

Completion still requires the production round trip and original forwarder upgrade,
the final requirement-by-requirement matrix audit, and accurate disposition of the
external CI credential/protection constraints. Production snapshots, raw receipts,
credentials and complete provider configuration remain private and gitignored.
