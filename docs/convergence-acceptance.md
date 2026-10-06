# Convergence acceptance evidence

Current release update, October 5, 2026: all 15 actual npm 0.3.4 archives are
verified against immutable `v0.3.4` (`f5d8ea74`). Production uses the actual
registry-backed Worker and website through schema 37. Fresh all-row replay,
remote staging, owned Fly delivery/update/restart/rollback and cleanup passed.
The original forwarder has completed rollback, both cleanup modes and a fresh
0.3.4 apply with the unchanged original graph and natural sink delivery.
Published CLI creation → website edit → CLI pull/push → website verification
also passed on a disposable owned production record; its deletion receipt is retained.
After cleanup the original unchanged graph was reissued/applied at sequence 3.
See [0.3.4 rollout evidence](service-rollout-0.3.4.md).

Both `logtura/logtura` and service repository `q32llc/logtura` are now public.
Both default branches require the up-to-date `test` check, including for admins,
and prohibit force pushes and branch deletion. Earlier private-plan protection
limitations are historical. Public PR 23's bounded rollback-readback improvement
is merged; coordinated 0.3.5 publication and final audit remain open.

This is the current acceptance index for the [full plan](oss-service-convergence-plan.md),
not a replacement for its baseline matrix. The goal is still in progress. Historical
milestones in that plan describe intermediate states; the evidence below identifies
what has actually shipped and what still needs verification.

The [runtime delivery matrix](runtime-delivery-matrix.md) now proves all selected
provider/destination transport rows in native fixtures, including refreshable
Supabase auth and encoded metrics. The parser fixes are part of the immutable
0.3.2 tag, whose complete registry publication is verified against the original
tested archives. Production uses those actual npm packages. See [current rollout evidence](service-rollout-0.3.2.md).

| Requirement | Authoritative current evidence | Remaining acceptance |
| --- | --- | --- |
| Published standalone CLI/libraries | All 15 actual npm 0.3.4 archives verified against immutable `f5d8ea74`, isolated installed consumer receipt and both aliases/runtime binary; standalone generation has no service requirement. | Preserve exact archive checks for 0.3.5. |
| Packaged service backend | Production Worker `739068f2-d0a9-442a-b4f2-e3e01d44ce8a` matches actual-registry service artifact `.tmp/service-034-registry`; isolated package/native-D1 missing-entry negative control passes. | Repeat actual-registry build/deployment for the new patch. |
| Portable configuration and loaded manifests | Original graph hash `bc54fc48…` remains unchanged; issued runtime `ff336b64…` reports desired/applied sequence 3. Real website shows In sync and all 63 sources/one monitor/one sink. | Preserve proof after the patch rollout. |
| Website ↔ CLI synchronization | Website-created original is updated through published CLI and loaded runtime. Published CLI-created disposable identity is edited in the website, pulled/pushed by CLI, verified on reload, deleted with retained immutable receipt. Full local installed-CLI/browser/workerd/Vector path also passes. | Final named-case requirement audit, rather than inferring all recovery cases from this happy path. |
| Deterministic baseline | Native route/ownership/selection/queue/ingest/cron suites; independent package/real runtime transport matrix; browser/UI and installed-package E2E with failure cleanup. Local current core/backend suite: 1,891 tests across 151 files. | Complete the explicit baseline case-to-test audit; exact new service CI is running. |
| High owned CI coverage | Local 97.71% lines, 96.85% statements, 94.27% branches, 98.92% functions; per-package/module floors, separately measured UI, LCOV/JSON/HTML artifacts and 95% changed-line gate. Required failure PR was blocked and closed. No Codecov dependency. | Exact new public/service checks and final report inspection. |
| Required CI gate | Both repositories now public; OSS main and service master require strict `test` success, including admins, and prohibit force pushes/deletion. | Earlier private-plan limitation is resolved. |
| Remote lifecycle/isolation | Actual-registry Cloudflare run `run-x55Cst` passed schema 17→37, routing and owned Worker/D1/queue absence. Native CI needs no cloud credentials. | Preserve cleanup/uncertain-dispatch checks for the patch rehearsal. |
| Selected live source delivery | Published standalone Worker tail → generated Vector → owned webhook passed with explicit owned cleanup; fixture/live distinctions are in the runtime matrix. | No assertion of live sandboxes for every external provider. |
| Fly runtime and rollback | Actual-registry canary `run-ANWfco` passed delivery/restart/update/rollback. Original published CLI rollback, restored-candidate cleanup, fresh 0.3.4 apply and final standby cleanup all passed. Actual original sink received/sent a natural event. | PR 23 fixes the observed readback lag; publish/deploy 0.3.5 and rehearse the patched path. |
| Existing deployment/service compatibility | Fresh schema-36 backup and both retained/candidate native replays preserved all 836 application rows/30 tables/history/24 deployment fields through schema 37; byte/binding-verified production rollout and natural metrics/heartbeat passed. | Fresh compatibility gates for the patch rollout. |
| Dependencies/runtime identity | Compatible Hono/router and test-tool patch updates shipped; generated/runtime validation pins Vector 0.55.0. Separate major/interpolation/advisory decisions remain in dependency plan. | Deferred major upgrades keep their separate decision scope. |
| Default branches/immutable release | Public PRs 21/22 merged, 0.3.4 release run `37390843139` passed with original archive receipts. PR 23 merged as `860f791e…`, required CI `37395128666` passed and complete review audit is clear. Service current fix source `4edad0a` is pushed; image rerun passed, tests live. | Protected 0.3.5 version merges, exact-main validation, immutable tag, publication and deployment. |

The entries below retain earlier release evidence; the matrix above is current.

The registry Fly run used OCI index
`sha256:2f8d548133cbab9cfc96113da726918ece81698b29c72fcea0506a9e31e8bf36`,
resolved by the packaged backend to Linux platform image
`sha256:a8637df390d6e243e19309be1a9d7661066b99d72817c9485daca81ed64a9e81`.
Its owned machine, Worker and tail are deleted. Volume deletion was acknowledged
and the detached `pending_destroy` tombstone was verified; absence is not claimed.
The original forwarder's config, instance and started state remained unchanged.

The ordinary production browser session approved the user-authorized temporary
published CLI grant. Reversible CLI and website edits passed in both directions,
and the original graph was restored. A separate local smoke client is also approved;
its read-only probe passes liveness while truthfully reporting no applied manifest.
Persistent lifetime support is deployed with exact-commit CI, native compatibility
and uploaded-byte verification. The browser-owner decision and server lifetime are
verified; the temporary grant is revoked and rejected with HTTP 401. See
[smoke-access rollout](service-rollout-smoke-access.md).

The original mountless Fly upgrade exposed a real provider constraint: its separately
created checkpoint volume cannot be attached through the existing in-place update.
Fly returned HTTP 400; the exact old configuration was verified and restarted.
The issued runtime and private apply/volume journals remain for recovery through the
retained-machine replacement path. No loaded-manifest upgrade is claimed.
The [linked replacement implementation](linked-fly-replacement.md) records the
binding/recovery contract and the remaining installed-CLI and rollout acceptance.

Completion still requires original forwarder loaded-manifest upgrade/rollback and
accurate disposition of the private branch-protection limitation. Production snapshots, raw receipts,
credentials and complete provider configuration remain private and gitignored.
