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


### Account CLI authorization and UI baseline shipped in source — 2026-10-01

Public `LogturaServiceClient` and `authorizeCliDevice` now provide the optional
hosted-account protocol through an explicit fetch adapter. The CLI supports
`login`, `whoami`, and `logout`; local provider setup/rendering/deployment still
needs no hosted login. Login prints a terminal code, opens browser approval, polls
with backoff and saves credentials atomically with private file permissions.
Service origins are isolated, unrelated token types are rejected, redirects are
not followed, tokens are not printed, and logout retains retryable credentials
when revocation fails. `--local` removes only the local credential. Expired/already
revoked credentials and repeated logout are handled without requiring relogin.

Migration 0018 adds separate device authorization and account-token tables.
Only token/device hashes are persisted; account tokens expire after 90 days and
can be revoked. Authorization requests expire after ten minutes and are bounded
per requester. Lost poll responses can be retried during that window without
reviving revoked access. CLI credentials cannot approve devices or create other
credentials. Existing forwarder reporting tokens gain no account authority.

The website has explicit approve/deny UI, an account/code/scope display and client
revocation. GitHub sign-in returns to the approval page, validates return paths,
and accepts in-flight state cookies from the previous implementation. Workerd
covers ownership, denial, expiration, malformed requests, Origin checks, rate
limits, session-only management, retryable delivery, token hashes, legacy OAuth
state and the actual public authorization client against D1-backed endpoints.
The CLI has a real local HTTP login/poll/browser-launch/whoami/logout test.

Validation: 380 private backend/package tests, 300 independent public tests and
seven UI interaction tests pass. Backend/package coverage is 63.29% statements /
53.64% branches / 68.69% functions / 64.21% lines; public coverage is 70.33% /
64.41% / 71.33% / 71.60%. Authorization, transport and credential storage have
100% lines/functions, at least 95% statements and 90% branches, enforced per file.
The approval page has 100% lines/functions, 98.11% statements and 85.71% branches.

UI coverage now runs separately and reports **every existing UI module**, including
untested pages, rather than excluding the UI from the only report. The initial
aggregate UI result is 2.00% lines / 3.61% statements / 3.38% functions / 2.69%
branches. Small baseline ratchets and the final-target approval-page gate are
active; the required aggregate 90/90/90/85 remains far from complete. Private CI
runs the UI suite and uploads both reports; Codecov backend and UI components are
separate. Repository activation is still required for successful Codecov uploads.

This slice is committed/pushed capability support, not a claim that production
CLI login is live: npm publication, remote migration 0018 and production service
rollout are pending. Desired/applied manifest export, account storage adapters,
optimistic-concurrency sync, full browser/remote E2E and final coverage remain next.

A final compatibility case preserves legacy source keys and monitor labels that
already start with `con_`/`mon_`; normalization must strip prefixes only from
explicit entity IDs, not from legacy display/key values.


### Implemented slice: portable graph exports and CLI pull (2026-10-01)

The public core now exports a complete `logtura.deployment` schema-v1 manifest,
resolves it through the shared config parser, and renders the same bundle inputs.
Connection, source, monitor, sink and destination identities, source metadata,
all seven filter kinds, sink filters, selection flags, reporting targets and
reporting tokens round trip. Known public entity fields are explicitly projected;
private driver payloads and metadata are JSON environment references. HMAC
versions detect payload changes without publishing ordinary secret hashes.
Caller-owned private version keys remain outside manifests.

The owned deployment `/config` endpoint is account-authenticated and `no-store`;
secret payloads require `includeSecrets=1`. Reporting tokens have no account
export authority. Repeated exports of the tested static-credential graph have
stable revisions. `logt pull` fetches via optional account transport, checks the
revision and all required payloads, preserves unrelated `.env` entries, creates
private secret files, refuses conflicting overwrites without `--force`, and
restores originals after ordinary staged replacement failures. Failed rollback
retains recoverable originals. Process-crash recovery across the two-file
replacement still needs a durable journal. Shorthand editing commands refuse
portable graphs; graph editing commands are a follow-up, not silently destructive.

Validation: 432 private backend/package tests and 350 independent public tests
pass. Service cookie and account bearer exports preserve ownership. Workerd
exports render identical Vector YAML, runtime values and component manifests
through the public backend. Canonical JSON, graph manifests and CLI pull have
100% statements/branches/functions/lines, enforced per file. Packed ordinary-Node
consumers of all 15 packages round trip the new format with hosted fetch denied.
Private build/Vite, typechecking and independent public typechecking/packing pass.
Aggregate private backend/package coverage is 65.56% statements / 56.54% branches /
70.45% functions / 66.34% lines; public is 74.09% / 68.62% / 74.09% / 75.21%.
Aggregate ratchets increase accordingly; these remain below the final targets.

This export is the current service graph, **not** a stored desired/applied pair.
Next: explicit graph editing, shared storage reconciliation, authenticated push
with optimistic concurrency, applied acknowledgements/offline candidates, complete
remote/browser lifecycle coverage and the remaining module coverage. OAuth broker
credentials currently preserve existing broker links; ephemeral broker token
minting must be accounted for before claiming stable OAuth desired revisions.
Production migration 0018, npm publication and staged service/forwarder rollout
remain pending. Previous private CI passes code checks and image build but fails
Codecov upload with `Repository not found`; account activation remains unresolved.


### Implemented slice: graph editing and redacted diffs (2026-10-01)

The public backend now applies ordered graph edit transactions for connections,
source/site selections, monitors, sinks, destinations and reporting targets. IDs
are immutable on update. Unchanged private payloads retain their existing opaque
versions; changed payloads get new versions and remain in the private secret map.
Transactions validate the final graph, including actual credential/metadata/runtime
payload types, broken references, duplicate selections and IDs that collide after
Vector key normalization. Shared references cannot have conflicting versions.
Caller manifests, secret maps and newly supplied operation objects are not mutated.
Destination updates reach every sink and metrics target referencing that ID.

CLI `config export` converts existing standalone shorthand files to portable graphs.
`config edit <operations.json>` applies complete graph operations; `source select`
and `source remove` provide direct site editing with stable identities, kind/label
options and private metadata files. Failed validation leaves both files unchanged,
and existing staged-write recovery applies to edits. Source commands preserve
all-source mode. Local `config diff` and account `diff` use the same public operation
and report IDs and changed field names, including order, without exposing values.

Validation: 477 private backend/package tests and 395 independent public tests
pass. Both new graph modules enforce 100% statements/branches/functions/lines.
An installed packed CLI, with hosted fetch denied, selects a second site, diffs it,
renders a valid bundle, removes the site and restores the original revision.
Library transactions, missing/invalid input, secret redaction, immutable identities,
shared destination changes and real CLI execution are covered. Private and public
build/type/packed-consumer checks pass. Aggregate backend/package coverage is
67.19% statements / 58.71% branches / 71.84% functions / 67.20% lines privately,
and 76.47% / 71.48% / 76.24% / 76.54% publicly; floors rise to measured whole values.

These commands edit local graphs and compare service exports. Authenticated push,
stored base/desired/applied revisions, storage reconciliation, conflict resolution
and forwarder acknowledgements are still pending. Manual `.env` changes do not
refresh public payload versions; sync needs private baseline fingerprints or
explicit secret comparison. Unlinked graph deployment still uses the existing
local deploy adapter. This slice does not imply that the production service or
npm release has these capabilities yet.


### Implemented slice: atomic configuration versions and stable exports (2026-10-01)

Migration 0019 adds account configuration versions and transaction-local write
guards. SQL triggers cover inserts, material updates, removals and ownership
changes across connections, sources, destinations, monitors, sinks, deployments,
deployment connections and deploy targets. This includes existing website writers;
it does not depend on every route manually incrementing a counter. No-op writes,
discovery timestamps, ordinary heartbeat/metrics/status/checkpoint updates and
stale-bundle flags do not advance the version. Versions are deliberately
account-wide: unrelated configuration changes may conservatively conflict.

`commitConfiguration` inserts a version guard, executes ownership-checked prepared
mutations, reads the resulting version and deletes the guard in one D1 batch.
A stale guard aborts the transaction before graph mutation. Late constraint errors
roll back prior mutations and version changes. The SQL mechanism follows
[Cloudflare's documented D1 batch transaction behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
with workerd tests proving concurrent-writer exclusion and rollback. This internal
primitive does not authorize callers or accept SQL through an HTTP endpoint.

Deployment exports now read a configuration version before and after assembly.
They retry up to three times and return a no-store 409 on ongoing change, with no
partial graph or secrets. Deletion during assembly returns 404. Exports include an
optional `configurationVersion`; the public client validates it while accepting
older responses that omit it. Stable account versions do not yet solve the separate
OAuth broker payload/revision issue noted above.

Validation: 498 full-suite private tests pass, plus three added export-race cases
pass in the final nine-case bundle/export suite (501 private cases total). All 395
independent public tests, private/public builds and type checks, and public packed
consumers pass. The configuration-version module enforces 100% statements,
branches, functions and lines. A schema-18 upgrade fixture preserves the existing
forwarder row, ciphertext and reporting state, backfills version zero, and proves
runtime reports do not advance it. New-user initialization, direct configuration
writers, cascades, ownership moves, invalid versions, non-conflict errors, bounded
read retries and user deletion are covered.

This is the concurrency foundation, not the authenticated push endpoint. Next:
owned graph reconciliation, persisted desired/applied records, local base/version
tracking, explicit secret-transfer policy, push/conflict UX and applied reports.
Migrations 0018 and 0019 are still pending in production; npm publication and the
staged rollout remain pending. The pushed graph-editing CI passes its code checks
and image build but still fails Codecov upload with `Repository not found`.

### Implemented slice: shared inventory reconciliation and guarded persistence (2026-10-01)

The public `planDeploymentChanges` API validates resolved graph inputs and computes
private, dependency-ordered inventory changes without network or storage I/O.
Already discovered sources are adopted by connection/kind/provider-resource key,
with an explicit local-to-canonical source ID map. Null incoming metadata retains
known discovery metadata during adoption; explicit labels and metadata can update
it. Resource identities cannot be rebound, connection providers cannot change,
and sinks cannot move between monitors. Repeated shared destinations must agree.
Deselecting inventory or a monitor preserves it; only omitted sink edges of a
retained monitor are removed. Ordered selections and select-all intent are returned
for the deployment-state adapter. The caller's graph and inventory are not mutated.

The private adapter reads only account-owned rows in a stable configuration-version
snapshot, decrypts raw stored payloads, and delegates to the public planner. It does
not mint OAuth broker credentials or refresh providers. `reconcileOwnedGraph`
prepares encrypted writes and commits them through the version guard in one D1
batch. Inserts use plain INSERT, so a foreign account's colliding identity aborts
rather than becoming a successful no-op or overwriting that account. Updates and
edge removals retain ownership predicates. Late collisions roll back all earlier
writes, epoch changes and deployment-outdated flags. Dirty graphs mark only the
owner's bundles outdated. Unchanged graphs make no inventory or epoch changes.
Connection credentials must be explicitly resolved before persistence; rendered
OAuth broker values are not raw credential inputs for this adapter.

Validation: all 536 private tests and 409 independent public tests pass. Both
reconciliation modules enforce 100% statements, branches, functions and lines.
Workerd exercises all five foreign-identity collision types, concurrent writers,
full new graph creation, encrypted storage, all update/removal paths, source-ID
adoption, no-op/deselection behavior, owner-only stale flags, nullable metadata,
invalid stored payloads and sanitized decrypt failures. Installed tarballs expose
and execute the planner and synchronous validator without hosted access; all 15
packages and both compiled CLI aliases pass the packed-consumer checks. Private
and public builds/type checks pass. Aggregate private coverage is now 68.51%
statements, 60.27% branches, 73.03% functions and 68.03% lines, with floors raised
to 68/60/73/68. Public coverage is 77.25/72.41/76.96/76.93, respectively. Final
95/90 backend and 90/85 UI coverage targets remain required.

This internal inventory writer does not yet expose authenticated push, persist
ordered deployment selectors or desired/applied revisions, upload implicit secret
values, or deploy a forwarder. Next: additive deployment state storage, legacy
selector compatibility, registry/reporting validation at the account API boundary,
linked local baselines, explicit secret-transfer policy and push/apply reporting.
Production migrations, npm publication, staged rollout and final full coverage
remain pending; the goal is active. Codecov repository activation remains an
external CI blocker recorded above.

### Implemented slice: desired/applied revision storage and instance fencing (2026-10-01)

Additive migration 0020 records public revision history and separate desired/applied
state. Existing deployments remain legacy/unreported until an owner issues a
revision and activates an instance. No migration rewrites existing deployment
rows or bootstraps an invented applied revision. Desired sequence changes advance
the account configuration version; instance activation and applied reports do not.
The stored desired graph version makes subsequent website/configuration edits
observable as `stale`, without clearing known applied state or guessing what is
running. Public revision documents are structurally validated, canonicalized and
hashed, and reject a private secret-values map. Historical revision identity and
documents are immutable; foreign keys enforce known desired/applied revisions and
cascade history when the deployment is removed.

Internal storage APIs issue revisions with both configuration-version and desired-
sequence fences. Identical documents at the same graph version are no-op writes.
A new desired revision preserves the last acknowledged applied revision. Instance
activation uses a fresh server-generated ID and compare-and-swap on the prior
active ID. Acknowledgements accept only issued desired history from the active
instance, require increasing safe-integer report sequences, and cannot regress
the applied configuration sequence. Unknown, legacy, replayed, retired-instance,
invalid and out-of-order reports make no state change. Applying a rollback requires
issuing the previous document as a new desired sequence. The caller authenticates
the reporting token before using this internal acknowledgement primitive.

Validation: all 552 private tests pass; builds and type checking pass. The revision
state module enforces 100% statements, branches, functions and lines. Tests cover
owner isolation, no-op issuance, website conflicts, simultaneous writers, separate
desired/applied state, instance replacement, report replay/order validation,
immutable history, uncommitted history rejection, cascades and storage failure
classification. A pinned schema-19 upgrade fixture preserves the deployed row,
reporting token, image digest, selectors, metrics, ciphertext and configuration
version. The earlier schema-18 upgrade test now pins migration 0019 by name so
later additive migrations cannot silently change its baseline. Aggregate private
coverage is 68.73% statements, 60.58% branches, 73.21% functions and 68.21% lines.

This slice adds internal persistence, not the account push/reporting routes or
forwarder hook. Push must combine inventory, ordered deployment selectors and
revision issuance in one guarded transaction; it must validate registry/reporting
policy and explicit secret transfer before writes. An already stable graph can
use the standalone issuance primitive, but it does not prove that an arbitrary
submitted document matches inventory. Linked CLI baselines, complete website
round trips, broker revision stability and production rollout remain pending.
Migrations 0018–0020 are not applied in production. The pushed reconciliation CI
passes its code checks and image build; private Codecov upload still fails with
`Repository not found`. The final coverage and release goals remain active.

Clean-checkout follow-up: public reconciliation CI exposed undeclared driver imports
in the core graph fixture. The local nested checkout inherited private workspace
resolution and had masked this error. The fixture now imports the actual driver
and destination implementations through explicit workspace source paths, avoiding
a core-to-driver dependency cycle. A new public-only checkout under `/tmp`, with
an offline frozen-lockfile install and no inherited parent dependencies, passes
all 409 tests, the unchanged coverage gates, builds, type checks and all 15 packed
consumers/both CLI aliases. Future public validation must include a clean install
when dependency resolution or new cross-package fixtures change. The earlier
public CI failure was test-fixture resolution, not verified to be Codecov failure.

### Implemented slice: ordered selections across service rendering and website edits (2026-10-01)

Migration 0021 adds nullable ordered deployment selections. Null retains the full
legacy source-derived behavior, including discovery wildcard and heartbeat-only
empty selections. Modern selections preserve explicit connection/source/monitor/
sink order and provider select-all intent. The owned-row resolver keeps disabled
monitors in exports while the shared renderer continues to exclude their output.
Unknown/deleted rows are omitted on read, as with legacy selectors; wrong-parent
references are rejected, and cross-account rows/destinations are never resolved.
Saving validates all references, selected monitor scopes, registered providers,
provider all-source capability and the existing one-connection-per-provider rule.

Selector updates use the account version guard. Flat compatibility columns are
written before the canonical ordered representation in the same D1 transaction.
No-op updates preserve the epoch; material changes advance it and mark the bundle
outdated. The compatibility triggers override source and monitor sections
independently when existing website writers edit flat selectors. These read-only
flags are storage metadata, not portable manifest fields. A monitor edit, including
switching to wildcard monitors, preserves an all-source provider stream. A source
edit preserves monitor/sink order and drops only scopes no longer applicable to
those connections. Runtime, name and unchanged-selector updates retain both
ordered sections. A new modern write resets the compatibility overrides.

Bundle assembly and website exports consume this representation and pass select-
all through to the packaged renderer. The deployment API returns ordered selectors
and the correct connection set/order, including source-less all-source connections.
The website shows native all-source mode as current and future sources rather
than zero sources, and explains how an explicit source edit changes that mode.
Older service responses without ordered selections remain usable by the UI.
The inventory writer's timestamp unit was also corrected to milliseconds, with
creation/discovery timestamp regression assertions across every entity category.

Validation: all 581 backend/package tests and 12 UI tests pass; types and builds
pass. The ordered-selection module, deployment list page and UI selection summary
all enforce 100% statements, branches, functions and lines. Workerd exercises the
website export/PUT round trip, both independent legacy overrides, all-source
Supabase rendering, disabled monitors, source-less connections, no-op writes,
concurrent writers, scoped monitors, owner isolation, deleted inventory, wrong
parents, invalid versions and malformed selection shapes. A pinned schema-20
upgrade fixture preserves the deployment row (apart from the new null column),
revision/applied state, instance/report sequence, tokens, image digest, metrics,
ciphertext and account version. Existing schema-18 and schema-19 fixtures pass.

Backend aggregate coverage is 69.72% statements, 62.68% branches, 74.47% functions
and 68.83% lines, with floors raised to 69/62/74/68. UI aggregate coverage is
5.87/5.77/5.66/4.06, with floors raised to 5/5/5/4; most UI pages still require
baseline coverage before the final 90/85 gate. Run backend and UI coverage
sequentially: backend coverage cleanup removes its report directory, which is the
parent of the UI report directory. Public clean-install CI now passes its tests
and reaches upload; both repositories' Codecov uploads fail with `Repository not
found`, confirmed in their latest completed runs.

This slice completes lossless selector persistence/rendering and its website
compatibility path; it does not yet wire authenticated CLI push. Next: combine
owned inventory changes, selectors and desired revision issuance in one guarded
transaction, resolve explicit secret transfer and stable broker versions, then
connect the account transport, linked CLI baseline and forwarder acknowledgement.
Legacy discovered-inventory wildcard intent remains functional in service storage,
but portable pull/push must still preserve that future-discovery intent explicitly;
it is distinct from a provider-native all-source stream. Full baseline coverage,
remote/browser E2E, telemetry checkpoint hardening, dependency upgrades and the
verified release/rollout remain required. Migrations 0018–0021 remain unapplied in
production; this goal is active.

### Implemented slice: atomic complete-graph reconciliation and private runtime storage (2026-10-01)

`reconcileDeploymentConfiguration` now combines owned inventory mutations,
ordered selectors, heartbeat/metrics targets, encrypted deployment runtime values
and public desired revision/history into one account-version-guarded D1 batch.
The stored desired configuration version is the final version after every graph
mutation and history/state trigger, so a freshly committed graph is not
immediately marked stale. A fully unchanged graph preserves its sequence,
version, ciphertext and selector state. Canonical source adoption is returned as
an ID map without exposing private plan rows or values. A late history failure
rolls back inventory, runtime, selectors, reporting metadata, outdated flags,
version changes and write guards together.

The adapter selects the service's trusted packaged registry, validates provider
capabilities and destination flows, and renders before any writes. Reporting
scope must match this deployment and service origin. Neither submitted reporting
tokens nor runtime URL overrides can replace or redirect its authenticated
heartbeat/metrics traffic. A missing legacy reporting token is generated and
stored inside the same transaction. Supabase and Railway broker envelopes are
rejected as storage inputs; raw OAuth credentials remain encrypted unchanged,
while normal bundle assembly derives the runtime broker credentials separately.
The desired manifest in this primitive represents resolved raw storage intent;
stable broker payloads in the exported render-ready manifest still need the
separate boundary/transport work recorded below.

Migration 0022 adds nullable encrypted runtime environment storage. Known
reporting variables remain authoritative and derived; other private runtime values
survive bundle assembly and portable export, and the packaged renderer applies
values only to its declared manual variables. No private runtime JSON is stored
in public revision history. Malformed stored objects or ciphertext fail with a
sanitized error. Material runtime changes advance the account configuration
version and mark the bundle outdated; unchanged payloads retain their ciphertext.

Validation: all 603 backend/package tests pass, including concurrent complete-
graph writers, late transactional failures, foreign identity collisions, source
adoption, no-op/rebase behavior, valid metrics/all-source graphs, invalid registry
flows, report-scope/URL protection, signer failures, raw OAuth/runtime bridge
separation and storage error classification. Both new modules enforce 100%
statements, branches, functions and lines. The schema-21 upgrade fixture preserves
existing ordered selectors, desired/applied history, instance/report sequences,
tokens, image digest, metrics, ciphertext and account versions; only a new null
runtime column is added. Earlier upgrade fixtures remain pinned and passing.
Aggregate backend coverage is 70.50% statements, 63.90% branches, 74.78% functions
and 69.49% lines; floors rise to 70/63/74/69. Builds/type checks pass and the
existing 12 UI tests remain passing under their coverage gates.

This is the complete private storage transaction, not an authenticated HTTP push
or publication. The caller must authorize uploads and resolve raw storage secrets;
the transaction primitive performs no provider verification/network calls. Next:
stable raw-versus-broker export/version semantics, explicit preservation of legacy
future-discovery intent, then account push transport, linked CLI baseline/push,
website state display and forwarder acknowledgement hooks. Final full coverage,
remote/browser baseline, telemetry hardening, dependency upgrades, npm publication
and staged production rollout remain required. Migrations 0018–0022 remain pending
in production and the goal remains active.


### Credential intent and OAuth renewal (implemented, production rollout pending)

Supabase and Railway hosted credential references now identify an owner's OAuth
grant rather than its renewable access/refresh tokens or derived broker envelope.
The broker token is a deterministic signed connection/account payload; it was not
time-varying. The actual export mismatch was raw versus render-ready credentials,
coupled with normal OAuth renewal being counted as a configuration edit.

Migration 0023 assigns existing connections opaque credential identities without
changing ciphertext, account versions or existing deployment/reporting state.
Explicit credential replacement rotates that identity and advances the account
configuration version. Renewal changes a private nonce and encrypted token payload
while preserving credential intent. Renewal uses compare-and-swap on owner,
provider, intent and exact ciphertext; stale results cannot overwrite a reconnect
or another successful renewal. Provider helpers reuse a concurrent valid winner
or return a retry error instead of storing a stale response. Label-only graph
changes preserve credentials, including renewal committed after preparation.

Hosted export and the unified deployment transaction use the same keyed versions
for OAuth intent. Render-ready secret payloads can differ from storage payloads
without changing the public document/revision. PAT credentials and other secret
references retain payload-based versions. Explicit credential edits allocate the
new identity before signing and persist it in the same atomic graph transaction.
No opaque raw identity, access token or refresh token enters public history.
Renewal alone leaves desired state current and does not issue another sequence.

Validation: 615 backend/package tests pass, including schema-22 upgrade preservation,
raw/broker equality, renewal stability, explicit reconnect revision changes, stale
CAS rejection, concurrent replacement/deletion, cached/PAT paths and renewal versus
label commits. Credential intent and graph/deployment reconciliation retain 100%
statements, branches, functions and lines. Aggregate backend coverage is 71.32%
statements, 65.06% branches, 75.45% functions and 70.36% lines; CI floors rise to
71/65/75/70. Type checks and builds pass, and all 12 UI tests pass under their
existing coverage gates. Final aggregate targets remain 95/90; UI coverage still
requires the planned expansion to 90/85.

This does not serialize outbound provider renewal calls before they occur; tests
prove persistence fencing. Provider refresh-token concurrency/lease behavior needs
explicit coverage in the provider reliability baseline. Authenticated push and
secret transfer, linked CLI baseline/push, portable legacy future-discovery intent,
website/applied-state display and forwarder acknowledgement remain outstanding.
Explicit private exports currently retain the existing credential payload shape;
OAuth export disclosure and standalone versus broker credential policy still need
review at the push transport boundary. Broader E2E, final coverage, telemetry
hardening, dependency updates, publishing and staged rollout remain in scope.
Migrations 0018–0023 remain unapplied to production. The goal remains active.


### Portable discovery intent (implemented, production rollout pending)

Portable schema-1 manifests now retain optional per-connection `discoverSources`
and root `discoverMonitors` flags. The former means materialize the connection's
owned discovered catalog on refresh; the latter means include applicable enabled
monitors and their current sinks. Neither requires provider-native `selectAll`,
and native all-source and catalog-discovery modes are mutually exclusive for a
connection. Existing manifests without flags retain their explicit behavior.

The shared package exports `resolveDeploymentDiscovery(inventory,input)` without
service dependencies or network calls. It keeps snapshot order, appends new rows
in caller inventory order and retains policy flags. `planDeploymentChanges` uses
that resolver before planning an atomic owned graph write, including new monitors
and sinks without dropping existing edges. Standalone rendering remains fully
functional offline with the materialized snapshot; callers refresh discovery
against their own catalog before generating updated artifacts.

The hosted assembler exports legacy null source/monitor selection as explicit
portable policy. Ordered selection storage and resolution preserve the flags,
expand only owned inventory and validate explicit parents/references. An export
can pass through the unified storage transaction without freezing legacy discovery.
A later bundle refresh includes newly discovered sites, newly enabled applicable
monitors and new sinks. A website source-only override also re-scopes retained
monitor discovery to the effective source connections, rather than their previous
saved connection snapshot. Explicit snapshot order remains stable; service additions
have deterministic catalog order. No schema migration is needed for the optional
JSON fields; production still requires the previously pending migration chain.

Public graph edits and CLI JSON edit files can change both policies. Source removal
freezes discovery for the affected connection; monitor/sink removal freezes monitor
discovery so refresh cannot restore a removed selection. Other edits retain the
policy. Value-free diffs show policy changes. Website source summaries distinguish
native future-stream subscriptions from discovered catalog refreshes; this does
not claim running forwarders automatically apply catalog additions.

Validation: 625 backend/package tests, 416 public package tests and 14 UI tests.
Coverage gates retain 100% statements/branches/functions/lines for manifest, graph,
reconciliation and service ordered selectors, and for the UI source summary.
Backend coverage is 71.62/65.92/76.15/70.48 (statements/branches/functions/lines),
public coverage is 77.56/73.06/77.52/77.08, and UI coverage is
6.31/6.31/5.85/4.28. Floors rise to 71/65/76/70, 77/73/77/77 and 6/6/5/4
respectively. Final backend/public 95/90 and UI 90/85 targets remain outstanding.
Builds and type checks pass. Isolated packed-consumer validation passes for all
15 packages and both CLI aliases, including the public discovery resolver and
policy editing/removal from compiled packages. Policy documentation ships with
both public core and CLI. Matching updated CLI/library versions must publish
before production serves the optional fields to clients with strict older parsers.

Next: account-authorized push/secret transport, linked CLI baseline and recovery,
website desired/applied state, forwarder acknowledgment, full E2E/coverage,
provider concurrency/telemetry hardening, dependencies, publication and rollout.
No npm release or production migration/deployment is claimed by this slice.
The goal remains active, and Codecov repository activation remains an external
configuration issue rather than a reason to stop independent implementation.


### Authenticated configuration push and public transport (implemented)

`PUT /api/deployments/:id/config` now accepts a portable manifest plus both the
account `expectedConfigurationVersion` and deployment `expectedSequence` fences.
Website sessions and active CLI account credentials use the same owned account
boundary; forwarder reporting tokens, revoked/expired tokens and foreign-owned
deployments cannot authorize push. Configuration GET/PUT return JSON 401 rather
than redirecting unauthenticated callers, and apply no-store headers including
authentication failures. GET exports now include the current desired sequence.
Streamed requests have a 1 MiB byte limit even without Content-Length.

Push resolves unchanged private references from owned storage, and requires
explicit `uploadSecrets:true` for new/changed JSON-valued payloads. Only referenced
variables may be uploaded; unrelated environment values are rejected. The public
client performs that check and payload validation before transmission. Changed
values retaining an unchanged version are rejected rather than silently lost.
Reference resolution is restricted to owned connection/source/destination purpose
names, preventing a foreign namespace from becoming a keyed verification oracle
even when two accounts have identical payloads. Canonical naming uses the public
`manifestSecretName` helper. Aliased native source identities reuse owned metadata;
new source metadata and owned metrics payloads follow the same transfer rules.
Conflicting uses of a single reference cannot overwrite each other's resolution.

Unchanged OAuth references resolve the latest raw stored grant. Exported broker
envelopes can be supplied with an unchanged verified grant reference, but are
never persisted as raw credentials; changed broker references require raw values.
Verified retained credential identities are carried into transaction preparation,
where current raw credentials replace the earlier read. Subsequent label-only
writes preserve renewal committed after preparation. Both read-phase renewal
races are covered, preventing automatic renewal from being restored to stale tokens
or counted as an explicit grant replacement. Explicit raw replacements remain
possible with authorized payload uploads and changed references.

The existing atomic graph transaction persists inventory, selectors, encrypted
credential/destination/runtime values and desired public history together. HTTP
conflicts return 409; invalid configurations return sanitized 400 errors; unavailable
storage returns 503 without reflecting private payloads or storage details. No
provider API calls, forwarder application or applied acknowledgement are performed
by push. Existing reporting tokens remain authoritative and retained.

The packaged library exposes `pushDeploymentConfig`, push/commit DTOs, optional
pull desired-sequence metadata, canonical response/hash verification, retained
caller cancellation and exact-origin/approval-path device URI validation. It
continues to require caller-provided fetch and contacts the service only when an
explicit account method is called. Isolated compiled consumers exercise push with
an injected transport and no network access.

Validation: 652 backend/package tests, 421 public tests and 14 UI tests pass;
package/service type checks and builds pass. The push resolver, manifest,
graph/deployment reconciliation and public service transport enforce 100%
statements, branches, functions and lines. Tests cover cookie/account authorization,
revocation/expiry, cross-account namespaces and identity collisions, explicit uploads,
manual-env revision protection, raw/broker policy, native aliases, metrics/runtime,
concurrent/stale writers, sanitized storage failures, stream errors/limits and both
renewal timing races. A prior discovery test's random-ID ordering expectation was
replaced with fixed fixture identities. Backend coverage is
72.47/67.35/76.69/71.02, with floors raised to 72/67/76/71; public coverage is
77.78/73.65/77.72/77.24 under 77/73/77/77 floors. All 15 packed packages and both
CLI aliases pass isolated checks.

The linked CLI push command, persisted baselines/private fingerprints and crash
recovery remain the next required consumer work; this is the authenticated API and
library capability. Website desired/applied display, existing-target forwarder
updates and acknowledgement hooks, full remote/browser E2E, final coverage,
provider/telemetry hardening, dependency updates, npm publication and staged
production rollout remain required. Migrations 0018–0023 and this route remain
unreleased in production. The goal remains active; Codecov activation remains an
external configuration issue while independent work continues.

### Durable local configuration replacement (implemented)

Standalone graph edits/exports and hosted pulls now share a durable two-file
transaction for manifest YAML and its private companion `.env`. A mode-0600 `.logtura-transaction.json` journal is created exclusively
and flushed in the shared directory before copying shared environment values or
preparing stages. Stages are flushed before any original moves. Directory entries are flushed after original/installation moves
on supported platforms. A separately flushed commit marker becomes authoritative
before backups are discarded. This lock covers all configs sharing that `.env`.

`logt -c <config> config recover` checks the journal's schema, exact destination and
stage/backup paths, regular-file artifacts and process owner. Recovery refuses a
live or unverifiable owner. Before commit it restores originals/removes newly
installed files; after commit it keeps the new pair and cleans up. Missing committed
destinations retain recovery data rather than discarding the last backup. Rollback
attempts both files even when one restore fails and retains the journal on failure.
All config reads/edits refuse pending recovery, preventing a mixed pair from being
rendered or deployed. Stages, backups and journals must be retained together.
Windows skips unsupported directory fsync; equivalent machine-power-loss durability
is not claimed there. PID reuse conservatively refuses recovery.

Validation includes real child processes killed after each of five rename boundaries,
ordinary write/rollback/cleanup failures, initial creation without originals, malformed
journals, forged paths, symlink artifacts, live/unverifiable owners, absent committed
destinations, shared-environment exclusion and executable recovery commands. The
new transaction module enforces 100% statements/branches/functions/lines in both
repositories. Backend/package validation passes 674 tests across 62 files, with
coverage 72.79/67.63/76.98/71.15. The independent public layout passes 443 tests
across 35 files with coverage 78.31/74.07/78.24/77.45, and both layouts pass
package builds, CLI types and all 15 packed-package checks. Packed consumers additionally crash an actual
compiled graph edit and recover it through the installed CLI without a TypeScript
loader or service dependency.

Linked deployment baselines, private fingerprints, explicit secret push and uncertain
remote-commit recovery remain required next. This local transaction currently covers
the YAML/environment pair; extending it for linked state must preserve the same
journal and recovery guarantees. All other remaining publication, rollout, final
coverage, full E2E and service/forwarder capabilities remain in scope.

### Hosted deployment links and offline change status (implemented)

Hosted `pull` verifies the active account identity and requires account configuration
and deployment desired-sequence fences. It creates a mode-0600
`<config>.logtura-link.json` containing service origin, account/deployment identity,
public baseline manifest/revision, both counters and keyed fingerprints of referenced
private JSON payloads. A fresh random private fingerprint key remains only in that
file. Neither resolved payloads nor account/reporting credentials are stored there;
private link, journal and environment artifacts are excluded from repository tracking
and documented for consumer projects. JSON formatting/key order does not change a
fingerprint. Unrelated environment values are never included.

Hosted pull commits YAML, `.env` and the link through one recoverable transaction.
Legacy two-file journals remain supported. Local graph edits retain the hosted
baseline; an export to a new path does not copy the source deployment identity.
Existing target baselines remain attached to that target when explicitly overwritten.
Link schema, service origin, identities, counters, document revision and complete
fingerprint map are validated before use; symlink/unsafe paths are refused. Pull
checks that the link matches its exact exported deployment/revision/counters before
writing, and explicit force is required for replacing existing configuration/link state.

`logt -c <config> config status` works offline, returning the linked public identity,
fences and value-free graph/private change entries. Private entries distinguish
missing, added, removed and changed payloads; manually changed payloads retaining
the same public reference version are marked `requiresVersionUpdate:true`. Neither
fingerprints nor private keys/payloads are printed. Standalone/unlinked configs report
`linked:false` without contacting a service.

Transaction acquisition captures original existence only after obtaining the exclusive
journal file descriptor. Destination/overwrite checks run again under that lock,
preserving a concurrent writer's newly created file and preventing rollback from
mistaking it for a newly installed destination. Reserved environment/journal config
paths are rejected for writing and recovery. Recovery tests kill real child processes
at all seven rename boundaries for linked three-file replacement and verify that
all three retain the previous revision before commit or the new revision afterward.
Ordinary link installation failures restore existing YAML, environment and baseline.

Validation: 695 backend/package tests across 63 files pass, with coverage
73.20/68.18/77.28/71.43 and floors raised to 73/68/77/71. Link, pull and transaction
modules enforce 100% statements/branches/functions/lines in both layouts. Packed
consumers perform an authenticated hosted pull using an injected fixture transport,
then edit and inspect the linked config offline through installed executables; all
15 packages and both CLI aliases pass. The independent public layout passes 464
tests across 36 files, with coverage 78.97/74.93/78.78/77.91 and floors raised to
78/74/78/77. Package builds and type checks pass in both layouts.

CLI push still requires private-reference restamping/explicit uploads, service/account
identity enforcement and durable uncertain remote-commit recovery. The baseline is
now present for that work; push is not claimed by this slice. Existing-target metadata,
forwarder apply/acknowledgement and website desired/applied state, full remote/browser
E2E, final coverage, provider/telemetry hardening, dependencies, publication and
staged production rollout remain required. No npm release or production migration
or deployment is claimed. The complete shipping goal remains active.

### Durable hosted push receipts and recovery transport (implemented)

Migration 0024 adds immutable owned deployment push receipts without changing
legacy forwarder tokens, ciphertext/credential intent, image digests, runtime values,
account configuration versions or desired/applied state. Receipts live until their
deployment is deleted. Their writes do not advance graph versions.

`PUT /api/deployments/:id/config` optionally accepts a canonical UUIDv4 `requestId`.
The service fingerprints the effective public manifest, both fences, explicit-upload
switch and parsed private JSON values with a keyed HMAC. It stores only that digest
and the public commit receipt, never resolved upload values or an unkeyed private
payload hash. Omitted/false upload switches and private JSON whitespace/key order
have the same effective request identity. Changed content under an existing ID
returns `request_id_reused` (409).

Receipt insertion is appended to the same guarded D1 transaction as inventory,
selectors, encrypted private values and desired history. A receipt insertion failure
rolls the entire graph back. No-op commits can receive new receipts without advancing
account versions or desired sequences. Prior matching receipts are returned before
secret resolution/fence checks; concurrently committed matching receipts also take
precedence over stale-fence or unique-key errors. Replaying a historical request never
restores an older graph after subsequent website edits.

`GET /api/deployments/:id/config/receipts/:requestId` returns an owned public receipt
with its original configuration version, desired sequence, manifest revision/document
and source aliases. Active account tokens and website sessions can read it; forwarder
reporting tokens, unauthenticated callers and foreign owners cannot. Replies include
no-store headers including authentication failures. Missing receipts on owned
deployments are distinguished from missing/foreign deployments and storage errors.
Corrupt/unavailable receipt storage produces sanitized failures without reflecting
private data. A historical receipt proves that commit, not that it is still desired.

The packaged SDK accepts request IDs and exposes `getDeploymentPushReceipt`,
`isDeploymentPushRequestId` and shared `validateDeploymentConfigCommit`. Lookup
returns null only for an owned missing receipt; account, ownership, storage and
schema failures remain errors. It does not retry writes implicitly. Compiled consumers
exercise both push and receipt lookup with injected fetch and no network dependency.

Validation passes 706 backend/package tests across 65 files and 465 public tests
across 36 files. Coverage is 73.56/68.70/77.65/71.70 privately and
79.11/75.23/78.95/78.01 publicly; public floors rise to 79/75/78/78. Receipt storage,
push resolution, graph reconciliation and SDK transport enforce 100% across all
four metrics. Tests cover concurrent identical/different requests, no-op receipt
writes, explicit uploads/equivalent JSON, write rollback, immutable/corrupt storage,
ownership/authentication/caching/deletion and schema-23 upgrade preservation. An
end-to-end SDK transport deliberately drops the response after D1 commits, then
retrieves the original receipt and safely repeats the request. Both layouts pass
package builds/types and all 15 packed-package checks; the service build passes.

CLI pending-request persistence, private-reference restamping/explicit-upload
selection, linked account/service enforcement, receipt recovery and atomic local
baseline advancement remain the next consumer work. Existing-target forwarder
updates and acknowledgements, website desired/applied display, full remote/browser
E2E, final coverage, provider/telemetry hardening, dependencies, npm publication and
staged production rollout remain required. Migration 0024 joins 0018–0023 as
unreleased production work. The full shipping goal remains active.


### Linked CLI push and durable resume (implemented)

The packaged CLI now exposes `push`, explicit changed-private-payload upload and
`push --resume`. Preparation checks the linked origin/account, both revision fences,
all referenced payloads and credential purpose changes. Changed references receive
opaque keyed versions; unchanged private data is retained remotely. Changed OAuth
broker credentials require raw grant material or a fresh pull.

A mode-0600 pending request is persisted and fsynced before PUT, with a stable UUID,
exact request, original baseline and keyed local snapshot. It contains opted-in
private uploads until recovery completes. Receipt lookup precedes retry. Definitive
400/409 rejection is recorded; unknown outcomes cannot be abandoned by accepting
remote state. Confirmed commits/rejections allow explicit latest-remote acceptance;
replacing intervening local edits additionally requires `--force`. Successful import
advances YAML, environment and link in one recoverable transaction. Resuming after
local advancement but before pending cleanup performs no second write. Normal edits,
pull and deployment refuse pending pushes; offline status remains available.

Directory locks use per-process random ownership markers and conservative live-PID
checks. Recovery does not delete another writer's marker. Pending/schema/payload
validation fails without exposing values. Both recovery artifacts are gitignored.

Validation: 729 backend/package tests across 66 files pass. Private aggregate coverage
is 74.49% statements, 69.99% branches, 78.29% functions and 72.31% lines; enforced
floors rise to 74/69/78/72. Push and its lock enforce 100% across all four metrics.
The installed packed CLI test drops a committed response, resumes from its receipt
and proves only one PUT occurred. All 15 packed packages and both CLI aliases pass.
Public validation passes 488 tests across 37 files with coverage of
80.59/77.13/80.06/79.03 (statements/branches/functions/lines). Public package builds
and typechecks pass. Tests also cover explicit uploads, account/origin fences, local/remote conflicts,
malformed private state, lock races, cleanup interruption and Windows directory-sync
behavior. These tests do not substitute for the planned real service/browser/forwarder
journey or destructive remote E2E harness.

Existing-target forwarder apply/reporting, website desired/applied display, complete
local/workerd/remote/browser E2E, final coverage targets, provider/telemetry hardening,
dependency upgrades, npm publication and staged production rollout remain required.
No npm release, production migration or deployment is claimed by this slice. The
complete shipping goal remains active.


### Existing deployment target identity and linked Fly updates (implemented)

Hosted config exports now include a validated public deployment target: target kind,
managed flag, pinned image digest and, when known, existing Fly app/machine/region/
organization. A shared packaged validator rejects unknown/private fields and unsafe
identities. The storage adapter projects only known metadata fields and a recognized
`fly:app:machine` identity. It does not derive a running app from a renamed display
label. Conflicting stored app identities remain unresolved. Reads preserve stored
credentials, reporting tokens, image digests and graph/revision state.

The CLI preserves this optional target in its private baseline and offline status.
Earlier links still parse; linked deployment requires a fresh target-aware export.
`deploy fly` on a linked self-managed graph uses the recorded app and region,
requires local graph/private changes to be synchronized first and rejects conflicting
app/region/organization overrides before artifacts or credential writes. Missing or
inaccessible linked apps fail before app creation. Unresolved legacy targets require
an explicit existing `--app`. Managed updates retain the service deployment path.
Standalone configs retain app creation through local flyctl without account login.

Validation passes 739 private tests across 70 files and 497 public tests across 40
files. Coverage is 75.39/71.32/79.05/73.24 privately and 82.08/78.75/81.25/80.71
publicly (statements/branches/functions/lines); aggregate floors rise to 75/71/79/73
and 82/78/81/80. Target projection, shared validation and linked target resolution
have enforced 100% coverage in all four metrics. Both package layouts build and
pass types and all 15 packed consumer checks. The installed CLI exercises an existing
app update using a local flyctl fixture, proving no `apps create` call and preserving
the recorded region. The service build passes. This is not a real Fly rollout proof.

CI on the prior shipped CLI push heads passed build/packed/Vector/test checks but
failed only at Codecov upload: `Repository not found` (private run 36950190948,
public run 36950184357). That external activation/access configuration remains
unresolved; upload failure is still enforced and no green CI claim is made.

Runtime activation/report transport, loaded-configuration acknowledgements, managed
CLI/service apply orchestration and website desired/applied UI remain required.
Also outstanding: real local/workerd/remote/browser journeys and remote cleanup,
final coverage targets, provider/telemetry hardening, dependency updates, publication
and staged production rollout. No production target, image, migration or running
forwarder was modified by this slice. The full shipping goal remains active.


### Account instance activation and authenticated applied reports (implemented)

The shared package now owns desired/applied state, activation/receipt and report
schemas and validators. State validation checks the actual desired document hash,
safe counters, known fields, instance identity and matching revisions when applied
and desired sequences coincide. The service uses these packaged contracts.

Owned session/account-token endpoints expose `GET config/state` (null for legacy
unissued deployments), `POST config/instances` and `GET config/instances/:requestId`.
Activation requires the account version, desired sequence/revision and prior active
instance identity. A new server-issued UUID and immutable activation receipt commit
in one guarded D1 batch. Migration 0025 adds receipts without rewriting existing
forwarders, ciphertext/grants, runtime values, reporting tokens, image digests,
telemetry or desired/applied history. Receipt writes and activation do not advance
account configuration versions. Identical concurrent requests and response-loss
retries return the same receipt; conflicting request-ID reuse is rejected. Historical
receipts never reactivate retired instances. Receipt-write failure rolls activation
back. Receipts are retained until their deployment/account is deleted.

`POST /api/applied/:id` uses the deployment reporting token and a fresh storage lookup
to honor token rotation immediately. It rejects account credentials/session-only
requests and validates bounded streamed JSON (8 KiB), safe report counters and issued
revision identities. Accepted reports advance applied history from the active instance;
unknown revisions, retired instances, replays and regressions are ignored without
changing graph versions. Existing heartbeat and metrics endpoints remain independent.
These new endpoints use no-store replies and sanitized storage/validation failures.

The account SDK reads state, activates instances and looks up receipts. A separate
`DeploymentReportingClient` rejects account tokens and posts applied reports with
caller-supplied fetch, no cookies/redirects and a bounded timeout. It performs no
implicit deployment, activation, acknowledgement or retry. A runtime caller must
report its actually loaded configuration; the packaged transport itself cannot prove
that a generated file has been loaded.

Validation passes 753 private tests across 74 files and 503 public tests across 42
files, with zero unhandled workerd errors. Coverage is 76.04/72.23/79.55/73.66 privately
and 82.44/79.57/81.73/80.95 publicly (statements/branches/functions/lines); floors rise
to 76/72/79/73 and 82/79/81/80. Shared contracts, SDK/reporting transport and route
handlers enforce 100% across all metrics. Instance transaction code enforces
97% statements, 95% branches and 100% functions/lines; its unexercised defensive path
is a successful batch reporting zero receipt changes despite a successful CAS.
Tests cover actual workerd/D1 response-loss recovery, concurrent activations,
replacement/fences, token rotation, bounded/malformed streams, storage rollback,
immutable/corrupt receipts, ownership/authentication and schema-24 upgrade preservation.
Both package layouts build/typecheck and pass all 15 packed consumer checks; the
service build passes. The installed SDK exercises state, activation/receipt and
reporting exports through injected transports.

Forwarder runtime activation metadata, durable report counters/retries, actual loaded
configuration verification, CLI/service apply orchestration and website desired/applied
UI remain required. Full real local/workerd/remote/browser E2E, final coverage targets,
provider/telemetry hardening, dependency updates, npm publication and staged production
rollout also remain outstanding. Migration 0025 joins 0018–0024 as unapplied production
work. The previously verified Codecov activation/access blocker remains unresolved;
no new green CI, npm release or production deployment is claimed. The complete goal
remains active.


### Website desired/applied revision display (implemented)

The deployment detail page now displays desired and last applied revision identities,
the applied-report time and configuration status. It distinguishes legacy unissued
state, waiting for the current forwarder, an older applied revision, configuration
changed since issuance and a current report matching the desired revision. Instance
replacement preserves historical applied information but does not display “In sync”
until the replacement reports. Status wording describes forwarder reports; it does
not claim runtime verification that has not yet been implemented.

The browser reader validates the shared packaged state contract and actual desired
manifest hash, uses session authentication, encodes deployment IDs and bounds reads
with a 20-second timeout. The card renders no manifest payloads or instance IDs.
Malformed/private-bearing replies and status read failures remain local to the card,
with a value-free error and manual retry; they do not disable the existing page.
Requests are keyed to deployment and refresh generation. Late replies after navigation
or unmount cannot replace current status. Website saves and deployment-page reloads
refresh the revision card; users can explicitly refresh after an external CLI update.
There is no continuous polling. Existing bundle-outdated, image and heartbeat/status
bookkeeping remains separate from this public configuration-revision display.

Validation passes 27 UI tests across five files. UI coverage rises to
19.52% statements, 16.42% branches, 16.12% functions and 17.77% lines; enforced
aggregate floors rise to 19/16/16/17. The revision component enforces 100% across all
four metrics. Tests cover state meanings, private/error isolation, retry, late-response
and unmount handling, authenticated/encoded API reads, malformed replies and network
errors. Actual deployment-page integration tests cover initial status, a website save
refreshing the card, keeping the page usable on status failure and deployment-load
failure behavior. Typecheck and the service build pass. The backend protocol was
unchanged by this slice; its preceding 753 private/503 public tests and packed checks
are separate evidence, not a claim of a new real-browser/remote forwarder journey.

Rechecked protocol-head CI fails only at Codecov upload (`Repository not found`):
private run 36952896188, public run 36952893098. The private forwarder-image build
passed. External Codecov activation/access remains unresolved and enforced.

Actual loaded-configuration verification, durable forwarder report counters/retries,
CLI/service apply orchestration, complete real local/workerd/remote/browser E2E and
remote cleanup remain required. Final backend/public 95/90 and UI 90/85 coverage,
provider/telemetry hardening, dependency updates, publication and staged production
rollout also remain outstanding. No package release, production migration or deployment
is claimed. The full shipping goal remains active.


### Shared runtime integrity and durable reporting engine (implemented)

The packaged core now compiles an issued manifest into its actual bundle and a
private runtime descriptor. It binds the public revision/instance, generator and
Vector versions, exact YAML/asset bytes (including binary assets) and resolved
runtime environment values with private keyed proofs. Missing payloads or runtime
values, malformed paths/proofs, mismatched revisions and changed observations fail
before reporting. The private descriptor contains its integrity key and must remain
with private install state; only the public instance/revision report reaches the API.

The pure reporting engine requires a serialized durable store, persists intent
before transport and records completion afterwards. Lost acknowledgments or failed
completion writes replay the same report counter. Ignored replay responses complete
that local attempt without claiming acceptance. Corrupt/foreign checkpoints and
exhausted counters fail closed. Generator identity uses the built package version;
the Vector pin is shared with Dockerfile rendering. Existing generated output is
unchanged.

Validation passes 760 private tests across 75 files. Coverage is
76.30/72.74/79.78/73.85 (statements/branches/functions/lines). The new runtime module
enforces 100% for all four metrics in both repository layouts. Tests cover descriptor
validation, binary integrity, private/runtime resolution, durable intent ordering,
acknowledgment loss, failed completion persistence, monotonic counters and corrupt
state. A workerd test compiles an owned issued manifest, loses an accepted report's
response, retries the same counter and verifies stored applied history. Its readiness
observation is a fixture; this is not evidence of an actual Vector process. Packed
consumer checks cover compilation/verification/reporting and the built package
version. Public validation passes 509 tests across 43 files at
82.83/80.27/82.11/81.23 coverage; its aggregate floors rise to 82/80/82/81.
Both package layouts pass build/typecheck and all 15 packed checks; the service
build passes.

The real pinned Vector delivery fixture now renders through issued-manifest
compilation, checks the owned running container's version and read-only configuration
mount, reads its actual YAML bytes and launched environment, and verifies them
against the descriptor after readiness. Changed YAML or a changed bound environment
value fails verification. Normalization, filtering, routing, context and webhook
503 retry delivery still pass without the Logtura service. This proves the shared
verification contract against an actual container fixture; production process
adapter/container wiring and actual service report delivery remain separate work.

A real process adapter remains required: private immutable files/environment,
owned-process readiness and version observation, atomic filesystem checkpoints,
serialization across restarts, backoff, shutdown and container wiring. CLI/service
activation and apply orchestration, actual Vector reporting E2E, remote/browser
journeys and durable remote cleanup also remain required. Final coverage targets,
provider/telemetry hardening, dependency updates, publication, unapplied migrations
0018–0025 and staged production rollout remain part of the active full shipping goal.
