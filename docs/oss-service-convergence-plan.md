# Logtura shared backend and deployment synchronization plan

This plan makes the published CLI and libraries fully usable without the hosted service, makes the service consume the same public backend operations, and lets users move between the website and CLI while updating the same forwarder. A thorough compatibility baseline and enforced CI coverage come first. Dependency major upgrades have a separate decision process.

Status: implementation in progress. The starting inventory records repository and production inspection on October 1, 2026; implemented milestones and remaining work are tracked below. Completion still requires all outcome/validation gates. This plan does not authorize destructive tests against existing production resources.

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


### Node filesystem reporting and bounded delivery recovery (implemented)

The installed CLI library now exports a durable filesystem store/one-shot reporter
and a reporting loop. Mode-0600 stages are flushed before atomic checkpoint
replacement, with parent-directory fsync on POSIX (Windows skips directory fsync).
A process-owner directory lock covers load, transport and completion together;
concurrent reporters fail, and dead owners recover without discarding uncertain
intent. Invalid/foreign checkpoints, symlinks and unsafe files fail closed. Cleanup
removes only narrowly named abandoned regular stages. Each activated instance needs
its own checkpoint on persistent private storage. Existing configuration pushes use
the extracted shared directory-lock implementation with unchanged behavior.

The loop re-observes the caller's owned runtime on every attempt. Transient network
errors, HTTP 429/5xx and transport timeouts retain intent and use jittered exponential
backoff (default 1–30 seconds). Successful or ignored responses complete the attempt
and resume the normal 60-second interval. Integrity, storage, authentication, schema
and observer/callback errors stop; local TypeErrors are not mistaken for transport
failures. Abort interrupts waits and prevents new observations/reports; an in-flight
transport finishes before return, bounded to 20 seconds by the reporting SDK.

Validation passes 775 private tests in 76 files and 524 public tests in 44 files.
Private coverage is 76.56/72.96/80.00/73.99 and public coverage is
83.17/80.53/82.44/81.44 (statements/branches/functions/lines). Aggregate floors rise
to 76/72/80/73 and 83/80/82/81. Shared private locking enforces 100% across all metrics;
the new reporting adapter enforces 97% statements, 95% branches and 100% functions
and lines (measured 97.67/96/100/100). Untaken defensive paths are Windows directory
fsync skipping and an unexpected non-abort timer failure; Linux checks do not claim
Windows execution. Tests kill an actual Node writer at six fsync/rename boundaries,
then recover the lock, stage and report counter. They also cover overlapping writers,
corrupt/foreign state, symlinks, serialization failure, bounded retry/reset behavior,
transport-only retry classification and shutdown during each phase.

Both layouts pass package builds/typechecks and all 15 packed consumer checks, which
exercise the installed filesystem reporter and loop exports. The service build passes.
The real Vector fixture verifies its own running container and then runs the installed
Node reporter against a local HTTP fixture. That fixture accepts counter 1 but loses
the acknowledgment; requests arrive as 1, 1, 2, and private durable state completes at
counter 2. Filtering/routing/context and webhook 503 retry still pass. This is a real
Vector/HTTP/filesystem journey with a local reporting fixture, not a claim of a complete
hosted workerd, remote or browser apply journey.

Rechecked foundation-head CI (private 60dabb0 run 36955767513, public f1550ea run
36955763976) fails only at Codecov upload with `Repository not found`. Private
forwarder-image run 36955767550 passes. External Codecov repository activation/access
remains unresolved and the upload gate stays enforced.

Production owned-process startup/readiness/version capture, immutable file/asset
installation, shutdown and container wiring remain required, alongside durable
activation and CLI/service apply orchestration. This Node adapter supplies reporting
persistence/retry rather than manufacturing process observations. Full local/workerd,
remote and browser journeys/cleanup, final backend/public 95/90 and UI 90/85 coverage,
provider/telemetry hardening, dependency upgrades, npm publication, migrations 0018–0025
and staged production rollout remain outstanding. The full shipping goal remains active.

### Owned Vector process and packaged runtime executable (implemented)

The CLI library now exports `runForwarderProcess` and `forwarderRuntimeMain`, and
its npm package includes a dependency-bundled `logt-forwarder` executable. It checks
an issued private descriptor, installed file bytes, captured environment and the
actual installed Vector version before starting a POSIX child process group. YAML
is copied into a private read-only snapshot. Driver assets remain at their generated
`/opt/logtura/assets` paths and are verified on every report; installation should
bake them into the image or mount them read-only. Ambient Vector config/reload/logging
controls cannot add inputs or bypass the supervisor's explicit arguments.

Readiness requires the owned child's pinned internal API-bind event, then loopback
health and a still-running child. Vector 0.55's text logger writes stderr, while its
JSON logger writes stdout. The supervisor uses text stderr so pipeline stdout stays
separate from startup recognition. The private descriptor/key is never passed to
Vector or printed. The reporting loop re-verifies the snapshot, assets and launch
environment before delivering each report through the durable store.

A separate runtime lock prevents overlapping launches for one checkpoint. Stop
interrupts startup and scheduled work, drains an in-flight SDK request, signals the
whole owned process group and kills unresponsive children after the grace period.
Failed cleanup retains the snapshot. Container shutdown should allow at least 35
seconds with default SDK/process limits. Persistent per-instance checkpoint storage
is required for restart recovery. Host SIGKILL can orphan a detached child; container
runtimes must own the full process tree. The runtime executable requires an issued
artifact and does not silently treat an unissued installation as applied.

The real Vector fixture now starts the packaged runtime as PID 1 with its own Vector
child. It verifies actual startup/reporting, accepted-ack loss recovery (counter
requests 1, 1, 2), event delivery and graceful container exit code 0. Its reporting
HTTP fixture is proxied through container loopback so it works when the Docker daemon
host differs from the caller's host. Async Docker stop keeps that fixture's HTTP
server responsive while the runtime drains. There is no hosted-service dependency
in this standalone fixture. Existing delivery/filter/context/503 retry checks still
pass. At this milestone the fixture mounted a Linux Node binary. The packaged-image
validation below replaces that mount with an image-supplied binary.

Validation passes 787 private tests in 77 files and 536 public tests in 45 files.
Private coverage is 77.06/73.33/80.28/74.25 and public coverage is
83.82/80.95/82.88/81.81 (statements/branches/functions/lines). Private floors rise to
77/73/80/74; public floors remain 83/80/82/81. Process supervision enforces
98% statements, 92% branches and 100% functions/lines (measured
98.42/94.36/100/100). Runtime CLI validation enforces 100% statements/functions/lines
and 92% branches (measured branches 92.85%). Tests cover owned versus foreign readiness,
malformed/oversized diagnostics, immutable YAML after source edits, missing assets,
unsafe file types, version mismatch/discovery failure, launch failure, unexpected exit,
health/callback failure, phase-specific stop races, forced shutdown and failed cleanup.
Explicit child handshakes replace timing assumptions for startup/shutdown tests.
Both layouts pass builds/typechecks, all 15 packed checks including the new executable,
and real Vector supervision/delivery. The service build passes.

CI audit found an additional clean-public defect at adapter head ecd7d66 (run
36956891472): six crash tests imported `tsx`, which was available through the private
checkout but absent from public root dependencies. Those children now load the built
CLI directly, exercising compiled reporting without a source loader. Local public and
private checks pass after this fix; new-head CI must verify it independently. Adapter
head f4308b5 private run 36956894401 failed only at Codecov `Repository not found`,
and its forwarder-image run 36956894435 passed. Codecov activation/access remains
unresolved and the upload gate stays enforced.

Production Node/container packaging, immutable asset installation policy, durable
instance activation and CLI/service apply orchestration remain required. Existing
standalone/managed deployment entrypoints are unchanged until artifact/apply wiring
is integrated. Complete hosted local/workerd, remote and browser journeys/cleanup,
final backend/public 95/90 and UI 90/85 coverage, provider/telemetry hardening,
dependency upgrades, npm publication, migrations 0018–0025 and staged production
rollout remain outstanding. The complete shipping goal remains active.


### Compatible packaged runtime images (implemented)

The shared core Dockerfile renderer now optionally adds the dependency-bundled CLI
runtime, a digest-pinned Node 22 binary and its required C++ runtime library. The
trusted build adapter supplies `runtimeImageFiles`; deployment-specific descriptors,
keys and credentials stay outside image layers. The private kitchen-sink generator
stages those files from the built CLI package, so image CI uses the same executable
and renderer as standalone library consumers.

The image entrypoint detects `/etc/vector/logtura-runtime.json`. Absence preserves
direct Vector startup, including existing managed Fly config arguments. Presence
runs the supervisor and requires the fixed bound config; malformed files and dangling
symlinks never downgrade to direct Vector. Persistent `/var/lib/logtura` checkpoint
storage and a shutdown grace period of at least 35 seconds remain deployment
requirements. Artifact installation, activation and service/CLI apply orchestration
are still outstanding, so existing deployments are not newly reported as applied.

Building and launching the default standalone image uncovered an existing duplicated
executable: its inherited Vector ENTRYPOINT plus `CMD ["vector", ...]` invoked
`vector vector ...`. Default CMD now supplies arguments only. Standalone default
images remain Node-free; the real Docker fixture builds and launches that default
image without overriding its command, and checks normalization, filters, context,
503 retry and event delivery. The supervised fixture now builds its own packaged
image, checks Node/Vector versions, starts the image's default entrypoint as PID 1,
recovers accepted acknowledgement loss with counters 1, 1, 2, delivers a real event
and exits 0 on graceful stop. Neither a host Node mount nor a hosted Logtura service
supplies its runtime. Additional actual-container cases verify malformed descriptors,
dangling links, directories, named pipes and conflicting arguments fail without
private contents in diagnostics. Artifact opens are nonblocking before the regular-file
check, preventing named pipes from hanging validation.

Private validation passes 789 tests in 78 files with coverage
77.09/73.44/80.31/74.28 (statements/branches/functions/lines). Public validation passes 538 tests in 46 files with coverage
83.85/81.08/82.93/81.85. The new core image helpers have an enforced 100% coverage
gate; existing global floors are preserved. Private
builds, types, package-consumer checks and the image generator are also exercised.
The previous supervision heads 6d7712d (private run 36961489153) and 2929df1 (public
run 36961485345) passed every build, packed, type, delivery and test step in clean CI;
both failed only the Codecov upload. Private image publication run 36961489181 passed.
The earlier clean-public missing-tsx crash-test defect is therefore verified fixed.
Codecov activation/access remains unresolved and its gate remains enforced.

Durable activation/apply, persistent-volume installation, managed orchestration,
complete local/workerd/remote/browser journeys, high final coverage floors,
provider/telemetry hardening, dependency updates, npm publication, migrations 0018–0025
and staged production rollout remain required. The full shipping goal remains active.


### Durable linked activation and recovery (implemented)

The public CLI library now persists `.logtura-activation.json` before requesting an
instance from the shared service SDK. It binds the request to the linked account,
origin, configuration version, desired sequence/revision and prior active instance.
The local manifest, link and referenced private fingerprints must remain unchanged;
checks repeat across asynchronous server calls. Metadata is private mode 0600 and
contains no resolved payloads or account/reporting tokens. Regular-file, no-follow,
nonblocking opens and size/schema validation reject unsafe journals. Private POSIX
mode bits are checked; Windows storage relies on its filesystem ACL, since Node
does not implement the group/owner/other mode distinction there. Nonregular paths
are checked before opening as well as through the descriptor, including on Windows.
See [Node 22 filesystem documentation](https://nodejs.org/docs/latest-v22.x/api/fs.html#fschmodpath-mode-callback).

Activation and push share their serialized directory lock and cannot own one config
simultaneously. Config writes, pull and push are fenced while an activation is pending.
Read-only inspection and account login remain available. Offline CLI `config status`
now exposes locally recorded pending/issued/rejected phase and instance/request IDs,
without network calls or private payloads; an issued receipt is not an application
claim. Intent and receipt writes
flush the file before atomic publication and the parent directory before proceeding.
Lost acknowledgements recover immutable receipts and reuse the original request ID;
retired instances and advanced desired revisions cannot be returned for new apply.

Completion requires an accepted runtime report from the same current instance/revision;
old applied history and stale or zero-counter reports cannot clear intent. Explicit
recovery can cancel definitively rejected unissued requests only after receipt lookup,
or abandon remotely obsolete instances and verified owned-deployment deletions. These
local recovery operations do not stop runtimes, claim application or alter server
activation. Unknown outcomes and still-current issued instances retain their journal.

Seventeen focused scenarios cover baseline/private edits before and during transport,
wrong account/origin, missing state/link, lost and uncommitted responses, conflicting
and corrupt receipts, server replacement/deletion, old history, rejection recovery,
competing writers, filesystem failures and private permissions/types. Four actual
compiled child processes are killed after each intent/receipt file/parent fsync; a
real HTTP fixture survives the writer, and recovery issues exactly one server instance.
This fixture exercises the SDK and filesystem, not a real D1 server; complete hosted
workerd/browser/apply journeys remain required. The Windows directory-flush branch is
simulated; this is not a native Windows validation claim.

A strict NodeNext consumer exposed an older declaration-packaging defect:
compiler output retained extensionless relative imports and failed with TS2834.
The canonical build now rewrites generated declaration module nodes to resolved
`.js` paths, preserving comments and unrelated string literals. Installed tarballs
are typechecked in strict NodeNext, Node16 and Bundler modes without `skipLibCheck`, across
all 15 package roots. Negative type assertions ensure input/journal types do not
silently degrade to `any`. All three strict consumer modes pass.

The packed consumer now imports the published-shape library APIs, performs linked
activation with committed-response loss, compiles the recovered issued manifest,
exercises the filesystem reporting adapter, then verifies acknowledgement-gated
completion. This validates package exports and recovery without substituting a
handwritten observation for the separate real owned-process image fixture.

Private validation passes 806 tests in 79 files with coverage
77.58/74.05/80.65/74.77. Public validation passes 555 tests in 47 files with coverage
84.50/81.85/83.44/82.52. Private floors rise to 77.5/73.9/80.5/74.5, and public
floors rise to 84/81/83/82. New activation logic and existing configuration transaction
logic both enforce 100% statements/branches/functions/lines. Builds/types and all 15
packed-package checks pass. The preceding packaged-runtime heads a11d462 (private
run 36963406156) and 86b23c4 (public run 36963408491) pass all code/coverage/delivery
steps in clean CI; both fail only Codecov with `Repository not found`. Image
publication run 36963406159 succeeds. Codecov access remains unresolved and enforced.

This is durable issuance/completion support for the apply adapter, not a newly wired
CLI deploy command or managed apply workflow. Pinned artifact installation, persistent
volumes, exact image/version apply and rollback, complete local/workerd/remote/browser
journeys, high final coverage floors, provider/telemetry hardening, dependency updates,
npm publication, migrations 0018–0025 and staged production rollout remain required.
The complete shipping goal remains active.


### Durable linked Fly runtime apply (implemented)

Linked `deploy fly` now uses the public core Machines HTTP transport, runtime planner
and guarded update operation, through a public CLI filesystem adapter. Unlinked
standalone deployment retains flyctl and has no hosted-service login dependency.
A linked desired revision must first be pushed; referenced private changes require
explicit secret upload. Initial apply requires an explicit immutable image reference
and an existing encrypted Fly checkpoint volume. It targets exactly one existing
self-managed forwarder machine and never creates a replacement app. Volume provisioning,
fleet rollout and managed-service apply are not implemented by this slice.

Read-only preflight checks ownership/origin, target options, provider app/org/machine,
volume availability/mount conflicts, complete generated private environment,
reporting identity and descriptor size before issuance. Apply installs the issued
YAML, descriptor and exact driver assets through private machine files with their
modes; private descriptors and payloads stay outside image layers. Persistent
`/var/lib/logtura` storage preserves counters across restarts, and supervised startup
allows 35 seconds for graceful stop. Unrelated machine settings are preserved;
preload/loader and conflicting Vector launch overrides are rejected or removed.

The mode-0600 `.logtura-apply.json` journal captures the linked baseline, exact
installation descriptor/request, complete prior machine configuration and actual
immutable rollback image before any Fly write. File/parent fsync precede dispatch.
Lease and current-version checks fence competing provider changes. An uncertain
update resumes by recognizing every planned installed field rather than issuing
another instance or blindly repeating a machine update. The adapter checks current
server issuance and local/private baselines across asynchronous operations, then
requires a started planned machine/image and the server's accepted current runtime
report before completion. Timeouts, cancellation, superseded instances, malformed
state and failed filesystem operations retain recovery material.

Completion publishes `.logtura-applied-<instance>.json` without overwriting another
record, flushes its directory and only then removes pending apply intent. The record
contains resolved private rollback material; both repository layouts ignore these
records plus activation/apply journals and locks. A prior machine restoration alone
cannot revert desired state or reactivate an old server instance. A converged rollback
requires a new desired revision and issued apply; automatic rollback orchestration
remains outstanding. Explicit `--cancel-rejected` checks for an unissued rejected
activation. `--abandon` archives only an owned apply proved obsolete or associated
with a verified deleted deployment, preserving any uncertain provider outcome and
without stopping machines/changing activation. Offline status shows apply identities
without resolved payloads. Resume handles a crash after activation cleanup as well
as after archive publication.

Four actual compiled CLI children are killed at intent-file, intent-parent,
activation-cleared and archive-parent fsync boundaries. A real local HTTP fixture
retains remote state; recovery issues one server instance and updates one machine,
reusing the exact descriptor where installation intent was published. These are
HTTP provider/service fixtures with controlled accepted observations, not real Fly
or workerd runtime deployment claims. Separate actual Docker/Vector checks pass
packaged image startup, event delivery/filter/context/retry, report acknowledgement
loss recovery and graceful PID-1 supervision. Full installed CLI → workerd → real
runtime → browser and owned remote Fly journeys remain required.

Private validation passes 837 tests in 83 files; public validation passes 586 tests
in 51 files. Private coverage is 78.56/75.37/81.31/75.56 and public coverage is
85.61/83.19/84.39/83.59 (statements/branches/functions/lines). Floors rise to
78.5/75.3/81.3/75.5 privately and 85.5/83/84/83.5 publicly. New core transport and
runtime planning both enforce 100% in every coverage dimension. CLI apply enforces
95% statements, 90% branches and 100% functions/lines (measured
96.02/91.51/100/100). Existing activation, transaction and link 100% gates remain.
Both layouts pass builds/types and all 15 isolated packed-package checks, including
linked apply recovery and strict installed declarations. The private service builds,
and all 27 UI tests pass. Overall final coverage targets remain unfulfilled.

Prior activation heads bc358e2 (private CI run 36968700330) and 5650bab (public
CI run 36968697805) passed all code/type/packed/image-flow/test gates and failed only
Codecov with `Repository not found`; image publication run 36968700334 succeeded.
Codecov activation/access remains unresolved and its upload gate remains enforced.
New-head CI must independently verify this slice.

Managed apply integration, external provisioning/lease/disclosure decisions, automatic
rollback, complete local/workerd/remote/browser journeys, final high coverage floors,
D1/telemetry hardening, dependency/workflow upgrades, coordinated npm versions and
publication, migrations 0018–0025 and staged production rollout remain outstanding.
The existing production forwarder is unchanged and the full shipping goal stays active.


### Shared metrics interpretation and stable checkpoints (implemented)

Vector metrics parsing, snapshot transitions and rate calculations now live in the
public core package. The service retains its import facade and the website consumes
the public rate function and snapshot types. Standalone `logt stats` and `logtura
stats` use the same interpreter without login, accepting a positional file or
`--metrics`, JSON batches, pretty single events and NDJSON. CLI parse failures do
not include private payloads, and table cells escape control characters.

Independent counter timestamps preserve rate baselines across interleaved samples.
Duplicate and older samples cannot overwrite current counters or metadata. Error
series are summed with per-label timestamps and bounded new label cardinality;
partial counter resets no longer subtract the prior value twice. Process restarts
carry lifetime offsets. Prototype-like component identities remain ordinary data,
and invalid numeric values are rejected. Legacy stored snapshots remain readable.

Derived boot time stays stable within the existing 30-second restart tolerance.
Previously small uptime timing jitter changed this identity and could repeatedly
trigger the service's urgent D1 checkpoint path. A real HTTP/workerd/D1 test proves
that jitter coalesces without another write while a genuine restart persists the
new identity and lifetime offset. This is a concrete reduction of one unnecessary
write path; cross-isolate checkpoint coordination, cron query hardening and actual
production load verification remain outstanding.

Private backend validation passes 851 tests in 85 files, with coverage
79.75/77.46/81.88/76.59. Public validation passes 599 tests in 53 files, with coverage
87.09/85.29/85.41/85.28. Floors rise to 79.5/77.2/81.8/76.5 privately and
87/85/85/85 publicly. Shared metrics coverage is 100/99.19/100/100; CLI metrics is
100% in every dimension. All 15 isolated packed packages, installed CLI stats,
strict consumer declarations, service builds/types and 27 UI tests pass.

Preceding linked Fly apply heads b886d55 and 1a3514d passed every code, type,
package, runtime-flow and coverage artifact check in private CI run 36973605752 and
public run 36973613647. Both failed only the enforced Codecov upload with
`Repository not found`; image publication run 36973605864 succeeded. Codecov
repository access remains unresolved. New-head CI must independently verify this
metrics slice. No npm release, production migration or deployment is claimed here;
the full implementation, E2E, coverage and staged shipping goal remains active.


### Reliable standalone secret entry (implemented)

The terminal adapter now decodes UTF-8 across chunks and processes individual code
points. A pasted token plus Enter in one chunk submits correctly; backspace removes
one code point instead of an entire chunk. Navigation and bracketed-paste control
sequences are ignored, including split sequences. Input is never echoed. Ctrl-C,
Ctrl-D, closed input and stream errors reject with generic errors while restoring
raw mode and removing listeners. Initially idle stdin is paused after completion so
it cannot hold the process open; an already flowing/raw terminal retains its state.
Setup and restoration failures reject without disclosing device or input details.

Twelve stream tests exercise these behaviors, including every byte of multi-byte
input arriving separately. They validate the actual Node terminal adapter using
streams, not a native PTY or provider login journey. Non-terminal readline prompts,
full connector journeys and installed interactive PTY coverage remain outstanding.
Both layouts pass all 15 isolated packed consumers, builds and private types.
The full private suite passes 863 tests in 86 files (coverage
80.12/77.67/82.15/77.12); the public suite passes 611 tests in 54 files
(87.68/85.59/85.83/86.16). Existing raised floors remain enforced.

Metrics heads 112e643 (private run 36976846421) and 9ff7d37 (public run
36976851066) passed all code/package/type/runtime-flow/coverage artifact checks.
Both failed only Codecov upload with `Repository not found`; image publication
36976846236 succeeded. No coverage gate has been disabled. New-head checks must
verify the terminal slice independently. Production and npm remain unchanged, and
all remaining outcome and release gates still apply.


### Installed CLI → real workerd → packaged runtime journey (implemented)

`pnpm test:e2e:local` now packs and installs all 15 public packages in a private
consumer, bundles the real service into a local workerd server with fresh D1 and
queues, applies every migration and seeds only a disposable identity/session.
Connection/deployment creation and queued discovery use actual HTTP/service jobs.
The installed CLI performs device login with browser-session HTTP approval, pull,
connection-label edit and push. The website API then exposes the same new desired
revision. The initial deployment is legitimately legacy with no desired state;
the first push establishes it, rather than pre-seeding an artificial current state.

A strict Machines API fixture installs the actual planned private files into a
Docker image containing the runtime executable from the installed CLI tarball.
Its PID-1 supervisor owns real Vector. The service receives actual applied reports,
heartbeat and nonempty component metrics through HTTP and stores them in D1.
Assertions require matching desired/applied revision and sequence, current state,
completed local apply, a private rollback archive and exactly one provider update.
The fixture checks the running container's actual Docker image ID. Restarting the
same container with its named checkpoint volume must advance the service report
counter; graceful stop must exit zero. No handcrafted accepted observation or
simulated service state completes this journey.

The local fixture now serves actual hash-verified OCI index/platform bytes and
requires the installed CLI to resolve the platform before the Fly write (see the
linked CLI platform-identity slice below). The running Docker configuration ID
is verified separately. Its Fly API remains a controlled provider boundary,
not actual Fly infrastructure. The topology
has an explicitly empty provider-source selection and real heartbeat/metrics.
This proves connection-label synchronization and installed runtime convergence;
source/site update delivery, complete provider event flows, browser rendering,
owned remote journeys and real Fly image/volume/lease behavior remain required.

Ownership cleanup deletes and verifies the created deployment, connection and
default monitor through HTTP; kills outstanding children; removes the unique
container, persistent checkpoint volume and image tag; disposes workerd; and
removes private temporary files. Cleanup errors fail the run. Explicit failures
after resource creation and after runtime installation/reporting pass only when
the intended boundary was reached and cleanup succeeds. `after-push` is also
available for diagnosis. This is handled failure teardown, not a persistent
ledger for a SIGKILL of the E2E coordinator.

The happy path and both required injected-failure cases pass locally, including
actual metrics shape and restart counter assertions. New Node-specific E2E types
and existing service types pass. Miniflare 4.20260507.1 and Node types 22.19.19 are
explicit dev dependencies using versions already present in the lockfile. The
private push/PR workflow requires all three scenarios after actual Vector flow;
Linux Docker host networking and registry access are prerequisites, with missing
capabilities failing rather than silently skipping. Documentation lives in
`test/e2e/README.md`. Product coverage floors remain enforced and unchanged.

Preceding terminal heads 327e19a and b27080d passed every code, package, type,
real Vector flow and coverage artifact step in private CI 36977614021 and public
CI 36977610771. Both failed only the Codecov upload (`Repository not found`);
image publication 36977613898 succeeded. New-head CI must verify this real-service
journey on a clean runner. This private test infrastructure adds no unpublished
public API and changes no production forwarder, npm release or production schema.
The full convergence, high-coverage and staged shipping goal remains active.


### Real website ↔ installed CLI convergence (implemented)

The local journey now launches pinned Playwright 1.63.0 Chromium and serves the
actual built React app through Miniflare's native Workers Assets plugin. Anonymous
CLI-access guidance and the GitHub sign-in link render. The authenticated browser
approves an installed CLI device login through the real UI, and denies a second
login without replacing the previously saved private account credential.

After CLI pull/edit/push, the connection detail heading shows the updated label.
Actual sign-out returns HTTP 303 and clears the session cookie. A fresh authenticated
browser context, followed by reload, still sees the CLI change. Session establishment
is seeded for the disposable identity; this does not claim live GitHub OAuth.
The browser then enables metrics using Configure/Save. The revision card becomes
`Configuration changed`, and the chosen target/tab survive reload. CLI pull/push
captures that website edit and establishes a new desired sequence before apply.
This tests both directions using the real service, rather than a mocked web API.

After the actual packaged Docker supervisor/Vector reports loaded configuration,
the browser renders `In sync` with matching desired/applied sequence/hash across
reload. Revoking the CLI client through the website survives reload and the saved
CLI token receives `invalid_account_token` (HTTP 401). The independent forwarder
credential remains usable: after container restart, a fresh runtime log entry must
record an accepted higher report sequence, and D1 state must preserve the active
instance/revision. The counter baseline is read immediately before restart, and
logs are scoped to the restarted process start time to avoid treating a pre-restart
periodic report as recovery. Unhandled JavaScript errors through browser shutdown
fail the journey.

The full browser/runtime happy path and the injected failures after creation and
after runtime reporting pass locally, including ownership cleanup. Node E2E and
service types, the actual React build and all 27 existing UI tests/coverage gates
pass. Unit UI coverage remains 19.70/16.58/16.15/17.91; browser success is not counted
as instrumented coverage, and the final UI coverage target is still outstanding.
Private CI installs pinned Chromium/system dependencies and runs all three cases.
Its OS is pinned to the verified existing Ubuntu 24.04 baseline rather than allowing
an implicit OS change to alter browser prerequisites. Public package code is
unchanged and remains pushed on public main.

Preceding private head ae2550c passes the installed CLI/workerd/runtime happy and
failure cases plus all code/package/type/real Vector/unit/UI/coverage artifact gates
in clean CI run 36980574817; only Codecov fails with `Repository not found`.
New-head browser CI still requires independent verification. This scenario retains
an explicitly empty provider-source selection. Real provider event delivery,
source/site-update journeys, complete browser/provider matrices, remote cleanup
ledgers, managed apply, registry/platform digest checks, high final coverage,
Codecov access, coordinated npm release and staged production rollout remain
required. No production resources, schema or forwarder were changed by this slice.

### Website configuration editor baseline and typing fixes

Private head d8947d6's real browser/installed CLI/workerd/runtime journey and both
cleanup injections pass clean CI run 36984898906. Its sole failing step is the
Codecov upload. Authenticated GitHub organization installation inventories show
no Codecov app in either organization. Repository-scoped installation pages are
prepared for q32llc/logtura and logtura/logtura; granting private-code access awaits
explicit browser-policy approval. Upload failures remain enforced, not bypassed.

The next editor slice adds 17 UI interaction tests, bringing the UI suite to 44.
The source/monitor selector exercises wildcard-to-explicit changes, stable IDs,
persisted customization state, initial expansion and empty-state navigation.
Every filter kind is added with its documented defaults, reopened, edited or
cancelled. Tests cover ordering boundaries, removal, legacy omitted options,
regex modes/fields, numeric settings and comma-separated dedup/rollup fields.
They exposed two product bugs: normalizing field arrays consumed trailing commas
while typing, and replacing empty numeric input with a default changed a typed
sample fraction (0.25 became 0.251). Controls now retain editing text while keeping
parsed filter values for commit; saved values and discarded drafts remain isolated.
Filter chips and removal controls are separate keyboard-accessible buttons, and
individual selection switches have site/monitor labels.

UI coverage is now statements/branches/functions/lines 25.45/23.91/23.92/24.15.
The aggregate CI floors rise to 25/23.5/23.5/24 without excluding untested pages.
SelectionEditor is enforced at 100% in all measures; FilterStepsEditor is enforced
at 98/95/100/100 (measured 98.83/96.90/100/100). These are incremental ratchets;
final UI 90/90/90/85 remains required. The existing full-goal release/provider/
managed-apply/production outstanding work remains unchanged.
Service typechecking, the Vite build, all 44 UI tests with the raised coverage gates,
and the full installed CLI/browser/workerd/Docker convergence journey pass locally
with these editor changes. The E2E journey also verifies graceful runtime shutdown
and disposable-resource cleanup. Clean pushed-head CI remains a separate gate.

### Provider connection website baseline and credential isolation

Private head 8a95537 passes code, packaging, types, the three real local browser/
CLI/runtime cases, unit/UI coverage and artifact gates in clean CI run
36987084772. The sole failed step remains the enforced Codecov upload; scoped
GitHub App installation is still awaiting permission approval.

The next slice covers NewConnection, shared provider connection controls/credential
fields and the account connection dashboard. The UI suite has 70 tests across ten
files. Cases include disabled loading/empty-catalog state, direct and guided token
entry, manual instructions, provider selection, optional identity lookup failures,
verification retries, compatible scoped bootstrap minting and retries, normalized
Vercel/Railway installation returns, OAuth connection-name/installation encoding,
error display, discovery-time summaries and connection navigation. Provider tests
use synthetic credentials and mocked APIs; they do not authorize live third-party
accounts or claim provider integration coverage.

The tests revealed and fix two product defects: changing source providers retained
the previous provider's token and authorization/manual state, and credential field
state updaters read React event.currentTarget after dispatch, which can throw when
the updater runs later. Provider changes now clear credential/authorization/manual/
error state; credential changes capture the input value before scheduling state.

The real Chromium/workerd E2E now creates its source connection through the actual
website form instead of direct HTTP setup. It types a fixture token, verifies and
navigates to the new connection before the existing installed CLI/Docker revision
journey. The outbound Cloudflare fixture requires the exact expected Bearer token.
This validates the real form, handler and shared provider verification path while
retaining the explicit empty source selection and all existing provider/runtime
limitations. The returned connection ID is captured before page-navigation
assertions so later browser errors retain ownership for cleanup.

UI statements/branches/functions/lines measure 33.68/34.06/31.42/32.63. Aggregate CI
floors rise to 33.5/34/31/32.5, with no new coverage exclusions. ConnectSection and
Dashboard each enforce 100% in all measures. NewConnection enforces 95/94/100/97
(measured 95.23/94.89/100/97.84). Final aggregate UI coverage, broader provider and
source/site journeys, remote cleanup ledgers, managed apply, release and production
rollout remain required; these incremental baselines do not complete those phases.
Service/E2E types, the actual Vite/package build, all 70 UI tests with the raised
coverage gates and the complete real website/installed CLI/workerd/Docker happy
path pass locally. Both after-create and after-runtime cleanup injections pass.
The final happy-path run also passes the stricter exact provider token check.
Clean pushed-head CI remains a separate verification gate. Public package source
and production resources/schema are unchanged by this private website/test slice.

### Monitor and sink website configuration baseline

The monitor page now has 23 interaction tests covering global/scoped creation,
trimmed names, cancellation/reset, creation retries, enabled-state changes,
independent monitor/per-sink pipeline saves, multi-monitor/sink isolation, routing
and missing-resource labels, destination choice, sink cancellation/creation retries,
confirmed monitor deletion, sink removal and failure preservation. Tests use the
actual shared filter editor and page with mocked APIs/notifications; they do not
claim delivery to real destinations. Monitor cards expose named regions to make
each configuration independently accessible.

The real browser journey creates a connection-scoped `Website alert` monitor with
errors followed by 120-second dedup. It types `script, message` character by
character rather than setting the field in one event, then reloads and reopens the
saved filter to verify both fields. The installed CLI subsequently pulls/pushes
that website edit; assertions require the exact monitor ID, connection scope and
both filter configurations in the service's desired portable document. The existing
actual runtime must still converge to that complete desired revision. Teardown
removes owned monitors before their connections so scoped-resource cascades cannot
turn successful cleanup into misleading deletion errors.

All 93 UI tests pass. Aggregate statements/branches/functions/lines measure
41.51/38.84/39.38/41.24; CI floors rise to 41/38.5/39/41 with all UI files still
included. Monitors measures 99.17/95.71/100/100 and enforces 99/95/100/100. Service
and E2E typechecking and the actual Vite/package build pass. This is an incremental
baseline, not the final UI coverage target. It retains empty source selection;
real provider event delivery, complete website/provider matrices, remote persistent
cleanup ledgers, managed apply, package publication and production rollout remain
required. Public package code and production resources are unchanged.
The complete real browser/installed CLI/workerd/Docker journey passes with the new
monitor, including runtime revision convergence, restart reporting and graceful
shutdown. Both after-create and after-runtime injections pass with verified owned
resource cleanup. Pushed-head CI remains a separate gate.

### Destination website baseline and portable routing synchronization

The destination page gains 17 interaction tests, bringing the UI suite to 110.
Cases cover keyboard selection, typed public/private fields, declared optional
values, cancelled drafts and driver isolation, failed creation retries, OAuth start
links/return notices/dismissal, catalog failures, unknown destination kinds,
confirmed deletion and deletion failure preservation. Destination choices are
actual buttons and existing destinations expose named regions. These tests use
mocked APIs/notifications and synthetic values; they do not grant real OAuth access
or claim external delivery.

The real browser creates an HTTPS webhook destination and attaches it to the
website-created connection-scoped monitor. Both destination and sink survive
reload. Installed CLI pull/push must retain their exact IDs, destination kind and
default per-sink dedup filters. The private webhook URL must be absent from public
configuration state and portable YAML, but present in the CLI's companion env file
with mode 0600. The real runtime still needs to converge to the complete desired
revision. Teardown includes owned destinations and verifies no destinations remain;
owned monitor deletion removes sinks before destination/connection cleanup.

All 110 UI tests and raised coverage gates pass. Aggregate statements/branches/
functions/lines measure 45.95/42.19/43.87/46.18; enforced floors rise to
45.5/42/43.5/46. Destinations measures 98.55/97.91/100/100 and enforces
98/97/100/100. No UI pages are excluded to achieve these gains. Service/E2E types,
the Vite/package build and full real browser/CLI/workerd/Docker happy path pass.

The selected provider source set remains empty: this proves portable destination/
sink topology and private-payload handling, not webhook event delivery. Existing
standalone Vector event delivery is separate evidence. Final coverage, complete
provider/source/site/browser cases, remote ledgers, managed apply, coordinated
package release, rollback and staged production rollout remain required. Codecov
permission approval remains pending. Public package source and production resources
are unchanged by this private website/test slice.

### Deployment run controls and polling lifecycle baseline

The actual deployment detail page gains 30 run-control interaction cases, bringing
the UI suite to 194 across 15 files. Coverage includes personal-versus-organization
Fly account selection, duplicate submission prevention, deduplicated job identity,
queued/running job rehydration after remount, progress and terminal failure/retry,
success-driven header refresh, terminal polling shutdown, submission/poll failures,
authorization start/pending/success/cancel/error, late responses after cancellation
or unmount, reconnect without deploy, legacy redeploy links and unavailable target
catalogs. Non-Fly targets retain self-deploy. Signed install-command cases verify
deployment identity, disabled regeneration until expiry, expired-link recovery and
signing failure retries. These interaction tests mock API responses and do not
constitute a live managed Fly deployment or complete deployment-page coverage.

The cases expose and fix overlapping job polls: an effect restart after a progress
update previously left the prior scheduled timeout alive. Authorization cancellation
also left a scheduled request alive. Both effects now retain and clear their timer
and guard requests after cancellation; late in-flight responses remain ignored.
Regression assertions require one poll per interval and no requests after unmount
or authorization cancellation.

Service typechecking, Vite/package build, all 194 UI tests and raised coverage gates
pass locally. Aggregate statements/branches/functions/lines measure
71.27/68.75/65.05/72.58, with enforced floors 71/68.5/65/72.5 and every UI file
included. DeploymentDetail measures 49.71/38.34/44.27/53.69 and adds a partial
baseline floor of 49.5/38/44/53.5; metrics, configuration, bundle and lifecycle
interactions still require broader coverage. The complete real browser/installed
CLI/workerd/Docker journey passes with credential rotation, runtime convergence,
restart reporting, graceful shutdown and ownership cleanup after the polling fix.

Preceding connection-detail head effce9d passes all prior CI gates in terminal run
36993144474; only the enforced Codecov upload fails. Scoped app approval is still
pending. This slice does not change public package source or production resources.
Final aggregate coverage, provider/source/site delivery, managed apply, persistent
remote cleanup ledgers, coordinated releases and staged production rollout remain
required before the overall goal can be complete.
Both after-create and after-runtime failure injections pass with verified cleanup
including destinations. Pushed-head CI remains an independent gate. Preceding
monitor head 346b2a0 reaches the Codecov upload in run 36989208667 after passing
all prior code, package, type, real runtime, unit/UI and coverage artifact steps;
its upload outcome still requires terminal verification.

### Deployment wizard baseline and wildcard deselection correctness

The wizard gains 17 interaction cases for target/keyboard selection, default and
explicit source/monitor policies, individual deselection/reselection, wildcard
restoration, scoped monitor applicability, empty-monitor guidance, trimmed names,
managed-mode gating/reset, creation retries, target/connection lookup failures,
missing route data and invalid preset targets. A deployment Configure regression
case checks the same wildcard-monitor transition on an existing deployment. The
full UI suite now has 128 tests.

The tests exposed a selection bug in both wizard selectors and Configure's monitor
selector: the wildcard state rendered every item checked while its explicit set
was empty. Deselecting one item converted that empty set to an empty explicit
selection, dropping every other item. Transitions now expand the current visible
wildcard catalog before applying the individual change. Explicit selection and
restoring wildcard policy keep their existing behavior. Invalid preset target
links now return to an actionable target picker with an error that clears on a
valid choice. Available targets are keyboard-accessible buttons and future targets
are explicitly disabled; managed apply remains a separate required capability.

The real browser/workerd journey now creates the deployment through the website
wizard, validates its connection/target/self-managed identity and verifies its
navigation/reload before CLI login/pull/push. The existing-machine fixture is then
bound through HTTP and source selection set explicitly empty for this configuration
case. This keeps the existing-forwarder apply proof and provider-event limitation
explicit instead of treating browser creation as external infrastructure delivery.

Service/E2E typechecking, Vite/package build, all 128 UI tests/raised coverage gates
and the real browser/installed CLI/workerd/Docker happy path pass locally. Aggregate
statements/branches/functions/lines measure 52.68/47.98/51.71/53.05; enforced floors
rise to 52.5/47.5/51.5/53 with all UI files included. DeployWizard measures
99/95.18/100/100 and enforces 98/95/100/100. Final aggregate coverage, source/site
and provider delivery, complete browser matrices, remote cleanup ledgers, managed
apply, coordinated publication/rollback and staged production rollout remain
required. Codecov scoped permission approval is pending; public package code and
production resources are unchanged by this private website/test slice.
Both after-create and after-runtime injections pass with website-created deployment
ownership and verified cleanup. Target-selection recovery also has an explicit
regression test retaining a connection-load error when an available target is
chosen. Preceding destination head 9e6e410 passes all prior CI gates in terminal
run 36990142617; only the enforced Codecov upload fails. Pushed-head wizard CI
still requires independent verification.

### Connection discovery, reconnect and project-selection baseline

The connection detail page gains 36 interaction cases, bringing the UI suite to
164. Cases cover source-name/kind filtering, discovered counts and routing/setup
navigation, deployment statuses/heartbeat ages/compact metrics, discovery enqueue
and deduplication, enqueue failures, queued/running rehydration across remount,
terminal polling shutdown, failed/successful job banners, confirmed deletion,
reconnect cancellation/reset/retry and optional OAuth/direct-token entry. Supabase
project cases cover the current selection, picker reopening, empty/error catalogs,
selection on the existing identity and failed-pick preservation. APIs and
notifications are mocked in these unit tests; they do not authorize live providers.

The reconnect tests exposed a product bug: choosing manual token instructions left
the paste field hidden. Manual mode now reveals the token input alongside the
instructions while reopening/cancelling still clears private drafts.

The real browser/workerd scenario queues discovery and reloads while a strict
provider fixture holds its Worker-list request. The reloaded connection resource
must expose the exact same job ID in queued/running state, and the page must render
active discovery controls before the fixture is released. Native queue completion
then restores the discovery action; direct job inspection requires success. The
hold is bounded and always released on failure, so a stalled fixture cannot leave
the runner silently waiting indefinitely.

The browser then reconnects the same connection through manual entry with a
replacement fixture token. The provider fixture retires the old token, requires
the new Bearer credential and records successful verification. The deployment
identity survives and its desired state becomes stale. Subsequent installed CLI
pull/push must capture the replacement private payload and a changed opaque secret
version while keeping the token out of public state. The actual packaged runtime
still needs to converge to that complete revision. This is simulated credential
rotation, not a live provider account change; source selection remains empty.

All 164 UI tests and raised coverage gates pass. Aggregate statements/branches/
functions/lines measure 65.06/61.39/61.41/66.09; enforced floors rise to
65/61/61/66 without excluding UI files. ConnectionDetail measures
87.21/83.77/84.21/88.38 and enforces 87/83/84/88. Service/E2E types, Vite/package
build, complete browser/CLI/workerd/Docker runtime journey and both injected cleanup
boundaries pass locally. The final journey independently passes the exact-ID reload assertion, runtime
restart reporting, graceful shutdown and cleanup; pushed-head CI remains separate.

Preceding wizard head 72407fe passes all prior CI gates in terminal run
36991415175; only the enforced Codecov upload fails. Scoped app permission approval
remains pending. Final coverage, remaining browser/provider/source/site cases,
remote persistent ledgers, managed apply, coordinated release/rollback and staged
production rollout remain required. Public package source and production resources
are unchanged by this private website/test slice.

### Deployment configuration safety and CLI policy preservation

The deployment configuration page gains 27 interaction cases, bringing the UI
suite to 221 across 16 files. Cases exercise initial selections and monitor
applicability, delayed and failed catalogs with retry, legacy anchor expansion,
cross-connection selections, individual/group/bulk source changes, case-insensitive
name/kind filtering, visible-only bulk changes and explicit clearing. They also
cover CLI native-all/discovery modes, unchanged modern section preservation,
explicit mode conversion when sources are edited, connection-scoped monitors for
empty discovery catalogs, absent catalog IDs, existing legacy overrides, save
failures/draft preservation, duplicate saves, saved-state rehydration, trimmed/empty
names, metrics-capable destination filtering and independent heartbeat/metrics
settings. APIs are mocked in these interaction cases.

Configuration catalogs previously failed silently. A failed source lookup could
therefore let the user save an empty explicit list over a legacy wildcard. The
page now loads sources, monitors and destinations together, exposes
request failure through retry controls, and withholds editable configuration until
all catalogs succeed. Saves are guarded while data is unavailable or a mutation
is pending. Legacy null selectors expand only to the anchor connection's current
sources before an explicit save. Source controls gain accessible names.

Modern CLI graphs now seed the picker from graph selections: native all-source
and discovery modes show the current catalog, while explicit IDs are retained
even when absent from that catalog. Unchanged modern source/monitor sections are
omitted from website saves, preserving discovery policy and monitor ordering.
Source edits write an explicit list; monitor edits update their own section.
Unchanged discovery connections with no current sources still contribute their
connection-scoped applicable monitors.

The real installed-CLI/browser/workerd/Docker journey now enables source discovery
through a packaged CLI graph edit. Website metrics changes, subsequent CLI
pull/push and actual runtime convergence must preserve that discovery flag. The
provider fixture returns an empty catalog, so this remains a configuration and
runtime reporting case, not provider event delivery. The happy path passes,
including credential rotation, restart reporting, graceful shutdown and cleanup.
Both after-create and after-runtime cleanup injections pass with verified removal
of all owned service resources and runtime/container assets.

Service/E2E typechecking, Vite/package build, all 221 UI cases and higher gates
pass locally. Aggregate statements/branches/functions/lines measure
75.28/73.36/71.08/75.97 and enforce 75/73/71/75.5. DeploymentDetail measures
61.91/51.95/67.16/63.90 and enforces 61.5/51.5/67/63.5. No UI files are excluded
to obtain these results; metrics/bundle/lifecycle and route-level coverage still
need work toward the final aggregate target.

Preceding polling head 4faa225 passes all prior CI gates in terminal run
36994323622; only enforced Codecov upload fails. Scoped app approval remains
pending. Public package source and production resources are unchanged. Provider
delivery, remaining capabilities and coverage, remote ownership ledgers, managed
apply, coordinated release/rollback and staged production rollout remain required.

### Shared metrics numerical integrity and deployment drilldown baseline

The public core rate helper now rejects invalid current/previous counters and
sample clocks, overflowing intervals and unrepresentable results. Interval-scaled
arithmetic avoids intermediate overflow/underflow for large and subnormal values
while retaining per-counter timestamp fallback, unavailable first observations
and zero-rate reset behavior. Nine additional core cases cover these contracts;
installed tarball checks verify the public export on large, overflowing and invalid
counter observations. Core metrics coverage is 100 statements/functions/lines and
99.23 branches; the existing strict file gates remain enforced.

The actual deployment page gains 17 metrics interactions, bringing the UI suite
to 238 across 17 files. Cases verify user-only rates and totals, child-source
deduplication, internal traffic exclusion, source/sink/transform throughput,
per-counter timing, rate formatting, current-process totals excluding global
restart offsets, first-observation availability, unknown/orphan components,
throughput sorting, source collapse/expand, optional plumbing, empty sections,
process metadata and sorted error-type tooltips. Nonfinite or overflowing displays
render unavailable rather than Infinity/NaN. The Total view explicitly describes
its current-process scope. Metrics sections and tables gain accessible names.

The real browser/runtime scenario inspects metrics delivered by actual packaged
Vector to workerd/D1. It requires zero user-log headline rates for the empty
discovery catalog, visible internal-component rows after opening plumbing, labeled
zero current-process totals, table hiding and unchanged rates after reload. This
tests real metrics presentation; it does not substitute internal traffic for
provider log delivery. The final happy path and after-runtime cleanup injection
pass with runtime restart reporting, graceful shutdown and verified owned-resource
cleanup. Pushed-head CI remains a separate required check.

Service/E2E types and package/Vite builds pass. All 872 backend/workerd cases pass
at aggregate statements/branches/functions/lines 80.13/77.72/82.15/77.13. The public
checkout passes builds/types, 620 cases and coverage gates at
87.69/85.65/85.83/86.18, installed checks for all 15 packages and declarations,
and the existing standalone Vector delivery/runtime fixture. All 238 UI cases pass
at 84.62/86.32/77.10/85.06, enforcing 84.5/86/77/85. DeploymentDetail measures
88.35/85.36/89.55/90.06 and enforces 88/85/89/90. Final aggregate coverage still
requires further route/API, CLI/provider and private service work.

Preceding configuration head 06989cf passes all prior CI gates in terminal run
36995485340; only enforced Codecov upload fails. Scoped app permission approval
remains pending. No existing published package version is overwritten and no
production resource is changed by this source slice. Remaining capabilities,
provider/source/site delivery, managed apply, remote ledgers, coordinated package
publication/rollback and staged production rollout remain required.

### Application routes, public documentation and standalone example baseline

The real application shell and public pages gain 31 interaction cases, bringing
the UI suite to 269 across 19 files. Protected connections, configuration,
destinations, monitors and deployment routes must withhold account content until
authentication resolves and redirect anonymous users through the expected return
message. Tests cover auth failures without private details, account identity and
logout, real navigation/active links, anonymous CLI device return URLs, unknown
routes, public documentation, deployment-badge polling/recovery/unmount and API
error-message fallbacks. Public-page cases cover signed-in/anonymous actions,
known/unknown auth returns, all four documentation routes, unknown-slug recovery,
navigation, real tables/screenshots/captions and supported CLI instructions.

The UI test configuration now uses the same MDX provider and GFM transform as the
production Vite build, so documentation renders actual source rather than mocked
components. These tests expose a shell bug: disabling AppShell when no sidebar
was needed also hid the header on public routes. The shell now collapses only the
sidebar; public pages retain the logo, Docs navigation and sign-in control.

The open-source guide is updated to the current packaged CLI/configuration shape.
It removes the unsupported install-zip command, inaccurate vector-validation claim
and environment-only heartbeat linking instructions. It describes standalone
provider references, private environment files, validated/bundled Docker runtime,
portable graphs/local stats and explicit desired/applied behavior for linked
deployments. Linked Fly requirements point to the current CLI documentation.

The local runner extracts the guide's actual YAML example and runs the installed
CLI's environment check, validation and bundle operations with disposable values
before starting workerd or logging into Logtura. Its generated Worker selection
and mode-0600 environment file are verified. The real anonymous browser checks
the CLI return page and public docs header; anonymous JavaScript errors are now
captured alongside signed-in errors. The full browser/CLI/workerd/Docker journey
passes, including runtime convergence, restart reporting, shutdown and cleanup.
Both after-create and after-runtime cleanup injections pass with verified owned
service/runtime removal, including the additional private documentation bundle.

Service/E2E types, Vite/package builds and all 269 UI tests/raised gates pass.
Aggregate statements/branches/functions/lines measure 89.96/89.67/86.34/90.87 and
enforce 89.5/89.5/86/90.5 without changing the source inclusion rules. App, Home and
Docs each measure and enforce 100 across all four dimensions. The final aggregate
target remains incomplete, especially website API function coverage; private and
public backend/provider coverage and remaining capability matrices also need work.

Preceding metrics heads d93bfa7/private and 303f507/public pass all prior test CI
gates in terminal runs 36996894402 and 36996861004; only enforced Codecov upload
fails. Forwarder image run 36996894403 succeeds. Scoped app permission approval
remains pending. This slice does not change public package source or production
resources. Final coverage, provider/source/site delivery, managed apply, remote
ledgers, coordinated package publication/rollback and staged production rollout
remain required.

### Native website API contracts and final UI aggregate coverage target

The website API suite now exercises real HTTP lifecycles against a disposable
native workerd service, all migrations and fresh D1, with session authentication
and explicit outbound provider fixtures. Seven new cases cover account/catalog
reads, multipart connection create/reconnect/delete, held queued discovery
reattachment and deduplication, encrypted destination/monitor/sink CRUD, existing
deployment identity/configuration/bundle/signing/deletion, unknown device/token
operations and Fly authorization start with signed-cookie polling refusal.
Wrong-provider Supabase/Railway picks are checked against actual backend guards;
these are not successful provider picks, live OAuth grants or managed deployment.
Unexpected provider requests fail the suite. The Fly start fixture is opt-in, so
the existing full browser runner retains its default outbound behavior.

Actual HTTP checks exposed two unused private website helpers for retired
connection-level source-selection and bundle endpoints. They and their unused
private DTOs are removed; active selection and bundle flows use deployment APIs.
No backend endpoint or public package capability is removed. Resource identifiers
are now URL-encoded. The shared reader bounds requests to 20 seconds, rejects
non-JSON successful replies without exposing response contents, preserves timeout
errors during both fetch and body reads, and never automatically retries mutations.
Four additional transport cases verify those behavior changes.

All 280 website tests across 20 files pass. Aggregate coverage measures
93.21 statements / 90.12 branches / 95.36 functions / 94.48 lines, with enforced
floors of 93/90/95/94 and unchanged production source inclusion rules. The website
API file measures and enforces 100 across all four dimensions; prior strict file
gates remain. This completes the plan's aggregate website coverage target of
90/90/90/85. Private service and public package final aggregate targets, provider
delivery and the remaining browser/lifecycle matrix are still required. The native
API suite runs in the normal UI coverage command after building website assets.

Service/E2E types, package/Vite builds and the full browser/installed CLI/native
workerd/actual Docker supervisor journey pass, including desired/applied
convergence, restart reporting, graceful shutdown and owned-resource cleanup.
Both after-create and after-runtime failure injections also pass with verified
owned service/runtime cleanup.

Preceding private head 945fef4 passes all prior test gates in terminal CI run
36998223303; only enforced Codecov upload fails. Scoped app permission approval
remains pending. This slice changes neither public package source nor production
resources. Backend/package coverage, provider/source/site delivery, shared managed
apply, remote ownership ledgers, coordinated package publication/rollback and staged
production rollout remain required; the full goal remains active.

### Railway provider discovery, emitted helper and environment routing baseline

The public Vitest project list omitted the Railway package even though its source
was included in aggregate coverage. Both repositories now run it. The provider
baseline expands from five to 45 cases across four files, covering credential
freshness, project/account/OAuth query paths, scoped headers, project/environment
selection precedence, workspace/personal fallback, missing projects, incomplete
and empty catalogs, deployment metadata and HTTP/GraphQL/JSON/network failures.
Fixtures assert the actual fixed endpoint, request method, headers, GraphQL
operation and variables; unexpected operations fail.

Selecting the same Railway service in production and staging exposed a routing
defect: both filters matched only service ID after environments were merged,
allowing both routes to receive the same event. Filters now match environment and
service identity, with the same environment resolution used by source grouping.
Actual Vector 0.55.0 executes the generated transforms and requires production
and staging isolation, unselected-service/missing-environment rejection and
normalized provider error/warning events. Pipeline cases also cover absent/unsafe
environments, empty explicit selections, metadata aliases, component keys and
quoted names.

Six protocol cases execute the exact emitted helper asset against explicit
WebSocket/token-broker fixtures. They verify subscription parameters and
authentication, ping/pong, selected-service demultiplexing, attribute parsing,
replay deduplication, broker fragment separation, structured error cooldown and
missing-token refusal. These are protocol fixtures; they do not establish live
Railway delivery, live OAuth grants or all reconnect/cache/eviction failure cases.
Executable TypeScript generator/discovery coverage is 100 statements/functions/
lines and 99.21 branches, enforced at 100/99/100/100. Generated JavaScript helper
contents are data in that report; their fixture execution is separate evidence.

The complete private suite passes 912 cases across 89 files at
80.75 statements / 78.79 branches / 83.58 functions / 77.85 lines. Aggregate floors
are raised to 80.5/78.5/83.5/77.5. Independent public layout verification passes
all package types/builds and 665 cases across 58 files, measuring
90.92/88.81/91.93/90.63; public floors are raised to 90.5/88.5/91.5/90.5. All prior
strict file gates remain. Both layouts pass installed consumer/declaration checks
for all 15 packages. The public standalone Vector delivery/runtime journey also
passes normalization, routing, retries, artifact verification, durable report
recovery and owned PID-1 supervision. Final backend/package aggregate 95/90
requirements remain.

Preceding website head 3f1f6dd passes all code, native runtime/browser, cleanup and
UI coverage CI gates in terminal run 37000039760; only enforced Codecov upload
fails. Scoped app permission approval remains pending. No published package
version is overwritten and production resources are unchanged. Further provider
delivery matrices, managed apply, remote ownership ledgers, coordinated package
publication/rollback and staged production rollout remain required.

### Standalone provider setup, stable inventory reconnect and final public coverage target

CLI setup now discovers Railway services, Vercel projects and Supabase functions
with the packaged provider drivers instead of writing empty inventories after
verification. Railway resolves account/project-token selection to its existing
`project:environment` discovery representation and preserves per-service
environments. Its public token-scope helper is exported for this shared path.
Supabase retains runtime function IDs and represents the gateway exactly once.
Vercel uses personal scope by default; an explicit account ID selects a team.
Switching a prior team connection back to personal removes obsolete account
aliases. These changes apply to standalone shorthand setup; portable linked
graphs retain their existing identity/edit/push contracts.

Reconnect reuses the named provider's existing source blocks and a sole-provider
implicit block, preserving source names and other block fields. Failed discovery
prints a warning and preserves existing selections; a successful empty catalog
may clear them. Rejected verification creates no credentials and changes no
configuration. Fly now respects the same replacement confirmation/quiet-force
contract as the other connectors and accepts process credentials without its CLI.
Credential/placeholder writers create mode-0600 files and repair existing file
permissions, including unchanged-value reuse. Replacing a token removes duplicate
assignments so the last effective value cannot remain an older credential.

Thirty-three additional cases cover connector lookup, local/process/explicit/CLI
credential acquisition, prompts, skip/cancel, replacement guards, permission
templates, account choice, independent discovery failures, exact driver HTTP
contracts, Railway account/project/environment scope, Vercel personal/team scope,
Supabase function/gateway metadata, preserved Cloudflare source identity,
verification refusal, failed reconnect discovery and private file contents/modes.
The CLI connector file measures 100 statements/functions/lines and 97.93 branches,
enforcing 100/97/100/100. Local environment writing enforces 98/94/100/100.

Installed consumer validation now invokes both actual CLI aliases from tarballs
outside the workspace through Railway/Vercel/Supabase connect and reconnect,
validation and bundle generation. Explicit outbound provider fixtures reject any
service or unexpected provider call, inherited credentials are removed, no Logtura
account is available, source blocks remain singular and private files are checked.
The tests establish standalone setup/rendering with provider contract fixtures;
they do not establish live provider log delivery or live OAuth grants.

The complete private suite passes 945 cases across 91 files, measuring
83.16 statements / 81.20 branches / 86.54 functions / 80.58 lines; aggregate floors
are raised to 83/81/86.3/80.4. Independent public builds/types and all 698 cases
across 60 files pass, measuring 95.07/92.59/96.82/95.69. Public aggregate floors
are raised to 95/92/96.5/95.5, with unchanged full production source inclusion and
all prior strict file gates. This meets the plan's final public package aggregate
95 statement/line/function and 90 branch target. The final private backend target
still requires further work. Both layouts pass installed checks for all 15 packages.
The rebuilt public standalone Vector flow also passes actual delivery/routing,
retries, issued artifact verification, durable report recovery, packaged image
startup and owned PID-1 supervision. Final higher gates pass in both layouts.

Preceding private/public Railway heads 711a9a4 and dee28c9 pass every code and
runtime gate in terminal CI runs 37001314168 and 37001291816; only enforced Codecov
upload fails. Scoped app permission approval remains pending. No published version
is overwritten and no production resource changes. Further live provider delivery
matrices, shared managed apply, remote ownership ledgers, coordinated publication
and staged production migration/rollout/rollback remain required; the full goal
remains active.

### D1 ingestion checkpoint coordination and native contention baseline

Heartbeat/metrics ingestion is extracted into a private coordinator that uses the
public core metrics parser/merger. Each Worker isolate keeps its existing bounded
auth/snapshot cache and serializes local requests by deployment. D1 metrics writes
compare the exact previously persisted JSON and current heartbeat credential. A
losing isolate reloads the authoritative row, reapplies accepted buffered samples
and the current batch, and retries at most three times. Newer counters/process
epochs are preserved by the public merger's timestamp checks. After another
isolate wins, its checkpoint/liveness baseline is refreshed so ordinary requests
do not keep issuing conditional D1 updates.

Metric checkpoints make pending/crashed deployments running directly. Heartbeat
and checkpoint timestamps never move stored liveness/config-update clocks
backwards; explicit stopped status is preserved. All counter lifetime resets are
material checkpoints, alongside process/version/topology changes and error/drop
increases. D1 failures remain retryable and do not forget urgent buffered
observations; exhausted contention preserves the final rebased state for retry.
Cache expiry preserves accepted pending observations when the credential still
matches. Invalid clients cannot evict that valid buffer, and credential changes
during checkpoint recovery refuse the write. Authentication occurs before body
parsing. Auth-cache revocation retains the existing bounded TTL contract; this
slice does not claim instantaneous revocation of warm coalesced telemetry.

Pending observations are keyed by recognized metric/accepted component/error
identity and bounded by the core's 256-component/32-error-label snapshot caps.
Malformed or incomplete persisted snapshots and invalid numeric/root/cardinality
data are repaired by a fresh checkpoint. Metrics remains a coalesced bounded
snapshot, not a durable sample stream or exact cross-isolate historical ledger.
No schema migration, provider contract or public package source changes are needed.

Twenty-seven new native workerd/D1 cases create independent coordinator caches,
race real SQL writes and verify warm request query counts, stale counter/epoch
rejection, buffered-counter rebasing, losing-checkpoint query suppression,
metrics-only recovery, concurrent local requests, D1 failure/lock release, all
counter-reset policy, cache expiry/pruning/eviction, token rotation/deletion,
invalid-client isolation, monotonic clocks, malformed persisted state, supported
observation buffering and bounded contention/retry continuity. The coordinator
measures 99.37 statements / 97.02 branches / 100 functions / 100 lines, enforcing
99/95/100/100. All 972 backend/package cases across 92 files pass at
83.76/81.97/86.78/81.15; private aggregate floors rise to 83.5/81.8/86.5/81.
All 280 website/native API cases pass with established 93/90/95/94 aggregate gates.
Service/E2E types and package/Vite builds pass.

The full browser/installed CLI/native workerd/actual Docker supervisor journey
passes with runtime reporting, desired/applied convergence, metrics presentation,
restart reporting, shutdown and owned-resource cleanup. After-create and
after-runtime injected failure runs both verify cleanup of all owned resources.
These checks establish checkpoint ordering and query coalescing. They do not
prove the root cause of the original isolated production D1 queue-timeout event
or complete cron query/alert coordination and production performance validation.

Preceding private/public setup heads e37acb6 and c1d9bf2 pass all code, coverage
and runtime gates in terminal test runs 37003391943 and 37003404113; only enforced
Codecov upload fails. Private image run 37003391982 succeeds. Scoped app permission
approval remains pending. Production resources and public package source are
unchanged by this private service slice. The private backend final coverage target,
live provider delivery, shared managed apply, remote ownership ledgers and
coordinated package publication/production migration/rollout/rollback remain
required; the full goal stays active.

### Indexed silence detection and durable notification delivery

The original exception's cron path no longer loads full deployment payloads or
performs a separate owner lookup for every stale deployment. Migration 0026 adds
a partial heartbeat index and a private notification outbox. Each tick captures
at most 100 oldest eligible running deployments with their owner email. One D1
batch inserts/upserts the heartbeat episode and marks its deployment crashed,
stamping the alert cooldown without changing desired configuration versions.
Overlapping ticks cannot independently capture/send the same episode. A native
`EXPLAIN QUERY PLAN` assertion verifies the partial index is used; a failing SQL
trigger verifies both notification creation and status change roll back together.
[Cloudflare documents D1 batch rollback guarantees](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Delivery attempts at most ten notices per tick, acquires each row with an atomic
60-second lease, and acknowledges only that lease token. Failed transport and
non-success responses retain a durable retry, with exponential delay capped at
one hour. An abandoned lease becomes eligible again. Before sending, the worker
checks the current heartbeat/status and cancels warnings for recovered, stopped
or removed deployments; it never marks a deployment crashed after sending email.
Thus a heartbeat arriving during transport remains authoritative. An email
already in flight can still arrive after recovery. Delivery is at least once:
Postmark acceptance followed by a lost D1 acknowledgement can result in a duplicate.
No exactly-once transport guarantee is claimed.

Absent email configuration leaves delivery pending; an owner without an email
address is completed without transport. Only completed records older than seven
days are pruned, in batches of at most 100; failed pending notices remain durable.
Deployment/account deletion cascades private outbox data. The existing one-hour
alert cooldown and ten-minute silence threshold remain, including exact boundary
behavior. Resuming an identical heartbeat manually re-marks its stale deployment
without duplicating an already completed notification. New heartbeat epochs can
create fresh episodes after the cooldown.

The Postmark helper now returns acceptance/failure, bounds requests to 20 seconds,
uses manual redirects without forwarding credentials, and cancels response bodies.
Failure logs contain status/deployment identity rather than provider response
bodies, tokens, recipient emails or exception contents. Native workerd rejected
`redirect: "error"`; the direct request regression verifies the supported manual
redirect mode and redirect refusal.

Twenty-five new native D1/workerd cases cover eligibility/boundaries, real capture
and delivery races, query planning, durable retries, abandoned/replaced leases,
heartbeat/stop cancellation, heartbeat during email, missing email/configuration,
private deletion, bounded capture/drain, pruning, rollback and Postmark request
contracts. A separate schema-25 migration case compares all existing user,
connection, deployment and configuration-version rows unchanged after migration
0026, with an empty outbox and the new index. Email helper coverage is 100% in all
four measures; the alerter is 100 statements/functions/lines and 91.30 branches.
New enforced file floors are 100/100/100/100 and 100/90/100/100 respectively.
Private aggregate floors rise to 84/82/87/81.5, retaining every prior strict gate.
The final raised-gate run passes all 998 cases across 94 files at
84.18 statements / 82.20 branches / 87.21 functions / 81.69 lines.

Service/E2E types and package/Vite builds pass. All 280 website/native API tests
pass at 93.21/90.12/95.36/94.48, retaining 93/90/95/94 gates. The rebuilt full
browser/installed CLI/native workerd/Docker journey passes with a fresh schema-26
D1, configuration synchronization, applied reporting, current metrics, restart,
graceful shutdown and owned-resource cleanup. Public package source and npm
versions are unchanged by this private slice.
The preceding ingestion head fb4c6fb completes every code/runtime/coverage step
in private CI run 37006179628; only the enforced Codecov upload fails. Scoped app
permission approval remains pending.

Migration 0026 is not applied to production; migrations 0018–0026 and the new
worker must be staged and verified together before rollout. Worker rollback must
retain this additive table/index and account for pending notices; an older worker
will not drain the outbox, so pause the cron and reconcile pending delivery before
reverting its notification implementation. The original isolated production queue
timeout is still not proven to be sustained D1 capacity exhaustion. Production
query/load verification, remaining provider/managed-apply capabilities, the final
private coverage target and coordinated publication/rollout/rollback remain part
of the active full shipping goal.

### Managed Fly queue baseline and shared generated file installation

The existing managed deployment chain now has a native D1/workerd baseline that
runs persisted parent and child jobs through the production queue dispatcher.
Tests use Cloudflare's native inbound message batches and verify explicit ack/no
retry results, real job terminal states, sibling scheduling, progress and audit
rows. The workerd test project keeps its native Queue producer binding but
removes automatic consumers: inbound batches are invoked explicitly, preventing
background jobs and delayed polls from racing another test's outbound HTTP mocks.
Production Queue configuration and the separate full local runtime runner remain
unchanged; this suite does not claim automatic broker/redelivery timing coverage.

Twenty native cases cover the parent/three-step chain, create/reuse app and
organization resolution/fallback, immutable image resolution, create/update a
named machine, Railway helper installation, healthy completion, no-checks and
critical-check polling, recent/old exits, transient stopped-machine start refusal,
missing/deadline-expired machines, invalid identifiers/targets/credentials, stale
Cloudflare credentials, missing/empty generated environment values, and website
edits during installation or health polling. Only outbound provider HTTP is
stubbed. They do not create live Fly resources or prove provider log delivery.

`@logtura/core` exports `flyBundleFiles`, used directly by the managed service
handler and by `planFlyRuntime` for linked CLI installs. It encodes exact UTF-8
and binary generated asset bytes, preserves executable modes, defaults ordinary
asset permissions and makes Vector YAML private. Duplicate or escaping paths,
invalid asset data and invalid modes are rejected. Previously the managed
handler shipped only vector.yaml; drivers such as Railway referenced helper
files that were not installed. Native tests now inspect the actual generated
provider request's executable Railway helper bytes. Public core regressions cover
binary/Unicode files, default/explicit modes, no mutation and malformed paths.
Installed tarball checks exercise the exported helper and reject a missing bundle
at compile time under NodeNext, Node16 and Bundler without skipLibCheck.

Managed assembly is read under the stable account configuration fence. After the
provider update, recording machine identity/digest uses a guarded transaction; a
website edit during installation fails the stale attempt without recording it as
current. New health-poll jobs carry the committed graph version, and clearing the
outdated marker requires that version still match. Operational status writes now
update only status/time, rather than rewriting configuration fields from an
application read. Pre-fence queued poll jobs may still record machine health but
retain an outdated marker they cannot verify. These are graph/legacy health
fences, not issued-runtime acknowledgement. A provider update can succeed before
the graph fence rejects its stale attempt; durable managed install recovery and
shared issued descriptors/persistent reporter storage are still required.

The managed handler measures 98.18 statements / 86.44 branches / 100 functions /
98.09 lines and enforces 97/80/100/97. All 1,019 private backend/package tests across
95 files pass at 86.93/84.28/90.25/85.26, raising aggregate floors to
86.5/84/90/85. Shared Fly runtime code remains 100% in all four measures with its
existing strict gate. Independent public build/types and all 699 tests across
60 files pass at 95.07/92.62/96.83/95.70, retaining 95/92/96.5/95.5 gates. Both
layouts pass installed tarball checks for all 15 packages and both CLI aliases.
All 280 website/native API tests pass with 93/90/95/94 gates.
The final service/package build and browser/installed CLI/native workerd/Docker
journey pass, including desired/applied convergence, current metrics, restart
reporting, graceful stop and owned-resource cleanup. The public standalone real
Vector flow passes delivery/routing/retry, issued integrity, durable report
recovery and packaged PID-1 startup without the service.

The preceding cron/outbox head bde55e4 completes all code, package, runtime and
coverage steps in terminal private CI run 37007196586; only enforced Codecov
upload fails. Scoped app permission approval is still pending. No npm publication,
new schema migration or production provider/database changes are made by this
slice. Managed issued runtime/apply recovery, volume provisioning, live Fly image
identity proof, remaining live provider matrices, remote cleanup ledgers and
coordinated package publication/migrations/rollout/rollback remain required.

### Verified OCI platform identity and managed image pinning

Read-only production inspection found the existing self-managed forwarder in
Fly's `started` state. Its configured GHCR reference is pinned to OCI index
`sha256:43cb5540794ed195dee5f06e3d30fcf80accd28330642207842d2d14c9ad5a76`,
while Fly reports image digest
`sha256:341fc2a0f55320fd810fd2f98f30dba658128e83326576059be7f4dd68c0294e`.
Fetching and hashing the actual immutable public registry responses proves that
the reported digest is the index's Linux/amd64 image manifest. The other index
entry is an attestation with unknown platform. The platform manifest's config
blob has a third, different digest; it is not the running image identity.
No production machine/configuration/database writes were performed. This is
identity evidence for the existing image, not a live new-runtime rollout or log
delivery proof.

Public `resolveFlyImage` now verifies registry response bytes against a caller's
immutable sha256 root and any declared digest header. Direct OCI/Docker manifests
stay pinned to themselves; an index must contain exactly one Linux/amd64 image
(with no variant or v1), whose descriptor has an allowed manifest media type,
valid digest and bounded size. The child bytes must match both hash and declared
size. Attestations, config digests, missing/ambiguous platforms, nested indexes,
invalid JSON/schema and tampered responses cannot become runtime identities.
The new packaged resolver was also run against the existing production image;
its verified platform digest exactly matches the read-only Fly report.

Registry requests omit cookies, refuse redirects, share a bounded 20-second
request budget and cap manifest/index responses at 1 MiB and token grants at
64 KiB. Explicit pull tokens are sent only to the requested registry. Anonymous
bearer challenges may use a same-origin HTTPS token realm, plus Docker Hub's
known auth.docker.io realm; credentials, fragments, HTTP and other cross-origin
realms are rejected. Requested scope is forced to that repository's pull scope.
Provider response bodies and token values do not enter status/validation errors.
This adapter supports anonymous or explicitly supplied registry bearer credentials;
private registry credential acquisition and additional platform support are not
claimed.

The managed service tag resolver now resolves its immutable HEAD result through
this public library and sends Fly the verified platform image. Native workerd
queue tests check that an OCI index becomes its platform child in the actual
provider request and persisted image digest. Service token/HEAD requests are
bounded, use manual redirects, validate full sha256 headers and keep provider
failure bodies out of errors. Existing default-tag/token alias and malformed
response/error contracts have native coverage. Public installed tarball checks
exercise the resolver's compiled export and strict token option type under all
three supported TypeScript resolution modes.

Fourteen new public OCI cases cover direct/index manifests, independent byte and
size integrity, scoped auth/challenges, invalid platforms/schema/descriptors,
HTTP/token failures, timeout/input validation, redirects/realms, bounded and
cancelled streams, UTF-8 and JSON failures. Five native service image cases and
one additional managed queue index case establish adapter integration. The OCI
module measures 100% in all four measures, enforcing
100/98/100/100 in both layouts. The service image adapter reaches and enforces
100% in all four measures. All 1,039 private cases across 97 files pass with raised
87/84.5/90.3/85.3 aggregate floors; the final gated measurement is
87.17/84.61/90.40/85.47. All 713 public cases across 61 files pass at
95.18/92.79/96.87/95.76 with the existing final aggregate gates retained.

Both layouts pass installed checks for all 15 tarballs, CLI aliases and the
forwarder binary. Package/service builds and types pass. The rebuilt complete
browser/installed CLI/native workerd/Docker journey passes configuration sync,
issued reporting, metrics presentation, restart, graceful stop and resource
cleanup. Its provider adapter is still a local fixture; its Docker config ID is
not registry evidence. The production-read and independently hash-verified public
registry chain above supply the stronger existing-Fly identity evidence.
The public standalone real Vector/runtime flow also passes. All 280 website/native
API cases pass at their existing 93/90/95/94 gates. An earlier local API run saw a
closed loopback socket in the missing-bootstrap case; its unchanged terminal
rerun passes, with no automatic retry added to a mutating API request. This does
not establish a root cause or claim that the local transport failure is fixed.

Preceding private/public heads 343d5a2 and 0a87ef0 complete every code/runtime and
coverage step in terminal runs 37008995714 and 37009014568; only enforced Codecov
upload fails. Private image run 37008995709 succeeds. Scoped app permission
approval remains pending. No npm version, schema migration or production rollout
is changed in this slice. Linked CLI apply must still resolve index references
before issuance/install (its current strict equality would time out for an index),
and its fixture must stop representing a Docker config ID as an OCI manifest.
Managed issued descriptors/storage/durable recovery, final private coverage and
coordinated release/migrations/live rollout/rollback remain required; the full
shipping goal stays active.


### Linked CLI platform identity and offline recovery (implemented)

Linked self-managed Fly apply now calls the packaged `resolveFlyImage` during
read-only preflight, before activation retires the previous instance or any Fly
write. The dry plan, issued plan, private install intent and machine payload all
use the verified Linux/amd64 manifest pin. The acknowledgement still requires
Fly's exact reported platform manifest digest; neither an index digest nor a
Docker config digest can satisfy it. Cancellation during read-only preflight
also prevents activation and provider writes.

The eight-field schema-1 private journal is retained. Resume without `--image`
uses its exact saved platform pin without registry access, preserving recovery
when the registry is unavailable. An explicit resume image is verified again and
must resolve to the same platform pin. Index and direct-manifest references may
therefore name the same intended installation. Changed images/options, unknown
outcomes and strict instance/configuration fencing keep their existing refusal
and recovery behavior.

The CLI accepts an explicit bearer pull credential through the process environment
`LOGT_REGISTRY_TOKEN`; library callers may pass `registryToken` and an `imageFetch`
transport. The pull token is scoped only to the registry, never service/Fly API
requests, public output, runtime environment or private installation journal.
Acquiring private registry credentials remains external; this is not a Fly token
exchange or an automatic private registry authorization flow.

Deployment fixtures now use real SHA-256 hashes of served OCI manifest/index
bytes, with separate config-blob identities. New cases cover index install and
explicit-index recovery, registry failure before issuance, offline no-image
recovery, refusal of a config-blob acknowledgement, CLI credential isolation and
cancellation during read-only verification. Four compiled CLI SIGKILL recovery
boundaries also use an actual local HTTP registry index/manifest chain, retaining
one activation, one provider update and the exact private archive.

The complete installed CLI/browser/workerd/Docker journey serves the same kind of
hash-verified registry chain. The initial `--image` is an index; the Fly payload
and report must identify the child manifest. Separately inspecting Docker proves
the running container's config ID. The fixture checks both registry reads and
refuses leaking Fly credentials to the registry. This remains fixture provider
infrastructure, not a live new-runtime Fly rollout. Actual production read-only
platform identity evidence is recorded in the previous slice.

All 1,044 private cases across 97 files pass at 87.17/84.64/90.40/85.46
(statement/branch/function/line), retaining every aggregate and module gate.
All 718 public cases across 61 files pass at 95.19/92.80/96.87/95.76, retaining
final public aggregate gates. Linked apply measures 96.08/91.66/100/100 and its
module floors rise to 96/91/100/100 in both layouts. Installed checks for all 15
packages, both CLI aliases and the runtime binary pass in both repositories;
the network-denied consumer uses an explicit bounded registry fixture for initial
verification and confirms resume makes no additional registry requests.
Package/service builds, private/E2E types and public package types pass. The full
browser/runtime journey, standalone real Vector/runtime flow and injected
post-runtime owned-resource cleanup all pass. Website source and its previously
verified coverage artifacts are unchanged.

Previous private/public heads 7069e95 and 0bc854a complete all code/coverage/runtime
steps in terminal CI runs 37012191435 and 37012217059; only enforced Codecov upload
fails. Private image run 37012191436 succeeds. Scoped Codecov app permission
approval remains pending. No npm package version, production schema or deployed
machine is changed by this slice. Managed issued runtime installation/durable
recovery, final private coverage, broader provider/remote baselines and coordinated
release, migrations, live rollout and rollback remain required. The full shipping
goal remains active.


### Durable managed provider installation and shared create backend (implemented)

The managed machine step now persists an immutable encrypted install intent before
provider mutation. Additive migration 0027 creates owner/deployment-scoped history,
one active intent per deployment and an indexed recovery lookup. Captured generated
files/environment, full prior machine config and digest-pinned rollback config are
AES-GCM encrypted. Public job/ops payloads carry identities, not these private
payloads. Preparation and dispatch are graph-version fenced. App, organization and
region are immutable target identities; execution checks Fly's actual organization
before writing. Multi-machine or differently named inventories are refused.

A database lease serializes recovery jobs. Phase `dispatched` is committed before
provider dispatch. Creation uses the packaged `FlyMachinesClient.create`; updates
use packaged `applyFlyMachine` with a Fly lease, original machine version and full
before/after configuration guards. Caller cancellation joins the bounded provider
request signal. If a create response is lost, a new job observes the same named
machine, unique `logtura.install` metadata and full intended configuration. It never
blindly repeats an absent/ambiguous dispatched create. Update recovery recognizes
an already-installed exact plan without a second write. The saved intent is reused
without rendering new credentials or resolving a moving image tag again.

The provider identity write and journal's post-write configuration base share one
D1 batch. This handles a worker/job failure after committing the machine identity
but before publishing the health poll: a subsequent job uses that committed base
and same installation. Expired/competing database claims cannot finalize another
claim or clear its lease. A changed graph, uncertain provider outcome or mismatched
machine leaves the intent for recovery. Healthy completion checks exact saved
config and reported manifest digest before clearing the old bundle marker and
closing this legacy installation. Pre-journal queued polls retain their existing
compatibility behavior.

Private intent is capped at 1,900,000 plaintext bytes, leaving row/envelope overhead
beneath [D1's 2,000,000-byte row/BLOB limit](https://developers.cloudflare.com/d1/platform/limits/).
Oversized generation fails before provider writes. Reads normalize D1's array-form
BLOB result before enforcing the ciphertext bound, then authenticate/validate the
private shape, target identity and rollback snapshot. Corrupt storage produces a
payload-free recovery error. Imported-row corruption tests preserve production
SQL immutability triggers. Explicitly awaiting private decode also keeps the
immediate bounded-read rejection attached to its caller in native workerd.

The new public create operation validates immutable image syntax and the returned
machine's name, region and complete planned config. It performs no automatic
creation retry. An explicit Bearer/FlyV1 scheme supports already discharged adapter
credentials; the API does not acquire/discharge them. Installed tarball tests execute
creation and validate the new required-field/scheme types in NodeNext, Node16 and
Bundler modes. The underlying [Fly create contract](https://docs.fly.io/machines/api/machines-resource)
was checked; automatic create idempotency is not assumed. Persistent volume names
are not unique identities (see [Fly volume behavior](https://docs.fly.io/machines/api/volumes-resource));
checkpoint provisioning still requires its own durable operation.

Eighteen native journal cases cover immutable encrypted storage, unknown/lost
creates, lost update recovery, exact rollback, competing config/inventory,
concurrent preparation/execution, expired claims, graph races, cancellation,
ownership, organization, imported corruption, bounds, indexing, cascades and
post-target-write graph bases. The 25-case real producer/inbound queue baseline
covers the complete legacy chain plus response loss, post-commit poll publication
failure, recovery target changes and changed healthy files/digest. Empty-inventory
and deadline fixtures now carry explicit data objects and assert the intended
failure cause. A separate schema-26 upgrade compares every application table,
excluding D1-owned metadata/migration bookkeeping, and confirms empty journal
storage without rewriting existing forwarders or configuration versions.

All 1,069 private cases across 99 files pass with every existing aggregate gate
retained. Final measured statement/branch/function/line coverage is
87.24/84.91/90.31/85.54. Journal coverage is 96.93/96.07/100/100 with enforced
96/95/100/100 floors. The managed queue handler reaches 99.20/93.54/100/100 and
its floors rise to 99/90/100/100. Public core Fly transport remains 100% in all
four measures. All 720 public cases across 61 files pass at
95.20/92.83/96.88/95.77. Installed checks for all 15 packages pass in both layouts;
package/service builds and types pass. All 280 website/native API cases pass at
93.21/90.12/95.36/94.48 with existing strict UI gates. The fresh schema-27 complete
browser/installed CLI/workerd/Docker journey passes, as do standalone real Vector
flow and injected post-runtime owned cleanup. This browser journey remains the
self-managed path; it does not claim real managed Fly resources or managed issued
runtime/report delivery.

This is the persistent provider-install foundation, not completion of managed
runtime convergence. The machine config still follows the legacy Vector launch
and health-based bundle marker path. Issued runtime descriptors, durable checkpoint
volume provisioning, accepted-report success, obsolete/unknown-intent recovery UX,
fleet semantics and exercised coordinated rollback remain required. App creation
and organization-discharge steps still use private legacy adapters; their bounded
shared provisioning/recovery integration is also required. No npm version,
production migration or deployed forwarder is changed by this slice. Production
remains through migration 0017; source migration 0027 is unapplied there.

Migration rollback retains the additive table. Before rolling a managed consumer
back to a worker that does not understand the journal, pause managed queue work
and reconcile active intents/unknown provider outcomes; an older consumer must
not blindly run a pending create. This constraint needs staging/rollback proof,
not just documentation. Prior private/public heads 8c93e53 and be3fab7 complete
all code/runtime/coverage steps in terminal CI runs 37014109114 and 37014101158;
only enforced Codecov upload fails. Prior image run 37014109274 succeeds. Scoped
app permission approval is still pending. Final private coverage, broader provider
and remote baselines, coordinated releases/migrations/live rollout and rollback
remain open. The full shipping goal remains active.
