# 0.3.5 coordinated rollout

Status: published and deployed. All 15 public packages, the registry-backed
Worker/website and the original forwarder run 0.3.5. Schema 37 is unchanged.
The [baseline audit](convergence-baseline-audit.md) maps the original requirements
to tests and execution evidence; [the acceptance index](convergence-acceptance.md)
records current capabilities.

The patch treats a known prior Fly configuration readback immediately after
rollback restore as bounded pending work. Strict identity/configuration/version
fences still reject foreign edits, and neither stopped machine starts before
exact restoration is observed. The regression requires one restore update,
no premature start and successful subsequent observation. All 41 replacement
tests pass; the complete local core/backend baseline passes 1,891 tests.

## Protected sources and publication

- Public rollback PR 23 merged as `860f791e…` after required run `37395128666`.
  Version PR 24 merged at `c287447c7baf2307560c43d3bec5af06f0f81ebb`; required
  run `37396324892` and exact-main run `37397158694` passed.
- Service version PR 1 merged at
  `eebf379242c1285f24f26b4f02c0f0a5be0aa36d`; required run `37396327179`,
  exact-main test `37398309631` and image build `37398309619` passed.
- Final full GraphQL review audits had no uninspected pagination. All 24 public
  PRs had zero reviews, comments and threads; service PR 1 was also clear.
  The deliberately failing public PR 1 is closed and unmerged.
- Immutable `v0.3.5` points to the public merge. Publication run `37400216202`
  passed all original archive/registry integrity checks and fresh installed
  consumers. All 15 original archives are retained in release evidence and the
  GitHub release; no tag was moved or uncertain publication redispatched.

Both repositories are public and require strict, up-to-date `test` checks on
`main`/`master`, including admins. Both prohibit force pushes and default-branch
deletion. Previous private-plan/payment restrictions are historical.

## Exact artifacts and owned coverage

The OCI index is
`sha256:6bf69c8d9badd2c8ef7e1b18d40c2826ab0e7351dcb9c08b58c8f312bcc695a8`;
the verified Linux amd64 image is
`sha256:2abc49549eca8ba759bba9ccffac41f5ed79fd59bb6a73aedc59bd7ac9ecd29a`.
Its executable help passes, and runtime binary SHA-256
`7cdd9d5bad204a3d4fd243e449fd0af1ce5501505ebb2b41a21dd1761385207c`
equals the actual npm 0.3.5 runtime binary. The runtime has no `--version` flag.

The isolated actual-registry service artifact is `.tmp/service-035-registry`,
with Worker SHA-256
`aab25be01f3ba14819e8fdadd7805b06e0706924c6f437b249539241e1813baa`.
Installed public modules, types, website, native D1 lifecycle and missing-entry
negative control all pass. Source and frozen-lockfile identity, all 37 migration
hashes, website assets and registry archive receipts are retained.

Downloaded exact-main LCOV/JSON reports pass consistency checks. Public main's
70 production files measure 99.24% lines, 97.70% statements, 99.33% functions and
95.58% branches. Service-main's 80 backend files measure 95.78/95.57/98.14/91.92%;
its separately measured 22 UI files measure 94.97/93.81/96.53/90.75% in the same
order. All package/module floors and the 95% changed-line gate pass. CI retains
LCOV, JSON and HTML and uses no Codecov account or token.

The local consumer initially lacked its own package manifest and npm failed
before installation. Adding an isolated private manifest corrected the setup;
the same immutable bytes passed installation and image-binary comparison.
No release assertion or coverage floor was weakened.

## Remote and fresh compatibility gates

Cloudflare rehearsal `run-nQBrbj` passed real HTTP routing and legacy reporting,
schema 17→37 compatibility and verified absence of its owned Worker, database
and queue. Actual-registry Fly rehearsal `run-UbbX6R` passed real owned Worker
source → generated Vector → webhook delivery, checkpoint persistence across
restart, updated manifest delivery and rollback delivery. It verified that the
original configuration, instance and started state remained unchanged.

Fresh schema-37 export `run-Un5MMo`, taken at 2026-10-06T01:58:15Z, has SHA-256
`2d720fcfe74bd7a545367d6ddb063141ac4f91f6d4b1c844b37b420ea22a952f`.
Current 0.3.4 Worker/settings/version are retained in `run-eWckEs`.
Both `legacy-native-qJNSkp` and `candidate-native-U2hBIv` preserve every one of
846 application rows, 31 tables, migration history and 24 deployment fields.
Reporting authorization, foreign keys and counters above 2^32 pass with zero
outbound requests and no production mutation. No production migration ran.

## Production and original forwarder acceptance

Durable deployment ledger `run-rYiTRO` records Worker version
`6dd30d3f-9452-4fc0-a5ea-b009c03102b4` at 100%, actual uploaded-module digest,
website index/assets, unchanged bindings and natural persisted forwarder progress.
The new deployment is `f70ea98b-4da9-4e41-ab64-19c6cee4ed8e` at 01:59:52 UTC;
a later natural checkpoint is observed at 02:02:59 UTC. No synthetic heartbeat
or production error was sent to manufacture acceptance.

Published CLI 0.3.5 pulled the original graph, found no public/private differences
and applied the pinned image in place. The sole machine remains
`d8d9973db66dd8`, with the original encrypted checkpoint
`vol_4m3029m70z5x7z6v`. Its accepted runtime is
`114ce418-9eae-43aa-8e10-79a24cbdf20d`; generator 0.3.5 and Vector 0.55.0 are
recorded in the loaded artifact. Desired/applied sequence 3 is current and nonstale,
with the unchanged graph hash
`sha256:bc54fc48b9af8384e507478aa172f7943a3b06a30022b632e56431d1899ff319`.
The signed-in website reload shows In sync, 63 sources, one monitor, one sink,
97 components, fresh heartbeat/metrics and zero pipeline errors. Actual original
sink counters receive/send a natural event after the upgrade (one each), following
eight received/sent events in the pre-upgrade check.

The earlier published CLI production creation → website edit → CLI pull/push →
website verification and owned deletion remain verified in the 0.3.4 rollout.
Original rollback, both cleanup modes and restoration also passed there; the new
readback regression and actual-registry canary verify the patch without repeating
unnecessary replacement of the now-mounted original.

Final provider observation verifies no active canary machine, Worker or tail.
Older canary volumes are absent; `run-ANWfco` and `run-UbbX6R` retain detached
`pending_destroy` tombstones following acknowledged deletion. Their absence and
billing consequences are not inferred. The original checkpoint remains attached.
Raw SQL, settings, configuration, receipts and credentials stay private and ignored.
