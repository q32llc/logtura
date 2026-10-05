# Persistent local production smoke access rollout

On October 5, 2026, private source `489a385103dcb5879ea334069fe462119d0b5554`
passed [exact-commit CI 37344600868](https://github.com/q32llc/logtura/actions/runs/37344600868).
This service-only change consumes the same fifteen published npm 0.3.2 packages;
the immutable public release is unchanged. CI uses local workerd/Miniflare and
owned coverage reports, without Cloudflare credentials.

The full local baseline passed 1,716 backend/package tests and UI coverage gates.
Backend coverage is 97.51% lines, 97.13% statements, 94.61% branches and 98.91%
functions. UI coverage is 94.97%, 93.81%, 90.75% and 96.53%, respectively.
CI also passed installed CLI/browser/workerd journeys, native transports,
package/service isolation and the 95% changed-executable-line gate.

The actual-registry service artifact is privately retained at
`.tmp/service-smoke-489a385`. Its Worker SHA-256 is
`a1390f0a67aee9252f1e5467df84636dacdc60fc7810f356b39d0d1f5421e828`.
Package archive identities match the original immutable 0.3.2 release. Native D1
lifecycle, missing-core-entry rejection, service types and website assets passed.

The current production Worker and website were captured before upload at
`.tmp/production-rollbacks/run-PrqzSa`; both served assets matched the earlier
verified artifact. Fresh schema-32 backup `.tmp/production-backups/run-ojHn1X`
contains 685,384 bytes and SHA-256
`3d52a83e674f77c8bf815bf26c3c7b319c4a4d0da0a7aa17993399e818cd1ae0`.
Local Miniflare replay against the candidate and captured rollback preserved all
24 deployment fields, existing heartbeat/metrics authorization, foreign keys and
wide counters, with no outbound provider requests or production mutation.
No migrations were added or applied.

The single-dispatch rollout ledger is `.tmp/production-deployments/run-BVLQi6`.
Upload was acknowledged at **17:21:46.769 UTC**. Deployment
`f11a53d6-1200-4ea5-8b55-d08e49bdc755` serves version
`6e93cbcc-157f-49fa-9c9e-177ec2468548` at 100%. Actual Worker, website index and
both asset hashes matched, bindings and stable deployment fields were preserved,
and a natural checkpoint at **17:26:44.276 UTC** advanced after upload. Final
verification completed at **17:26:54.161 UTC**. No heartbeat was manufactured.

The user-authorized `local-production-smoke` grant was approved through the normal
website session and issued by the published CLI. The deployed **Keep until revoked**
action was then explicitly selected for that client. The website displayed
**Does not expire; revoke to remove access**, and a read of the exact token hash's
server row verified its persistent lifetime before updating the private local file.
The plaintext token remains only in `.local/logtura/production-smoke.json`, mode
0600 in a mode-0700 directory, outside Git and CI artifacts. The published 0.3.2
CLI accepted the saved credential and identified the existing account.

`pnpm smoke:production` passes with that credential. It uses only GET requests and
reports liveness separately from loaded configuration: the original legacy forwarder
is running, but `configurationCurrent` remains false with no applied manifest.
The separate temporary `convergence-canary-20261005` client was revoked through the
published CLI; its local credential was removed and its former bearer was rejected
with HTTP 401. Private persistence and revocation receipts remain locally available.

See the [operator guide](production-smoke-testing.md) and
[current acceptance index](convergence-acceptance.md). The original mountless
forwarder still needs retained-machine replacement/loaded-manifest and rollback
validation after its rejected in-place volume attachment. That is an implementation
and rollout task, not a missing account-access approval.
