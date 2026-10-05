# Explicit linked Fly rollback

The owner-authenticated protocol restores a retained original self-managed Fly
forwarder without claiming that its legacy runtime loaded a newer manifest.
Provider payloads and credentials remain in the CLI's private archives; service
receipts contain public physical identities, configuration fences and hashes.

`prepareFlyRollback(deploymentId, request)` atomically verifies ownership, the
original physical replacement receipt, current target/image, account version,
desired revision/sequence and active reporting identity. It records immutable
intent and clears the active instance, report counter and applied revision before
any provider lifecycle write. Only one rollback may be pending for a deployment.
New activations and physical binding writes remain blocked while it is pending.

The packaged core replacement backend performs the leased candidate-stop/original-
restore handoff using the complete retained original settings. Its private plan
must use the candidate's latest installed configuration, including any subsequent
same-machine updates, while retaining the original before/rollback settings and
physical identities. The CLI must check provider readback and current service
fences before every transition; an old receipt alone never proves current state.

`completeFlyRollback(deploymentId, requestId)` atomically rebinds the target to the
original machine and immutable image, preserves reporting credentials/selectors,
advances the physical graph clock once, and rebases the unchanged desired revision.
Applied state remains unknown and the bundle is marked outdated. Repeated prepare
or complete requests recover the same identity rather than repeating retirement
or physical graph changes. Browser writes require the configured Origin; account
credentials remain scoped to their owner and reporting tokens cannot authorize it.

A website edit during rollback invalidates its fences. Explicit
`rebaseFlyRollback(deploymentId, rollbackId, request)` acknowledges a newer current
desired graph without changing the original rollback request, binding or provider
fingerprints. The rebase acknowledgement is append-only and recoverable through
`getFlyRollbackRebase`; the caller must additionally verify current state before
resuming the provider handoff. A completed rollback cannot accept a fresh rebase.

Schema 35 is additive. Native D1 tests verify receipt recovery, competing requests,
stale fences, report rejection, activation exclusion, subsequent-image rollback,
atomic storage-failure rollback, explicit rebasing, owner isolation and corrupt
stored data. Migration tests compare all existing rows and identities before and
after schemas 34/35. Installed archive checks verify the SDK's emitted declarations.

The protocol is implemented; the CLI command and installed-CLI provider lifecycle
acceptance are the next integration work. Required CLI behavior includes a private
fsynced rollback journal before service preparation; explicit resume/rebase;
retaining unresolved apply/replacement journals; immutable archive validation;
candidate-stop-before-original-start; truthful target projection; and crash/response-
loss recovery through completion and local acknowledgement. Production upgrade,
rollback and final restoration must use the published CLI and verify real delivery.
No schema 33/34/35 or new replacement/rollback integration has yet been deployed to
the original production deployment.

Local validation passed the full 1,779-test suite with every enforced coverage gate,
all 15 installed archive consumers, and the focused 12-test native rollback suite,
including two additional prepare/rebase storage-failure cases added after the full
run. Source typechecking passes. Required CI/public merge and the CLI lifecycle
acceptance remain separate evidence; these checks do not establish production rollout.
