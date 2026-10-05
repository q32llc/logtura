# Explicit linked Fly cleanup

The packaged core plans and executes retained-machine cleanup. Schema 36, owner
reservation/rebase routes and the public SDK are implemented and being validated;
private CLI adaptation and installed lifecycle acceptance remain.
No cleanup capability described below is yet deployed to production.

## Owner reservation

An explicit `deploy fly --cleanup` should remove only the stopped machine retained
by an acknowledged replacement or rollback. It must retain the checkpoint volume
and the running survivor. The additive owner receipt contains the original
binding request ID, terminal rollback ID when applicable, current configuration
version/desired sequence/revision, current reporting identity and hashes of private provider settings. The joined
binding and optional completed rollback receipt identify survivor/retired machines. Credentials and resolved
provider settings remain exclusively in the private CLI archive.

Preparing is an atomic current-graph/physical-target CAS. For an installed candidate,
accepted current-instance reporting is required; legacy restoration instead requires
the completed owner rollback and unknown applied state. Concurrent rollback,
activation and physical binding must remain excluded until cleanup completion.
Historical receipt lookup recovers immutable intent but never establishes current
ownership, graph or provider state. Exact request replay recovers acknowledgement;
request ID reuse with different inputs conflicts.

Website edits should require explicit resume/rebase against the unchanged provider
identities. Append-only rebase acknowledgements must not rewrite original intent.
Completion releases the exclusion without inventing a runtime acknowledgement or
advancing the physical graph when the survivor target is unchanged.

## Durable CLI and shared backend

The CLI should flush a bounded 0600 private journal before owner preparation or
provider writes, block conflicting local configuration/apply/rollback operations,
and expose redacted pending status. Use `planFlyReplacementCleanup` and
`executeFlyReplacementCleanup` rather than duplicating provider transitions.

The existing engine validates exactly the saved survivor and retired inventory,
original/candidate payloads, organization, checkpoint attachment and both provider
leases. It flushes `deleting` before DELETE. Resume only observes an uncertain
DELETE; it never sends a second DELETE, force-stops a survivor, or deletes storage.
After confirmed absence, guard again before archiving the private state and
acknowledging owner completion. Retain an uncertain journal even when interruption
occurred between intent and dispatch; make any further recovery explicit.

## Acceptance and release gates

- Native D1 owner isolation, atomic reservation/retirement exclusion, graph fences,
  historical response recovery, corrupt receipts and storage-failure rollback.
- Private adapter mode/symlink/size/identity checks, immutable CAS transitions,
  fsync/acknowledgement loss, archive conflicts and conflicting local writers.
- Installed CLI on actual Vector containers: replacement/update/restart, rollback
  with original delivery, cleanup of the stopped candidate, retained running
  original/checkpoint, fresh replacement and accepted loaded-manifest delivery.
- Lost DELETE response and delayed absence: one dispatch and safe resume; changed
  provider inventory/settings/organization, survivor/reporting identity or website
  graph must fence deletion and local acknowledgement.
- Full owned coverage gates, 95% changed executable lines, all 15 packed consumers,
  protected public CI, private master and public main pushes before release.
- Production only after coordinated publication, schema backup/compatibility proof
  and retained service rollback: published CLI original upgrade, loaded-manifest
  and delivery proof, explicit rollback/cleanup and final restored deployment.


## Protocol validation status

Focused native owner/SDK tests passed 15 tests; the separate real migration suite
passed three tests. They cover installed
and restored reservation, unchanged target/clock/report evidence, activation and
rollback exclusion, lost responses, request reuse, explicit website rebases,
continued installed reporting identity, bounded owner routes, metadata/report
changes, malformed receipts, and atomic preparation/completion/rebase storage
failures. The SDK exposes prepare/get/complete and rebase/rebase-lookup methods.
Rebase receipts use `cleanupId`; original request/provider identities remain fixed.

Migration tests now avoid importing the shared fixture that installs all migrations
before a test. They actually begin at schemas 32/33/35, then apply the targeted
migration. Schema 36 preserved every existing application table and real pending/
completed rollback receipts, with no foreign-key violations. Cloudflare internal
metadata is excluded from application-row comparison.

Full coverage passed 1,809 tests and every existing gate (97.63% lines, 96.97%
statements, 94.47% branches, 98.94% functions). Changed executable coverage passed
96/96 lines. Cleanup validators have an enforced 100% coverage floor in both
private and public CI. All 15 installed archive consumers and exact public
build/typecheck/coverage checks passed. Required CI remains separate evidence. The new
protocol has not yet shipped or authorized any production deletion. Rollback CLI
integration is merged via protected public PR #16 (`2abe6a87`), whose required CI
passed. Production remains on schema 32 until the coordinated release/backup/
compatibility/rollback gates are satisfied.
