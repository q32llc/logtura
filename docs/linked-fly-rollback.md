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

The packaged CLI implements the owner handoff:

```sh
logt deploy fly --rollback
logt deploy fly --rollback --resume
logt deploy fly --rollback --resume --rebase
```

It flushes a private rollback journal before service preparation, retains unresolved
apply/replacement records, validates immutable installed or abandoned archives, and
checks current service fences before each provider transition. Candidate stop
precedes original start. Lost service responses and local projection acknowledgements
resume from retained intent. Status exposes only recovery identities. Credentials and
complete provider settings remain in private files.

An explicit rebase acknowledges website changes while a handoff is pending. After
completion, it reconciles local projection against a newer graph without changing
the completed receipt or repeating provider lifecycle writes. Desired configuration
changes remain pending; restoring the legacy machine leaves applied state unknown.
The stopped candidate and checkpoint volume remain retained for explicit cleanup.

The native installed-package suite exercised an actual running legacy Vector
container delivering HTTP events, replacement, subsequent candidate update and
restart, then CLI rollback to the original settings and resumed delivery. It checked
that the candidate stopped before restoration, reports were retired, and the website
showed no reported applied revision. Crash tests cover lost preparation/completion,
local projection loss, repeated website rebases, and recovery after an obsolete apply
was archived. All 15 installed archive consumers passed.

Protected public main contains the owner protocol through PR #15 (`129b28da`), and
its required CI passed. CLI integration passed 1,793 tests with every coverage gate, 97.61% overall
line coverage and 134/135 changed executable lines. Publication and required
CLI integration CI remain separate requirements. Explicit self-managed cleanup, cross-generator production journal
recovery and the coordinated release remain outstanding. No schema 33/34/35 or
replacement/rollback integration has yet been deployed to the original production
deployment. Its upgrade, rollback and final restoration must use the published CLI
and verify real loaded-manifest evidence and delivery.
