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

## Compatible production update — October 3, 2026

A fresh production-only npm advisory audit reported 25 findings (one high,
23 moderate and one low). The candidate updates Hono 4.12.18 → 4.13.12 and
React Router DOM 6.30.3 → 6.30.6; the latter resolves React Router 6.30.6 and
Remix router 1.23.4. These retain the existing library majors and change only
those four dependency records in the private lockfile. Public packages have no
Hono or React Router dependency. The [Hono release](https://github.com/honojs/hono/releases/tag/v4.13.12)
is the current compatible candidate; React Router's [redirect advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-jjmj-jmhj-qwj2)
identifies the patched 6.30.6 line.

The repeated audit reports zero high/critical/low and two moderate findings.
Both remaining React Router advisories require 7.18.0 or newer:
[untrusted navigation paths](https://github.com/remix-run/react-router/security/advisories/GHSA-wrjc-x8rr-h8h6)
and [manual SSR hydration](https://github.com/remix-run/react-router/security/advisories/GHSA-337j-9hxr-rhxg).
The current entrypoint uses declarative `BrowserRouter` and client `createRoot`,
not manual router SSR/hydration. The upstream advisory excludes declarative mode
from the hydration issue. Inspection found fixed internal route prefixes for
all dynamic navigation targets, rather than user-supplied complete URLs; this is
application-scope evidence, not a claim that React Router 6 is fully patched.
Retain the remaining advisory decisions in the separate Router 7 migration,
including malicious-path browser tests and deployment rollback.

The production inventory also finds React/DOM 19, Mantine 9 and Zod 4 as major
candidates; their existing 18/8/3 majors remain for this patch. Icons 3.48.0 is
compatible but has no advisory-driven requirement in this slice. No automatic
major upgrade or blind audit fix was applied. Raw registry/audit output is private
under `/tmp/logtura-production-dependency-*-20261003.*`. All 1,714 backend tests, all 306 UI tests, typechecking, packed-service isolation
and the complete browser/installed-CLI/workerd/actual-Vector journey pass for the
0.3.2 candidate. The 0.3.2 production rollout now passes exact CI, actual registry archives,
staging, fresh candidate/rollback compatibility replay and byte verification;
see [the rollout receipt](service-rollout-0.3.2.md). The first sandboxed rebuild could not open pnpm's store
index; rebuilding with the cache permission succeeded, without changing tests.
