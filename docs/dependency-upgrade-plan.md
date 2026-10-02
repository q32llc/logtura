# Dependency and runtime upgrade decisions

This is the separate upgrade plan referenced by
[the convergence plan](oss-service-convergence-plan.md). Changes remain independently
reviewable and preserve the packaged CLI, generated runtime, existing forwarder,
local/native tests, and coverage gates. Updating a tool does not prove a production
migration or a runtime upgrade.

## Current decision: test harness reliability

Repeated full coverage runs have passed their assertions but intermittently emitted
`EnvironmentTeardownError: [vitest-worker]: Closing rpc while "resolve" was pending`.
Earlier console interception also produced an unsupported `SpanParent` RPC during
Workers teardown. Native console logging keeps diagnostics visible but has not
proved a complete fix. Do not ignore these errors or reduce coverage/isolation to
make a candidate pass.

Registry inspection on October 2, 2026 establishes these compatible candidates:

| Component | Existing resolved version | Candidate | Decision |
| --- | --- | --- | --- |
| Vitest and Istanbul provider | 4.1.5 | 4.1.11 | Update together in both layouts and all package test dependencies; validate unchanged assertions and coverage floors |
| Workers Vitest pool | 0.16.3 | 0.22.0 | Evaluated and rejected for this slice; retain and exactly pin 0.16.3 |
| Pool's Miniflare | 4.20260507.1 | 5.20260815.0-alpha (pool dependency) | Evaluated candidate still emitted teardown errors; retain the existing runtime |
| Standalone local E2E Miniflare | 4.20260507.1 | No change in this slice | Preserve the current-runtime compatibility journey independently of the test-pool candidate |
| Vitest major | 4.x | 5.0.3 | Defer: pool 0.22.0 declares Vitest/runner/snapshot `^4.1.0` peers |
| Production Wrangler | 3.x | 4.x | Separate deployment-tool migration with preview/staging/rollback validation |
| Production Vector | 0.55.0 | Later runtime | Separate generated-config, actual delivery, interpolation, and rollback matrix |

The [Vitest patch release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11)
includes a lifecycle concurrency fix. The
[Workers Vitest 5 compatibility issue](https://github.com/cloudflare/workers-sdk/issues/15618)
is still open. The newer pool contains disposal changes, but an
[upstream multi-file hang report](https://github.com/cloudflare/workers-sdk/issues/15498)
also remains open. These sources justify evaluating the candidate; they do not
establish that our teardown defect is fixed.

For each candidate, regenerate and review lockfiles, verify peer compatibility,
run the full native/package coverage suite, repeat the affected full run to inspect
teardown diagnostics, and run UI coverage plus build/type/packed-consumer checks.
Verify public-layout tests separately. The separate installed CLI/browser/workerd/
actual Docker Vector journey must still pass. CI must use the tested versions and
must not install an unsupported test-runner major through a loose range.

If the pool candidate regresses storage, process lifecycle, API compatibility, or
coverage, keep the compatible patch update and investigate a bounded upstream fix
or controlled isolation configuration. A clean assertion count alone cannot close
the harness reliability item.

### Evaluation result and concrete queue isolation fix

Vitest 4.1.11 with the old pool still reproduced the pending `resolve` error.
Pool 0.22.0 also passed all 1,125 assertions and coverage floors but emitted the
same error; it additionally requires a coordinated Workers types 5 / Wrangler
upgrade. It is not included in the shipped dependency changes. Reinstalling a
loose `^0.16.3` range selected 0.16.20, so the retained pool is now exactly pinned
to 0.16.3. Existing production Wrangler, Workers types, standalone Miniflare,
Vector, and frontend majors remain unchanged. Dependency peers are compatible.

The native test file configured an automatic queue consumer. The pool merges
Wrangler and Miniflare options: `{queueConsumers:{}}` retains an existing consumer.
Actual `mergeWorkerOptions()` output confirmed that behavior. Background delivery
was therefore racing the explicit inbound batches, per-test HTTP mocks, and
module-resolution teardown. Remove the consumer from the test-only Wrangler file
and preserve the actual producer binding. Global setup checks the effective
Wrangler options and rejects any automatic consumer or missing native producer.
Regression tests exercise the actual parser and merger. Managed queue tests now
deliver native batches through the real Worker queue entrypoint, including ack/
retry results, rather than relying on background delivery.

The owned coverage runner preserves stdout/stderr and fails on uncaught runtime,
RPC teardown, or unsupported span diagnostics even if Vitest returns exit zero.
Real child-process tests cover passing/failing exits, signal failures, both output
streams, and chunk-split diagnostics. This strengthens the failure gate and does
not suppress errors or replace native D1/queue tests.

Validation after removing the actual consumer: two complete runs on the pinned
0.16.3 pool passed all 1,125 assertions in 103 files and unchanged coverage floors
without the teardown diagnostics or background `job_claim_skipped` activity. The
second used the stricter owned runner. All 17 report/runner/config guard tests,
280 UI tests with coverage, build and type checks, and the installed CLI/browser/
local workerd/actual Docker Vector journey passed. The exported public layout
passed all 723 package assertions and coverage floors, its 14 runner/report guard
tests, build/type checks, and installed tarball checks for all 15 packages and
executables. Public aggregate coverage remains 95.22% statements, 92.90% branches,
96.89% functions, and 95.79% lines. CI evidence for the shipped change is still
required; the failure guard remains active for any future runtime diagnostic.

## Remaining dependency inventory and delivery slices

Inventory root/package lockfile versions and advisory output before choosing each
slice. Track decisions, validation evidence, and rollback for each change here.

1. Update compatible production libraries used by the shared packaged backend.
   Validate config/manifest hashes, provider parsers and credential handling,
   generated driver/destination configs, and installed tarball API compatibility.
2. Coordinate Workers types and production Wrangler independently of frontend
   majors. Validate actual local bindings, D1 migrations, queue consumers, native
   runtime, deployment preview, staging canary, and recovery before production.
3. Evaluate TypeScript, Vite/React/plugin, UI dependencies, and Node policy as
   separate compatible groups. Preserve declaration consumers in all supported
   module modes, browser behavior, coverage measurement, and release artifacts.
4. Evaluate a Vector/Bun/runtime image update against every source/destination
   topology and actual credential renewal/reconnection/delivery. Vector 0.57's
   interpolation behavior requires an explicit generator decision; retain the
   current immutable image as rollback until the rollout is verified.
5. Update CI actions and runner assumptions with supported Node/tool versions and
   reproducible installation. Recheck offline package consumption, generated
   runtime artifact identity, and owned coverage reports after infrastructure
   changes.

No candidate is a reason to weaken the convergence completion gates. Release the
verified capabilities with their exact tested dependency and runtime identities.
