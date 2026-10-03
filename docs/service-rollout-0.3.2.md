# Service rollout 0.3.2

Status: published, deployed and verified on October 3, 2026. Production account
CLI/website acceptance and the original forwarder upgrade remain open.

## Immutable release and CI

Protected public PR 10 merged as `fe3c174093614ae785b3ce562cf8c3ebbac60071`;
immutable `v0.3.2` points there. All fifteen npm package hashes match its original
tested archives. The [release](https://github.com/logtura/logtura/releases/tag/v0.3.2)
retains those archives, manifest and complete recovery receipts.

The tag run `37126668173` passed every transport, runtime, coverage and packed
consumer gate before stopping at an acknowledged package's three-minute npm
visibility limit. First recovery `37127516003` stopped at the same limit for
another package. Each acknowledged version was subsequently reconciled with its
original hash before recovery; no uncertain publication was blindly replayed.

Protected [PR 11](https://github.com/logtura/logtura/pull/11) passed exact CI
`37128007911` and merged as `433660f`. It dispatches each missing archive once in
dependency order and observes complete release visibility within ten minutes.
Collisions fail before publishing, and missing or substituted hashes cannot
produce a completed release. Recovery requires the additional 0.3.2 native
transport gates while preserving the original gate set for older immutable tags.
All 18 safety tests pass in both layouts. Corrected recovery `37128579718` is
green and reused the original archives; the tag was never retargeted.

Exact private source `48b4e847f12c794f601dfb978f9a01d06027b746` passes CI
`37128046420`; protected public main passes `37128549675`. The baseline includes
1,714 backend tests, 306 UI tests and 1,035 independent public tests. Backend
coverage is 97.52% lines/97.14% statements/94.61% branches; public coverage is
99.13% lines/98.42% statements/96.67% branches. UI line coverage is 94.95%.
Existing module floors and the owned 95% changed-executable-line gate remain.
No external coverage service is required.

The release includes the AI Gateway envelope fanout and Supabase individual-row
normalization corrections proven through generated Vector transports. Compatible
private dependencies Hono 4.13.12 and Router 6.30.6 pass the same baseline;
[remaining major/advisory decisions](dependency-upgrade-plan.md) remain separate.

## Actual registry and live acceptance

All fifteen actual npm archives were downloaded with original integrity checks.
Isolated JavaScript, NodeNext/Bundler declarations, both CLI aliases and runtime
binary consumers pass. The private service compiles the Worker and website using
those installed packages, passes native D1 routing/lifecycle checks and rejects
a missing public-core entry. Its clean-source artifact is private at
`.tmp/service-032-registry-48b`; Worker digest is
`sha256:f415f8e0ac11238b481c550677f698688ad11c73ffd9ebe49b3f073ec18cb1ca`.

Disposable Cloudflare staging passed 254 management requests and actual HTTP
routing/legacy reporting. Its Worker, D1, queue and tail are removed; receipt
`.tmp/cloudflare-e2e/run-Z82z8F/run.json` is private. The reusable actual-npm source
canary delivered a real owned Worker event through generated Vector to an owned
webhook and removed its Worker/container/image; private receipt is
`.tmp/live-source-canary/run-v4emec/run.json`.

The actual-registry Fly canary passes source delivery, checkpoint-backed restart
reporting, new-manifest apply and rollback after phase fences. Its machine,
Worker and tail are deleted. Volume deletion was acknowledged and its detached
`pending_destroy` tombstone verified; absence is not claimed. The original
machine's config, instance and started state are preserved. It used CI-built OCI
index `sha256:2f8d548133cbab9cfc96113da726918ece81698b29c72fcea0506a9e31e8bf36`,
resolved by the packaged backend to platform
`sha256:a8637df390d6e243e19309be1a9d7661066b99d72817c9485daca81ed64a9e81`.
This is disposable live proof, not an original-forwarder upgrade.

## Production compatibility and rollout

The fresh schema-32 backup captured at 14:14 UTC is 601,782 bytes with SHA-256
`945e8463e5bd0a638dc596dbb9d51aafa44258bd8983fff2785a9741828dff28`.
Native workerd replay passes for both the registry candidate and captured current
0.3.1 rollback Worker: all 24 deployment fields are preserved, valid heartbeat
and metrics tokens receive 204, invalid tokens receive 401, foreign keys pass,
and outbound calls and production mutation are zero. The candidate also persists
a 4,294,967,307 component counter without truncation. No migration was needed.
Captured rollback Worker and served website assets remain private and intact.

Production upload was acknowledged at 14:25 UTC. Active deployment is
`240f79e6-279e-43de-8d90-2d8b40579e11`, version
`8242c37c-ccd1-4279-8ddf-e0970c40be4a` at 100%. Actual uploaded Worker, website
index and both served assets match the tested artifact. Existing bindings,
credentials and stable deployment fields remain; the original forwarder was
not replaced or reconfigured. Private rollout receipt is
`.tmp/production-deployments/run-ew08ok/run.json`.

The first 45-second post-upload window saw 28 natural metrics requests, all HTTP
204, with zero checkpoint-contention failures or metrics exceptions. Only the
observer subscriber closed; the existing collector was preserved. At 14:29 UTC,
a persisted natural checkpoint advanced after upload acknowledgement. A fresh
14:30 read shows the original forwarder running, heartbeat age 63 seconds,
advancing received/sent totals, zero component errors, 97 components and its
unchanged process start and Vector 0.55.0. This is bounded recovery evidence;
the earlier separate D1 overload diagnosis is not declared resolved.

## Remaining production gates

The normal production account CLI/website round trip and original mountless
forwarder upgrade still require the pending new CLI account grant. Verify loaded
manifest, real delivery, website acknowledgement and rollback while preserving
logical identity and routing; then revoke the canary grant. No production session
or reporting token may be fabricated to replace that flow.

The manual remote Actions workflow exists, but Cloudflare credential transfer to
GitHub secrets remains unapproved. Local staging does not prove that workflow
ran. Private branch protection remains unavailable under the current GitHub plan.
Those external constraints remain explicit in the full acceptance index.
