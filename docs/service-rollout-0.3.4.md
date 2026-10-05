# 0.3.4 coordinated rollout

Status: preparation, not published or deployed. Production still serves the
verified registry-backed 0.3.3 artifact described in
[the preceding rollout](service-rollout-0.3.3.md).

The coordinated public release includes recoverable hosted CLI creation/linking
and strict compatibility with Fly's known decorated mount readbacks during retained
rollback. The candidate service additionally clears a legacy out-of-date bundle
warning only after accepting a current self-managed report, and adds schema 37's
owned immutable deployment creation receipts. Managed readiness gating and old
report rejection remain intact.

All 15 local 0.3.4 archives pass independent installed consumers and runtime
version validation, retained in `.tmp/release-034-local`. This is local archive
evidence, not npm publication. Public PR 21's protected required test run must
pass and its complete review threads must be audited before merging. A separate
coordinated version PR and immutable tag then establish the tested release bytes.
Private CI now also checks every package's test declarations, matching the public
package gate that caught the creation fixture typing issue.

The current production Worker was captured read-only into
`.tmp/production-rollbacks/run-lDfygm`. The active version was stable throughout
capture and is `5bf26ac7-c2e6-4999-bb3b-fbf438987039`; the extracted main module
matches the verified 0.3.3 artifact digest
`sha256:024d6d1be78186c2576e7909656e6e5a1aabbb4c757164500648afdfe9dd0e5b`.
This retained rollback includes full Worker source, settings and version identity.

Remaining rollout gates:

- Verify the exact protected release main commit, immutable tag, all 15 npm
  archives and CI-built OCI index/platform/runtime identity.
- Build the service against those actual registry archives; preserve source,
  dependency, Worker, website and migration receipts.
- Stage full SQL-file imports through schema 37 on owned disposable Cloudflare
  resources and exercise/clean the remote lifecycle.
- Obtain a fresh schema-36 production backup and replay every application row and
  migration history through schema 37 with both captured current and registry
  candidate Workers. Preserve original graph/identity and deny outbound requests.
- Complete the registry-backed disposable Fly delivery/update/rollback rehearsal
  with bounded owned cleanup, fencing the original's current candidate machine.
- Import schema 37 as a complete SQL file and deploy the audited registry-backed
  Worker/website through durable dispatch/acknowledgement ledgers. Reconcile any
  uncertain writes; verify uploaded bytes, bindings and natural forwarder traffic.
- Use the published 0.3.4 CLI to resume the original forwarder's rollback acceptance,
  then cleanup, fresh current deployment, manifest/delivery proof and final original
  graph restoration. Any live creation smoke uses the authorized owned account
  and retains deletion receipts while cleaning its disposable records.

Raw rollback settings, provider state, accounts, backups and receipts remain
private and ignored. This document does not replace live acceptance evidence.

Fresh retained-Worker compatibility evidence, October 5 at 23:27 UTC:
`.tmp/production-backups/run-gKgwPG` contains schema 36's full export, SHA-256
`22e0c51fa6353ea0681680f23751a1b1a8e55b79b4767d33d2d0a2ee4db724a2`.
Native replay `.tmp/production-rollbacks/run-lDfygm/legacy-native-05533u`
restored all 836 rows across 30 application tables, preserved all 36 migration
history entries and 24 original deployment fields, and applied schema 37. The
captured actual production Worker returned heartbeat/metrics 204 and invalid-token
401; foreign keys passed and outbound requests were zero. Production was not
mutated. Registry candidate replay and fresh-state revalidation before import
remain required.
