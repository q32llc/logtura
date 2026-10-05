# Linked self-managed Fly replacement

The original production upgrade exposed a provider constraint that the local CLI
fixture missed: a newly created volume cannot be attached by updating a mountless
machine. The shared core already supports creating a stopped candidate on the
volume's host, leasing both machines, stopping the old process, and starting the
candidate while retaining the old VM and complete immutable rollback configuration.
The self-managed CLI must use that backend too.

The first implementation slice adds a public binding contract and an additive D1
migration. `POST /api/deployments/:id/config/fly-bindings` requires account access;
browser writes additionally require the service Origin. The request contains only
public physical identities and hashes. A SQL trigger checks the owner, self-managed
Fly target, old machine and image, account version, desired sequence/revision, and
the active instance's server-issued receipt. Its single INSERT atomically records
the immutable receipt, changes the machine/image binding and public Fly metadata,
and rebases only that unchanged desired revision. Any conflict or storage error
rolls back the entire operation. A runtime instance can bind only once.

Receipt lookup and exact replay precede current-state checks, so a lost response
can be recovered after a website edit without applying it again. Historical receipt
recovery does not make an old revision current. The current-binding GET returns a
receipt only when its new machine is still bound. Existing configuration export
shapes are unchanged, preserving published older clients' strict validators.

The CLI library's `PrivateFlyReplacementStore` now implements the core durable
transaction contract with private bounded reads, an exclusive directory lock,
immutable-plan and candidate checks, atomic rename plus fsync, and private archive
acknowledgements. A pending replacement fences ordinary configuration writes and
appears in redacted `config status`. Tests exercise the actual shared handoff and
rollback backend, response loss, concurrent ownership, fsync failure, and a killed
child process. The linked command integration is implemented in the next slice; its owned coverage/native
checks have passed, and production rollout remains pending.

The remaining CLI integration must:

1. Select the bound machine explicitly, distinguish in-place updates from legacy
   replacement, and verify every retained standby's identity, stopped state and
   immutable configuration before allowing a two-machine inventory.
2. Flush a private replacement journal before candidate creation and each provider
   transition. Resume uses the shared core state machine; uncertain creates are
   reconciled rather than dispatched twice.
3. Recover the production 0.3.2 pending activation/apply journal without inventing
   a new reporting identity or silently rewriting its compiled artifact. Define
   and test recovery across generator versions before issuing a newer runtime.
4. Recover binding response loss through the immutable receipt, preserve local
   write fences, and synchronize the pulled target/version only after a current
   accepted runtime report. A running VM alone is insufficient.
5. Provide an explicit, fenced rollback using the retained complete old settings.
   Keep the website truthful when restoring a legacy runtime that cannot report a
   loaded manifest. Preserve the original deployment and reporting credentials.
6. Exercise this through installed CLI, native workerd/D1, provider lifecycle
   fixtures that reject impossible in-place volume attachment, and actual Vector.
   Cover create-response loss, process interruption, competing edits, lease errors,
   stale receipts, restore, and a subsequent update with a retained old VM.

After those tests and owned coverage gates, publish the coordinated package/image
release and deploy its service artifact using fresh compatibility and rollback
evidence. Then upgrade the original through the published CLI, verify loaded
manifest and real delivery, exercise rollback and final restoration, and audit the
full convergence plan. The original machine remains running on its retained legacy
configuration while these implementation slices are completed.

The linked CLI integration now selects the bound machine explicitly. A mountless
legacy target uses `PrivateFlyReplacementStore` and the shared replacement engine;
a mounted target uses the leased update backend. Subsequent applies accept exactly
the bound candidate and its verified stopped standby. A provider/configuration
fence runs before each lifecycle write, and unresolved replacement journals prevent
abandoning their owning activation/apply intent.

Schema 34 extends the atomic receipt protocol to same-machine image updates without
advancing the graph clock. The current standby receipt remains the original physical
replacement receipt. An owner-authenticated capability endpoint lets the CLI reject
older services before issuing a reporting instance. Both additive migrations preserve
existing identities and state; schema 34 is tested with an existing schema 33 receipt.

An accepted loaded-manifest report precedes local target projection. Completion is
journaled before projecting the private link, then the replacement and apply intents
are archived with acknowledgement checks. Response loss at create, binding, link
rename and archive boundaries is recoverable; changed receipts, missing private
archives and a stopped candidate retain recovery state. The native installed-CLI
journey rejects impossible in-place volume attachment, runs actual Vector on the
candidate, and exercises a second update with the retained standby. The fixture's
original self-managed legacy machine is represented by provider state; the separate
managed legacy journey exercises an actual legacy container's stop/restart ordering.

Explicit self-managed rollback and cross-generator recovery of the production 0.3.2
intent remain release prerequisites. None of these new integration changes or schema
33/34 have been deployed to the original production deployment yet.

Final local validation of the integration passed 1,763 tests with all enforced gates
(97.53% lines, 97.12% statements, 94.63% branches, 98.94% functions), all 15 packed
package consumers, service/E2E typechecks, and the complete native installed CLI,
workerd/D1, browser and Vector journey. The permanent local production smoke token
also passed GET-only identity/state checks; the running original deployment remains
truthfully unapplied. CI and protected public merge evidence are tracked separately
from these local checks.
