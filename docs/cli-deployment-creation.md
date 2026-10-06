# Hosted CLI creation and linking

This convergence slice implements the missing reverse direction in phase 5:
an installed public CLI creates a self-managed hosted deployment, the website
edits it, and the CLI pulls, pushes and applies the resulting manifest. Standalone
generation and deployment do not require the service or an account credential.

The CLI command and flags are documented in
[the public CLI README](../packages/cli/README.md#create-and-link-a-hosted-deployment).
Creation requires an existing owned connection. Source and monitor selections are
explicit arrays or `null` for following all owned inventory. Optional Fly binding
requires both app and machine IDs, checked through read-only provider requests;
the service stores that binding in the same transaction as the deployment.
Creation itself does not provision resources or upload provider secrets.

## Recovery contract

The public core exports strict creation request and receipt validators and SDK
methods. `POST /api/deployments/creations` atomically inserts an immutable owned
receipt and its self-managed deployment. Identical retries return the same receipt;
changed intent under the same request ID is a conflict. An owner can read a receipt
at `GET /api/deployments/creations/:requestId`. Other owners cannot retrieve it.
After deletion the receipt returns `deleted`; retry never recreates the deployment.
Receipt responses disable caching. Schema 37 retains receipt identity after target
deletion, with owner deletion cascading normally.

The CLI fsyncs a private creation journal before dispatch. Recovery checks the
service origin, account and complete saved intent. A lost response reconciles the
owned receipt instead of sending a new creation request. Received receipts survive
failed export or local writes. Config, environment and link writes use the existing
atomic file transaction, while verifying the creation intent before staging.
Interrupted finalization preserves the journal and private archive. Default resume
preserves changed local files; explicit `--resume --force` repairs the local export.
Only an observed server deletion permits `--abandon`. Unrelated writes are blocked
while creation is pending; status reveals only request ID, phase and deployment ID.

## Validation and rollout

Native workerd tests exercise ownership, concurrent identical and conflicting
requests, atomic rollback without orphan records, selection semantics, immutable
receipts, deletion and HTTP contracts. Public tests cover strict schemas, response
correlation, private files, interrupted dispatch/export/finalization, changed intent,
changed local files, explicit repair, deleted outcomes and read-only Fly validation.
Installed archive consumers typecheck the new SDK and CLI exports outside the
workspace, including required-field negative controls.

The local E2E starts with website creation and existing bidirectional edits, then
creates a second deployment through the installed CLI, edits its metrics through
the real website, and pulls/pushes it through the CLI. That created logical identity
continues through actual Vector apply, mounted update, restart, rollback, both
cleanup modes and fresh deployment. Teardown owns both deployment records.

Creation is published in 0.3.4 and deployed through schema 37. The historical
preparation gates below are now satisfied; see the current
[rollout evidence](service-rollout-0.3.4.md). Before rollout, retain
native/installed-package/coverage evidence, merge protected public CI, publish a
coordinated immutable release, and compile the service against those registry
archives. Replay a fresh production schema-36 backup through schema 37 with both
the retained current Worker and candidate. Import the full migration as an SQL
file: its trigger must not be split into individual statements. Production smoke
must use the authorized owned account, retain creation receipts, clean disposable
records and preserve the original forwarder's final manifest and delivery proof.

Local validation on October 5, 2026: 1,890 tests pass across 151 projects/files
with 97.70% lines, 96.85% statements, 94.28% branches and 98.92% functions.
Creation validators and service operations have 100% coverage; the private CLI
journal has 100% lines/functions and exceeds its 95% statements/90% branches
floors. The atomic transaction module retains its full four-metric gate.
Types and E2E declarations pass. Fifteen isolated tarballs and the packaged
service/website/native D1 lifecycle pass. Public source is under
[PR 21](https://github.com/logtura/logtura/pull/21); merge and release are pending.

The complete local E2E subsequently passed both mounted and legacy managed
queue journeys, including website rollback, checkpoint preservation, retained
candidate cleanup, fresh accepted replacement and graceful Docker shutdown.
The new CLI-created identity passed the full self-managed runtime path, and
owned teardown passed. Independent package typechecks initially found a test
mock's erased Vitest type and an untyped owner setter; both are corrected and
all 15 package typechecks pass. PR 21 retains that correction and must pass a
fresh required CI run before merge.


Production acceptance, October 5: the actual published CLI created an owned,
unbound disposable record with empty source/monitor selections. The logged-in
website changed its name and metrics; published pull captured that configuration.
A local metrics edit was pushed at desired sequence 2 and appeared after website
reload. The record was deleted through the owned API, and the immutable creation
receipt reports `deleted`. No provider resource was provisioned. The original
unchanged manifest was then reissued and applied at sequence 3 with its existing
machine and preserved checkpoint. All original graph selections remain intact.
