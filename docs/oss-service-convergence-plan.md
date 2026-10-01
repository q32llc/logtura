# Logtura shared backend and deployment synchronization plan

This plan makes the published CLI and libraries fully usable without the hosted service, makes the service consume the same public backend operations, and lets users move between the website and CLI while updating the same forwarder. A thorough compatibility baseline and enforced CI coverage come first. Dependency major upgrades have a separate decision process.

Status: proposed implementation plan, based on repository and production inspection on October 1, 2026. This document does not implement the changes or authorize destructive tests against existing production resources.

## Outcomes and completion criteria

- A clean installation of published packages supports configuration, credential verification, discovery, validation, bundle generation, deployment, and local inspection without contacting Logtura. Provider APIs and deployment infrastructure remain necessary for their respective operations.
- The website and CLI invoke shared public library operations. Private service code owns accounts, authentication, persistence, hosted credential adapters, jobs, and UI; it does not maintain a second implementation of portable backend behavior.
- A website user can authenticate in the CLI, pull an existing deployment, edit its sources/sites and routing, deploy it, and see the new desired and applied configuration on the website.
- Existing forwarders continue reporting heartbeat and metrics through service upgrades. Manifest reporting is additive and optional for older forwarders.
- Public and private CI enforce comprehensive tests, high coverage, package-install checks, and reproducible runtime validation.
- Release artifacts and rollback instructions identify exactly which package and forwarder versions were deployed.

## Verified starting point

- `src/generator.ts` already adapts D1 entities to `@logtura/core`; the CLI also calls this renderer.
- Config parsing and CLI orchestration live in `packages/cli/src/`. Service bundle assembly, install archives, deployment helpers, and metrics interpretation live in `src/`.
- CLI and service driver registries differ. The CLI includes custom Vector drivers; the service registry does not.
- Packages export TypeScript source. The CLI executable uses `node --import tsx`; clean global installation and normal JavaScript consumption need explicit verification.
- The public repository and npm release are at `0.2.11`. The local June CLI expansion has not been published; npm exposes `logtura`, while local source also declares `logt`.
- The private GitHub repository exists and its remote `master` matches local HEAD `a0bdf1f`. The local remote-tracking reference is stale. The expected sibling public checkout is absent.
- The inspected production database has one running, self-managed Fly deployment, reports Vector `0.55.0`, records an image digest, and has migrations through `0017`.
- Generated Dockerfiles and CI validation currently use `timberio/vector:latest-debian`.
- Root coverage uses Istanbul and excludes the web UI. Neither CI test workflow currently runs coverage or uploads Codecov reports. There are no configured coverage thresholds.
- Test project lists are incomplete: the private root omits the custom Vector project; the public root additionally omits the Vercel driver. Shared helper packages need explicit coverage and tests where applicable.

Recheck these facts during implementation. Production identifiers, credentials, actual user configuration, and raw provider payloads must not be copied into committed fixtures.

## Phase 1 Establish the compatibility baseline

Complete this phase before moving backend behavior or changing runtime versions. First measure existing coverage and inventory routes, commands, drivers, destinations, generated artifacts, and deployment transitions. Mark existing failures as defects with reproducible cases; do not silently redefine them as supported behavior.

### Test architecture

Use shared lifecycle scenarios and assertions with adapters for execution environment:

| Mode | Execution | Purpose |
| --- | --- | --- |
| Workerd integration | Worker entry point with real D1, migrations, queues, signed sessions, and controlled outbound HTTP | Fast, deterministic route and persistence coverage |
| Local HTTP E2E | Locally served Worker/workerd application, installed CLI process, browser, provider fixtures, and a real Vector container | Full transport, UI, executable, and runtime behavior |
| Remote E2E | Configurable service URL, authenticated disposable test account, isolated provider sandbox resources | Deployed application behavior and real integrations |
| Package consumer | Packed npm artifacts installed outside the workspace | Published CLI and library usability |

Reuse scenarios where their capabilities overlap. Workerd mocks do not run against a remote deployment; remote provider fixtures must be available through a sandbox or independently hosted fixture service. Report unsupported capability cases explicitly, and fail jobs that promise capabilities but cannot exercise them.

The proposed runner accepts a target URL and mode, test identity credentials, provider fixture/sandbox configuration, a unique run ID, and timeouts. Remote mode authenticates through a supported test-account flow; no production authentication bypass or database access is required by lifecycle scenarios. Destructive remote scenarios must use an explicitly selected test account and record ownership of every created resource.

### Thorough baseline matrix

| Area | Required cases and assertions |
| --- | --- |
| Authentication and ownership | Anonymous access, login/session behavior, expiration, logout, malformed credentials, cross-user reads and mutations, signed bundle URL expiration and tampering, deployment token mismatch and revocation |
| Provider setup | Every registered provider; valid/invalid credentials, account ambiguity, empty discovery, pagination where supported, duplicate discovery, reconnect, stale credentials, provider timeout/rate limit, and OAuth success/cancel/refresh fixtures |
| Source inventory | Create/discover/read/delete through supported workflows; stable identity after rediscovery, metadata changes, explicit selections, all-source selections, future discovered sources, multi-connection deployments, and legacy selection fallback |
| Destinations and routing | Every destination; configuration validation, create/read/delete, monitor/sink create/update/delete, source scoping, enabled/disabled monitors, filter order, multiple sinks, errors/matching filters, and invalid references |
| Bundle generation | Equivalent service/CLI inputs, deterministic output, stable component IDs, manifests and links, required env vars, custom Vector assets, credential freshness, empty/heartbeat-only topology, multi-provider topology, archive permissions and contents, signed downloads |
| Actual data flow | Inject representative events into real generated Vector topologies; assert normalized context, filtering, routing, expected delivery, retry behavior, and source-to-sink metrics. Cover every source/destination integration through deterministic fixtures and selected live sandbox checks |
| Deployment lifecycle | Create/read/update/delete, managed/self-managed behavior, naming, target validation, queue processing, idempotency/deduplication, failed deploy, retry, progress, credential expiration, readiness, stale bundle flags, restart, and rollback |
| Heartbeat and silence | Current wire payloads and token behavior, pending/crashed recovery, stale detection, recent-alert suppression, stopped/detached cases, notification behavior, clock boundaries, D1 transient failures, and repeated cron execution |
| Metrics | Current Vector payloads, batches, malformed/empty input, duplicate/out-of-order samples, restart detection, counter reset, per-error breakdown, component caps, rates/totals, cache misses/expiry, concurrent isolates, checkpoint behavior, and persistence failure |
| CLI usability | Published command aliases, help/exit codes, config filename compatibility, init idempotency, connect/source/sink/monitor commands, env resolution/precedence, quiet mode, overwrite rules, secret redaction, validate/bundle/deploy/stats, and paths with spaces |
| Website | Create and inspect configuration, deployment editing, validation errors, downloads, deployment progress/failure, metrics presentation, reload/session continuity, and visibility of changes made outside the browser |
| Cleanup | Cascades and dependent references, queued/in-flight work, partial setup failure, retrying deletion, interrupted runs, missing resources, and absence of leaked test resources |

Use both positive and negative cases. Test state transitions and observable results, not only HTTP status codes or snapshots. Inject database failures and provider failures deterministically locally. Keep live sandbox checks separate from fixtures that only prove request/response contracts.

### Existing forwarder compatibility

Capture sanitized fixtures for today's deployment selection, generated component IDs, heartbeat/metrics request formats, and configuration/environment naming. Record the deployed image digest and configuration securely as rollback material. Test against Vector `0.55.0` and pin the baseline validation image; preserve the current image until an explicit forwarder upgrade.

Keep service endpoints, existing tokens, and old metrics payloads working without new fields. Old forwarders show an unknown applied revision rather than being declared current. Test migrations from the current schema as well as a fresh database. Changes affecting component IDs, routing, authentication, or credential refresh require explicit compatibility cases.

### Remote lifecycle isolation and cleanup

- Create resources under a unique run prefix and record returned IDs in a run ledger. Assert account ownership before deletion.
- Never reuse or delete the existing production deployment, its connections, destinations, or credentials.
- Avoid deploying paid cloud resources in normal PR tests. Real deploy checks use configured sandbox budgets and explicit target selection.
- Teardown runs after success and failure. Cleanup is idempotent and reports leftover resources as a failed result.
- A reconciliation command uses the ledger to clean interrupted runs; age alone is insufficient evidence of ownership.
- Preserve useful redacted logs and failure artifacts before teardown. Do not attach tokens, rendered secret env files, or decrypted bundles to public CI artifacts.

Phase exit: all required deterministic baseline scenarios pass; a remote create/update/delete smoke passes against an isolated test account; current deployment compatibility is demonstrated; coverage measurements and uncovered paths are documented. Remote tests must not be reported as passing if credentials were absent or cases were skipped.

## Phase 2 Enforce high coverage in CI

Treat coverage as an implementation gate, not a badge. The following targets are proposed requirements for this work, not claims about current coverage:

| Scope | Lines and statements | Functions | Branches |
| --- | --- | --- | --- |
| Public backend and CLI packages | 95% | 95% | 90% |
| Private service backend | 95% | 95% | 90% |
| Web UI | 90% | 90% | 85% |
| Changed executable code | 95% patch coverage | Enforced by suite thresholds | Branch cases reviewed |

Apply backend thresholds per package or meaningful module group, as well as overall, so the renderer cannot hide an untested driver or CLI operation. Include unexecuted source files in the denominator. Cover shared helper packages and custom Vector code. Exclude only declarations, generated/vendor code, and documented non-executable glue; do not broadly exclude hard-to-test production modules. Bring the web UI into a separate measured scope instead of leaving it excluded.

1. Run unit, workerd integration, and UI tests with coverage in both private and public CI. Verify Istanbul compatibility with the selected Workers test pool before changing tooling.
2. Reconcile test projects with all packages, and fail discovery checks if a package with tests is omitted.
3. Generate LCOV and readable HTML summaries. Upload separate Codecov flags for public packages, service backend, and UI, with an explicit list of expected uploads for each repository.
4. Configure Codecov project and patch statuses as required checks, and independently enforce thresholds in the test runner. Confirm branch protection is actually configured; a workflow alone does not require checks.
5. Fail on missing reports, malformed reports, missing expected uploads, or upload failures. Select a supported OIDC/token strategy; private coverage must remain private and public fork handling must not expose credentials.
6. Establish the measured baseline, close gaps, and reach the targets before convergence is considered complete. Any temporary lower threshold must name the gap and removal milestone; no permanent grandfathering of low coverage.
7. Run deterministic local E2E and packed-artifact checks on every PR. Run remote lifecycle tests on explicit dispatch and staging/release jobs; scheduled remote checks are optional and require a later scheduling decision.

Coverage from remote deployments is not inferred from request counts. E2E success is a separate required check. Merge coverage only when source paths, build revision, and instrumentation agree, without double counting transpiled artifacts. Add focused concurrency/property tests for revision transitions and deterministic generation; do not inflate coverage with assertions that merely mirror implementation.

Phase exit: targets pass in both repositories, required checks block a deliberately failing coverage change, and missing/upload-failure behavior is verified. CI jobs have declared timeouts and useful failure artifacts; retries do not mask deterministic failures.

## Phase 3 Define portable configuration and applied manifests

The current `componentManifest` describes generated Vector components. Extend the public contract with a portable editable configuration and an applied manifest. Keep these distinct so runtime observations do not become edits to user intent.

### Portable configuration

- Versioned schema covering providers, sources/sites, monitors, sinks, metrics targets, runtime assets, and deployment options.
- Stable logical IDs preserved across website export, CLI import/edit, rediscovery, regeneration, and service synchronization. Names are labels, not identity.
- Credential references and required secret names, never resolved credentials. Arbitrary custom Vector settings/assets need schema-aware redaction and rejection of embedded secrets where enforceable; secret handling cannot rely on field names alone.
- Canonical serialization and hashing, with defined treatment of ordering, defaults, omitted fields, and schema migrations.
- Lossless round-trip for supported fields. Unknown newer schema versions produce an actionable error, never silent field deletion.
- Optional service linkage containing service URL, deployment ID, and last synchronized revision. Unlinked standalone configurations work identically without that linkage.

### Applied manifest

Record deployment identity, manifest/schema version, configuration hash and revision, package/generator version, runtime/image version, component manifest and links, runtime instance identity, and application timestamp. Package a sanitized manifest with generated forwarder artifacts. Verify reports refer to an actual loaded configuration, not just a generated file.

Desired state changes when the website or authenticated CLI saves configuration. Applied state changes when the forwarder confirms loading it. Show pending, applied, failed, unknown, and divergent states explicitly. If CLI deployment applies an unsynchronized local revision, show that reported configuration as a recoverable candidate, without overwriting a newer desired revision.

Forwarder reporting occurs on startup or configuration change and retries with bounded backoff. Ordinary heartbeats reference the applied hash; upload the manifest only when needed. Reports are idempotent and tolerate offline periods, duplicate requests, out-of-order reports, and restarts. Define how multiple instances are represented; an old instance must not overwrite the latest instance's applied state.

Use revision-based optimistic concurrency for desired configuration. A stale CLI write returns a conflict and supports pull/diff/rebase; overwriting must be an explicit operation. Concurrent removals, source renames, and missing credentials need specified conflict behavior.

## Phase 4 Extract shared operations and ship reliable packages

Keep `@logtura/core` focused on rendering and its contracts. Add public modules/packages for portable config, driver registration, bundle artifacts, deployment operations, and metrics interpretation where appropriate. Final package names follow implementation review; avoid a large package split before the boundaries are proven.

Separate pure operations from runtime adapters: parsing from filesystem reads, credential verification from prompts, Fly API operations from job persistence, archive file composition from compression transport, and metrics calculation from D1 checkpoint policy. Public backend modules intended for Workers must avoid unconditional Node filesystem/process dependencies.

The CLI remains a thin terminal adapter. The service calls the same operations directly through library APIs; it does not spawn the Node executable inside Workers. Retain hosted OAuth, encrypted persistence, sessions, notifications, and jobs as service adapters. Public provider verification/discovery and source rendering remain usable with locally supplied credentials.

Publish built JavaScript and declarations with explicit exports, command aliases, and supported Node versions. Test ordinary JavaScript and TypeScript consumers, local/global CLI installation, and behavior outside the monorepo. Preserve supported existing commands and filenames. Build the service in CI against packed public release artifacts to expose missing files, undeclared dependencies, and workspace-only behavior.

Add parity cases comparing portable configuration, generated topology, runtime assets, env requirements, and component manifests across CLI and service. Credential acquisition UX may differ; the underlying backend results must agree.

## Phase 5 Support website and CLI synchronization

The proposed user flow is:

```sh
logt login
logt pull <deployment>
# Edit logt.yaml or use source/sink/monitor commands.
logt diff
logt deploy
```

Command names and exact semantics are proposed, to be finalized with implementation. `pull` preserves deployment IDs and secret references and does not overwrite unresolved local edits. `diff` describes changes and revision conflicts without revealing secrets. A linked `deploy` validates, saves the desired revision, deploys, and observes the applied acknowledgment; failures remain visible as unapplied desired changes. Unlinked deploys have no service dependency.

Support account-scoped CLI authorization through an appropriate browser/device flow, secure local storage, expiration, and revocation. Deployment reporting tokens are scoped to reporting; existing heartbeat tokens must not gain authority to edit account configuration. Test permissions between users and between deployments.

Credential strategies must be explicit per connection:

- Standalone users supply provider credentials locally, including renewal appropriate to that provider.
- Linked users can use supported hosted credential brokers where needed, with service dependency made visible.
- Exporting a configuration that uses hosted OAuth explains the missing local credential requirement; it must not promise independence it cannot provide.
- Configuration synchronization does not implicitly export long-lived hosted credentials or upload local secrets.

The existing zero-knowledge proposal in `docs/zero-knowledge-plan.md` is related but is not an implemented prerequisite. Keep this work compatible with credential references and future user-controlled vaults; do not silently introduce a full credential-storage redesign.

Add E2E round trips in both directions: website create → CLI pull/edit/deploy → website inspection, and CLI create/link → website edit → CLI pull/deploy. Cover offline deploy/report recovery, conflicting revisions, partial failures, unknown schemas, report retries, account logout, token rotation, and deletion during synchronization.

## Phase 6 Release and preserve the current deployment

1. Keep the private service and public package repositories initially. Restore the missing public checkout or use an isolated CI checkout; make sync contents and exclusions explicit and reproducible.
2. Publish the public packages after packed-artifact and standalone checks. Test public CI independently, not only the private workspace.
3. Build the service against the exact candidate package versions. Record package/config schema/runtime versions in release artifacts.
4. Deploy additive schema and endpoint support to staging; run remote lifecycle and compatibility checks there.
5. Release service support while keeping the existing forwarder image, configuration, and tokens valid. Verify ongoing heartbeat, metrics, and delivery.
6. Upgrade a disposable forwarder to manifest reporting and prove the complete CLI/website round trip. Upgrade the existing forwarder separately, preserving its identity and recorded rollback image/configuration.
7. Retain readers for older config/manifest versions for the documented support window. Remove compatibility only in an explicit later migration.

Rollback covers Worker version, additive migration compatibility, package versions, forwarder image, and configuration revision. Do not drop existing columns or rewrite production configuration until backward compatibility and recovery are demonstrated.

## Separate dependency and runtime upgrade plan

Inventory resolved lockfile versions, security advisories, runtime images, provider API assumptions, and supported Node versions. Update compatible dependencies first where needed for this work. Decide separately on coordinated Wrangler/Workers test-pool changes, frontend majors, TypeScript/Vitest majors, and Vector upgrades.

Pin Vector in generated Dockerfiles and CI before relying on reproducible validation. Vector 0.57 disables environment interpolation by default; generated `${VAR}` configurations need a deliberate compatibility decision before upgrading from the current 0.55 runtime. See the [Vector release notes](https://vector.dev/releases/). Validate each candidate runtime against all generated driver/destination topologies and actual delivery tests, including Bun-based assets and credential renewal.

Do not make broad dependency modernization a prerequisite for shipping the shared backend unless a required feature or security issue demands it.

## Implementation milestones

| Milestone | Reviewable result | Gate |
| --- | --- | --- |
| Baseline inventory | Route/command/driver matrix, sanitized fixtures, measured coverage, pinned runtime | Current behavior and known defects documented |
| Baseline suite | Workerd, local HTTP/browser/CLI, packed install, remote lifecycle runner and cleanup | Deterministic baseline passes; isolated remote smoke passes |
| Coverage enforcement | Complete project discovery, backend/UI tests, Codecov flags and required statuses | High targets reached; failure gates demonstrated |
| Portable contracts | Config and applied manifest schemas, stable IDs, migrations, revision semantics | Round-trip, redaction, and conflict tests pass |
| Shared backend | Public operations and thin CLI/service adapters | Output parity and packed-consumer checks pass |
| Synchronization | CLI login/pull/diff/deploy, service revision APIs, forwarder reporting | Full bidirectional E2E passes, including offline/conflict cases |
| Release | Published packages and service consuming exact artifacts | Existing forwarder remains functional; rollback validated |

Track each milestone with concrete tasks and results during implementation. The final acceptance demonstration must include a clean standalone installation, a website-to-CLI-to-website update, verified CI coverage gates, and uninterrupted compatibility with the existing deployment.

## Implementation progress

The first baseline slice adds a shared HTTP routing lifecycle scenario and
local/remote runner, completes existing test project registration, pins Vector
validation and generated images to 0.55.0, isolates deterministic workerd
credentials, and fixes credential-file escaping under regression tests.

Measured after this slice: 181 tests pass, statements 52.29%, branches 40.44%,
functions 58.61%, and lines 54.61%. Type checking and production frontend build
pass. The backend CI floor initially enforces 52/40/58/54 percent respectively,
with Codecov project regression checks and 95% patch coverage configured. This
is a temporary baseline gate; the final 95/90 targets remain required. The
minimal JavaScript CLI launcher is executable glue; backend behavior remains
in instrumented TypeScript.

The comprehensive baseline matrix, persistent remote cleanup ledger, browser
E2E, clean packed-consumer verification, required branch-protection setup,
Codecov upload validation, final coverage targets, shared operation extraction,
and synchronization are still outstanding. No production rollout or public npm
release has been performed for this slice.

The second packaging slice builds JavaScript and declarations for all fifteen
public packages, removes the CLI runtime loader dependency, and adds packed
consumer checks to private/public test and release workflows. All package
tarballs install together in a fresh directory; both CLI aliases, standalone
validation/bundle generation with outbound fetch disabled, and ordinary Node
imports pass. Source coverage remains unchanged. This slice does not yet claim
full standalone provider/deployment lifecycle coverage or shared synchronization.

Private baseline CI passes tests and forwarder image creation. Its Codecov upload
currently fails with `Repository not found`; private repository enablement is
an external configuration dependency. Upload failures remain fatal.

Independent public-layout verification passes 114 tests, package builds,
recursive type checks, and packed-consumer checks. Public coverage starts at
55.04% statements, 43.56% branches, 57.21% functions, and 58.79% lines; its CI
floor is 55/43/57/58 pending the planned increases. Both layouts pin Vitest and
the Istanbul provider to the same version. The public sync excludes generated
package output and the private CLI account inventory configuration.

The runtime/provider baseline slice adds a real generated Vector delivery test
for normalization, filtering, context, and webhook retry after a 503, without
the hosted service. CI runs this flow. Shared Cloudflare and Supabase provider
contracts now have dedicated projects and 100% line/statement/function/branch
coverage gates. Expiry boundary tests fixed an epoch-zero expiry bug. The
private suite now passes 207 tests with 55.07% lines and 41.17% branches. Both
repositories currently need Codecov enablement; upload errors are retained as
fatal configuration failures rather than hidden.

After the provider/runtime slice, CI floors ratchet to 52/41/59/55 for the
private backend and 56/45/59/60 for public packages. Public verification passes
140 tests with 60.59% lines and 45.50% branches; shared provider modules remain
at 100% across all metrics. The real Vector flow also passes independently in
the public layout.


### Shared install backend shipped — 2026-10-01

`@logtura/core` now owns install-file composition and reproducible tar output.
The service supplies its decrypted bundle and Workers compression; the CLI
supplies Node compression. Both use the same installer, credential rendering,
runtime asset layout and component diagram. This removes the duplicate backend
rather than keeping two implementations synchronized.

Shell-quoted `.env` values previously changed when passed directly through
Docker `--env-file`. The shared installer sources the generated shell file and
passes validated exported keys with `-e KEY`, preserving quotes, spaces,
newlines and literal command-substitution text. It checks every generated key,
even when a previously populated value was cleared, and fails before replacing
a running container if credentials are missing. Interactive prompt values are
exported for that run; save them in `.env` for subsequent runs.

The baseline now includes executable shell tests against a recording runtime,
native tar extraction, UTF-8 byte limits, path traversal/duplicate rejection,
archive reproducibility, mode preservation and packed Node consumption of the
public install APIs. Workerd verifies session and signed downloads produce the
same bytes, retain private file modes, reject other users and expired/tampered
links, and preserve the existing authentication redirect.

Validation: 240 private tests and 171 public tests pass. Private coverage is
56.49% statements / 43.13% branches / 62.91% functions / 58.84% lines; public is
60.39% / 47.69% / 63.47% / 64.14%. Install composition is 100% lines, statements
and functions, 95% branches; tar is 100% across all metrics, with per-file gates.
Global floors increased accordingly. These are intermediate floors; the final
95% backend / 90% UI coverage requirements remain outstanding.

`manifest.json` still contains the component diagram. Portable desired/applied
configuration, account CLI authentication and bidirectional synchronization are
not implemented by this slice. Npm publication and production rollout remain
pending. Both repositories' latest CI tests/builds pass before the mandatory
Codecov upload, which still fails with `Repository not found`.


### Portable configuration parsing and revisions shipped — 2026-10-01

The CLI now calls public `@logtura/core` configuration APIs instead of maintaining
its own parser. `parseConfigDocument` accepts decoded documents and explicit
registry/environment/include adapters; it runs without Node, ambient credentials
or provider requests. Workerd and packed Node tests exercise the same API.

`normalizeConfigDocument` and `logt config normalize [-o file]` produce version-1
configuration with explicit stable connection/destination/monitor IDs, materialized
monitor defaults, stable `connection_id` links and embedded custom Vector
fragments. Legacy generated IDs and routing behavior survive normalization.
Renaming keys or labels preserves identities; renaming `errors` no longer changes
its implicit filter after normalization. Duplicate sanitized identities, repeated
selections/routes, malformed references and unsupported versions fail validation.

`hashConfigDocument` and `logt config hash` produce deterministic SHA-256 revisions
of normalized unresolved configuration. Object ordering and resolved secret values
do not change revisions. Pipeline arrays and included fragment contents do. The
JSON encoder rejects cycles and values that JSON would silently discard/coerce.
Normalization retains any literal credentials the caller put in the original
document; shared configuration should use `env:` references. This is a format and
revision foundation, not a secret-redacting manifest export or remote sync endpoint.

The baseline adds provider/selection aliases, destination settings, source-specific
routing, default materialization, explicit-ID rename stability, include portability,
revision changes, malformed documents and adapter isolation. It also catches async
CLI connection errors as exit codes instead of uncaught promise rejections.

Validation: 329 private tests and 259 public tests pass. Private coverage is
60.27% statements / 49.56% branches / 66.00% functions / 61.73% lines; public is
68.31% / 60.75% / 69.33% / 70.27%. The public configuration module is 98.38%
statements / 95.43% branches / 97.36% functions / 98.96% lines. Its enforced gate
already meets the final backend targets; aggregate floors increased again.
Builds, typechecks and both independent packed-consumer checks pass.

Still required: secret-reference manifest export, shared provider registry/backend
operations, service storage adapters, account CLI authentication, optimistic
concurrency and desired/applied synchronization, expanded remote/browser/runtime
E2E, final aggregate/per-package/UI coverage, dependency upgrades and publishing/
production rollout. Codecov repository activation remains an external blocker.
