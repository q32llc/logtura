# 0.3.4 coordinated rollout

Status: published and deployed. The evidence below supersedes the historical
preparation notes. Original forwarder delivery is verified; final standby cleanup is verified. Production CLI creation round-trip acceptance
and the complete requirements audit remain in progress.

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


## Published release and production deployment evidence

Public PRs 21 and 22 merged after protected CI passed and complete review audits
found no reviews, comments or threads. Immutable tag `v0.3.4` identifies public
main `f5d8ea74f74b05a767e591a4f0c41ed091d617b9`. Publication run `37390843139`
succeeded; all 15 actual npm archives match the original release evidence and
passed isolated installed-consumer checks. Exact private source `476b97d` passed
CI `37388697411`; owned coverage remains 97.70% lines, 96.85% statements,
94.28% branches and 98.92% functions across 1,890 tests. No external coverage
service is used.

Image build `37388413059` produced OCI index
`sha256:f3da45f2a3f7aae55e35e997c1b42f8819d3b22381aebfa981aca4e7ddf9fbd6`
and Linux platform
`sha256:abfa841658447a4a8ee30a73b498586dc636c80fc635137bc5db840b5aed164a`.
Its runtime executable bytes match the actual published CLI runtime bytes.
Registry-backed service build `.tmp/service-034-registry` records Worker SHA-256
`71a153a8a90c697499ee877e3c7006e84e9a13d42eacaa4fc444eea3d7c6e728`.

Real Cloudflare rehearsal `run-x55Cst` passed schema 17→37 preservation,
routing/lifecycle and legacy authorization; owned Worker/D1/queue deletion was
verified. Actual-registry Fly rehearsal `run-ANWfco` passed delivery, persistent
checkpoint restart, update and rollback, preserving both original machines.
Owned machine/Worker/tail deletion was verified; its volume DELETE was acknowledged
with detached `pending_destroy`, which is not evidence of volume absence.

Fresh schema-36 backup `run-XBIEyo` has SHA-256
`a814de2ee2d3e638944f495a301169a554244677173e5b416d1ef83b043c56d4`.
Both retained and candidate native replays preserved all 836 original application
rows across 30 tables, all migration history and 24 deployment fields through
schema 37, with valid report authorization, foreign keys and zero outbound traffic.
Production SQL-file migration ledger `run-qTY4SX` completed schema 37.
Deployment ledger `run-tY2R0h` verified uploaded Worker/website bytes, preserved
bindings and natural forwarder progress. Active Worker version is
`739068f2-d0a9-442a-b4f2-e3e01d44ce8a` at 100%.

## Original deployment acceptance in progress

Published 0.3.4 CLI rollback `d318fbf0-1349-441f-a561-b1ae0086fc4b`
restored the original exact configuration and image. The first invocation stopped
both machines but a read immediately after update still exposed the previous
configuration. A subsequent read matched the saved rollback exactly; explicit
`--rollback --resume` started the original and completed the retained journal.
This is verified recovery, not uninterrupted rollback. Improving bounded handling
of this observed provider readback lag remains a follow-up requirement.

Receipt-fenced cleanup `dcf7d78d-1ddd-4a0a-9107-6e94aff1af23` deleted the
stopped prior candidate, verified the running original survivor and retained the
encrypted checkpoint volume. Fresh published CLI apply then created candidate
`d8d9973db66dd8` with the verified 0.3.4 platform digest and issued instance
`0c36ee5a-45ee-405b-b3f6-7031cc774a69`. Production accepted report sequence 1:
desired/applied sequence 2, nonstale, original manifest revision unchanged at
`sha256:bc54fc48b9af8384e507478aa172f7943a3b06a30022b632e56431d1899ff319`.
Live delivery, final retained standby cleanup, production creation round-trip and
final requirement audit remain explicit acceptance work.


Fresh candidate runtime metrics at 00:32 UTC confirm the original HTTP sink has
received one event and successfully sent one event. This is actual natural
production delivery, with no synthetic error injected or test Slack alert sent.
The candidate keeps the original 63-source/one-monitor/one-sink manifest.


Final installed-CLI cleanup `b0c3b4f8-a77c-4d3e-8375-dcf75e093ad1`
deleted the stopped retained legacy machine, verified exactly one running latest
candidate and retained its attached encrypted checkpoint. The logged-in website
then showed **In sync**, desired/applied revision 2, the unchanged manifest and
63 sources/one monitor/one sink without an out-of-date warning. Both original
cleanup modes and fresh latest apply are now live acceptance evidence.
Production CLI-created identity round-trip/deletion and bounded provider readback
lag regression/shipment remain explicit work before goal completion.

## Published production CLI creation round-trip

The actual published 0.3.4 CLI created owned disposable deployment
`dep_5ECnQx0IpGEJmiwiUWELLg` with explicit empty source/monitor selections and
no provider binding. The logged-in website opened that identity, renamed it and
changed metrics from none to logtura. Published CLI pull captured the changed
manifest (`ebea611a…`). A local metrics-only edit was pushed as desired sequence
2 with metrics `none`; a website reload showed the same saved setting and name.
This verifies both directions on a CLI-created production identity without
provisioning another forwarder or routing synthetic events to Slack.

Rollback readback improvement is proposed in public PR 23. Its existing strict
old-machine fence still rejects foreign edits, while a known previous readback
now enters the existing bounded pending loop. The regression proves no premature
start, one restore update and successful subsequent observation/start. All 41
replacement tests and the complete 1,891-test owned coverage suite pass, as does
root typecheck: 97.71% lines, 96.85% statements, 94.27% branches, 98.92% functions.
This change is not yet merged or published; it does not rewrite `v0.3.4`.
