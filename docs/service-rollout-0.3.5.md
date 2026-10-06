# 0.3.5 rollback readback patch rollout

Status: preparation; production remains the verified actual-registry 0.3.4
Worker/website and original forwarder described in
[the preceding rollout](service-rollout-0.3.4.md). No existing tag is moved.

Public PR 23 merged as `860f791e7e53ff960da1374aca196b55d0f82406` after
required CI `37395128666` passed. Its final complete GraphQL audit found zero
reviews, comments and threads, with no uninspected pagination. The patch retains
strict old-machine identity/configuration validation but treats a known prior
readback immediately after restore as a bounded pending provider transition.
The existing CLI loop can observe completion without a manual invocation.
Foreign edits still fail, and no restored machine starts until its configuration
matches the exact saved rollback payload.

The regression exercises a successful update followed by a stale prior readback,
both machines stopped, no premature start, exactly one restore update and a
successful subsequent observation/start. All 41 replacement tests pass; full
native/public coverage passes 1,891 tests and every aggregate/module floor:
97.71% lines, 96.85% statements, 94.27% branches and 98.92% functions. Root
types and the actual packed-service isolation/native-D1 check pass.

All 15 package versions are being prepared at 0.3.5, preserving generator/runtime
coordination. The service repository is now public with a strict required `test`
check on `master`, including admins. Exact-source test/image runs initially failed
without executing steps under the previous private account's billing limitation;
the same runs were rerun after public visibility was observed. The image run passed;
full service tests are still in progress. No gate or assertion was weakened.

Remaining gates: versioned isolated consumer proof, protected public/service
version merges, exact-main checks, immutable tagged publication with all original
archive integrity receipts, pinned runtime image proof, actual-registry service
build and remote staging/Fly rehearsal, fresh all-row backup compatibility with
retained/candidate Workers, durable production byte-verified deployment, and final
original desired/applied manifest, routing, delivery and resource cleanup checks.
Schema 37 is unchanged; no new migration is required by this patch.


Versioned local archives initially exposed stale ignored 0.3.4 compiled files
before the new version build. All package production artifacts were rebuilt at
0.3.5 before the consumer suite was rerun; no version assertion was weakened.
The original 0.3.4 final production browser check is current at desired/applied
sequence 3, with fresh heartbeat/metrics, zero errors and the unchanged 63-source,
one-monitor/one-sink graph. Service image CI `37395187444` passed after the
repository became public; service tests `37395187630` and exact OSS main
`37395940289` are still running.
