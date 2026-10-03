# Service 0.3.1 and metrics contention rollout

This rollout consumes all fifteen immutable npm 0.3.1 archives from public tag
`v0.3.1` (`ec4ca1d5b1a83aed1cacd49aeb6596fa139f1895`). The
[metrics incident fix](metrics-checkpoint-contention.md) is private service code;
it needs no database migration or existing forwarder configuration change.
The fix is pushed as `6f4acfb` and passes 1,712 backend tests, 306 UI tests and
the owned 100% (8/8) changed-line gate. All fifteen actual registry archives
match the immutable tested release; isolated consumer and native packed-service
checks pass. The audited service artifact is built from private `e8b48b5`.

Production deployment completed at 11:29 UTC on October 3, 2026. Worker version
`79a9007c-d379-4421-b7e7-a43e87c2b284` serves 100% of deployment
`cb9a56ba-5659-415b-bf62-927ceb30457e`. Its verified main-module SHA-256 is
`affb09aec80579b21ed87d36ca010faa5eb2b7c25da8b83a39c5d1960e6112de`.
The served index and both website assets match the tested export. Existing
bindings and all 24 deployment fields were checked; only expected metrics and
heartbeat timestamps may advance. No migrations were dispatched.

Keep the original schema-17 backup and pre-convergence Worker snapshot intact.
For this rollout, a separate private capture retains current production's
0.3.0 Worker, version and settings under `.tmp/production-rollbacks/run-MjVWd2`.
Its active version is `8eeebf0e-f219-4cc8-ba45-01cb63eeba89`. The complete
download, including `worker.js` and `dist/index.html`, has SHA-256
`599ef4c274949abe66b20a87ff2c469a4be4a9339692d0e609f746f87d808ba1`.
Fresh schema-32 SQL is retained under `.tmp/production-backups/run-X8kJTe`,
601,706 bytes with SHA-256
`0c14c8e8d3df8d7da2551d602daa984d444d94cff9b4a2fe747e5ff8866d3800`.
These private files contain production state and must stay out of CI artifacts.

The native verifier now reads `backup-receipt.json.sqlFile`, defaulting to the
original `schema-17.sql` format. It rejects path substitutions and requires the
restored migration names to equal the repository's canonical prefix and the
filename's schema count. It applies only missing migrations. It accepts the
observed main-module names and optional static index, while rejecting unknown
or duplicate executable modules. Registry candidates must identify all fifteen
matching package names/versions from a clean audited build.

Both the original pre-convergence Worker/schema-17 replay and current
0.3.0 Worker/schema-32 replay pass. The latter preserves all 24 deployment
fields, accepts real token-shaped heartbeat/metrics requests, rejects an invalid
token, passes foreign-key checks and makes zero outbound provider requests.
The actual-registry 0.3.1 candidate also passed that replay, including positive
wide counters, and disposable Cloudflare staging passed with owned resources
cleaned. The same verifier can validate subsequent registry candidates:

```sh
pnpm test:legacy-snapshot /private/current-worker /private/schema-32-backup
pnpm test:legacy-snapshot /private/current-worker /private/schema-32-backup .tmp/registry-candidate
```

Follow the audited-artifact staging, deployment and byte-verification procedure
in [the 0.3.0 rollout](service-rollout-0.3.0.md). For this Worker-only change,
verify the existing 32 migrations without dispatching another migration.
Preserve all production bindings, the website route, queue and cron. Observe
natural heartbeat/metrics advancement and exceptions after deployment; injected
production metrics are not evidence of a healthy original forwarder.
Retain the exact previous version's deployment request for rollback. The
forwarder image/volume/manifest upgrade is a separate acceptance step.

Private deployment receipt `.tmp/production-deployments/run-rhQmjF/run.json`
records exact-byte checks and natural traffic observation. The first 45-second
post-rollout window had 29 metrics requests, all HTTP 204, with zero contention
failures or metrics exceptions. At 11:36 UTC the original forwarder's persisted
checkpoint and heartbeat had advanced naturally; its process start, Vector
version and 97-component identity remained stable, with nonnegative totals.
These bounded checks demonstrate recovery, while continued monitoring and the
remaining production CLI/forwarder acceptance gates remain open.
