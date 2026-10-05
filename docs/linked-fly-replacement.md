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
child process. The linked command integration and production rollout are pending.

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
