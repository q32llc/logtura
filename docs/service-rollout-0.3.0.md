# Service rollout 0.3.0

The published libraries and service support are live. The existing forwarder is
still on its original image/configuration; its upgrade is a separate operation.

## Verified release identity

- Public immutable tag: `v0.3.0`, source `3223fe3c576e18d3c4671e97bb00a431d0b4149a`.
- [Release and all 15 archives/receipts](https://github.com/logtura/logtura/releases/tag/v0.3.0).
- All npm versions and latest tags are 0.3.0; downloaded SHA-512 values match the
  exact archives tested by the original tag run.
- Production candidate source: private `3c3596792570c9eb15f50d2d2ccab42b3adeb07b`.
- Worker: `sha256:2269e72207833f53038c1507f225e17771cbd20da645d4ad6144dbbe39dd6fc2`.
- Production's downloaded main module matches this Worker hash. The served website
  index and both website assets match the exported candidate bytes.
- Production schema: migrations 0001–0032. Vector remains 0.55.0.

## Reproduction and ordering

1. Retain the original public release manifest and all its archives together.
2. From the matching private source, export a new registry-backed candidate:

   ```sh
   LOGT_PACKED_REGISTRY_MANIFEST=/private/release/manifest.json \
   LOGT_PACKED_SERVICE_OUTPUT=.tmp/your-new-candidate pnpm test:packed:service
   ```

   This downloads the actual npm archives, verifies their hashes, installs them
   outside the workspace, builds the Worker/website, runs native D1 HTTP and
   website checks, and fails the missing-core-entry negative control.

3. Run the isolated staging rehearsal against that export:

   ```sh
   LOGT_E2E_ALLOW_CLOUDFLARE=1 \
   LOGT_E2E_CLOUDFLARE_ARTIFACT=.tmp/your-new-candidate pnpm test:e2e:cloudflare
   ```

   Use an owned private ledger. Teardown must verify its Worker/database/queue and
   tail are absent. This does not prove live source delivery or a Fly VM upgrade.

4. Capture production's current deployment/version/settings and Worker download,
   then take a private D1 SQL backup using the continuously polled
   [export endpoint](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/).
   Export can pause D1 queries while running. Do not upload its signed URL, SQL,
   credentials, original script or raw diagnostics to CI. Keep directories 0700
   and files 0600. Preserve a checksum and the exact active deployment request.
5. Replay retained schema-17 data and the old Worker with the shipped local verifier:

   ```sh
   pnpm test:legacy-snapshot /private/worker-snapshot /private/schema17-backup
   pnpm test:legacy-snapshot /private/worker-snapshot /private/schema17-backup .tmp/your-new-candidate
   ```

   Import uses Cloudflare's SQL-aware migration splitter. D1's newline-based
   `exec` cannot import this multiline SQL dump safely. These commands restore
   local native D1, apply migrations 18–32, verify original deployment fields,
   existing/invalid tokens and actual persisted heartbeat/metrics, and require
   zero outbound provider requests.
6. Before production writes, recheck the active Worker version, schema, original
   forwarder configuration/image/token and fresh heartbeat. Apply additive
   migrations from the audited candidate using Wrangler's remote migration
   command, with standard Cloudflare credentials supplied through the environment.
   Retain a private fsynced operation journal and the provider child's PID before
   allowing it to begin. Verify all 32 tracked migrations and the original
   forwarder fields afterward, while the old Worker still runs.
7. Build a private deployment config from the existing production `wrangler.toml`.
   Replace only `main`, asset directory and migration directory with audited export
   paths. Preserve production name, route, DB, queue producer/consumer and cron.
   Run `wrangler deploy --no-bundle --keep-vars --config /private/config.toml` with
   credentials in the environment, never in command arguments or committed files.
   Retain the child journal/log and do not restart an uncertain upload.
8. Observe the new active version and compare the actual downloaded main module,
   served index and each served asset against the audited bytes. Compare original
   bindings and all original forwarder fields except naturally changing heartbeat,
   metrics and update timestamps. Anonymous `/api/me` returns 200; the browser
   authentication path for `/api/deployments` returns the existing same-origin
   303 redirect with `error=auth_required`.
9. Observe a real heartbeat and real metrics sample advancing from the existing
   forwarder. Do not use injected production events as proof of this cycle.
   Complete separate live delivery and forwarder-manifest canaries before claiming
   the complete convergence goal is finished.

## Rollback

The retained private Worker snapshot includes the exact original version and this
[deployment request](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/):

```json
{"strategy":"percentage","versions":[{"version_id":"<captured original version>","percentage":100}]}
```

Send it to the known Worker's deployment endpoint with authorization held in
memory. First confirm the active version is the one being rolled back; refuse to
overwrite an unrelated actor's deployment. The new additive schema stays in place:
both the exact captured old Worker and new candidate passed native replay against
migrated production data. Never drop columns or restore the old SQL dump over live
traffic as an automatic rollback. Worker rollback does not roll back D1 storage.
The original forwarder image/configuration/token remain the baseline until its
separate upgrade captures and validates the physical runtime/checkpoint rollback.

## Completed observations

On October 3, 2026, the production migration journal reached `migrated`, and the
Worker journal reached `deployed`. Uploaded code, served site and binding checks
passed. A read-only anonymous probe initially expected 401 and stopped on the
normal 303 redirect; corrected observation completed without repeating the upload.
The live reporting check at `2026-10-03T08:02:17Z` confirms heartbeat and metrics
advance, nonnegative current totals, and unchanged original forwarder identity,
image, configuration and token. These observations do not yet prove live log
source-to-destination delivery or manifest-aware forwarder installation.
