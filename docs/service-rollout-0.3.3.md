# Service and package rollout 0.3.3

The immutable public [v0.3.3 release](https://github.com/logtura/logtura/releases/tag/v0.3.3)
publishes all 15 packages from `cfaf36e6`. Its [release run](https://github.com/logtura/logtura/actions/runs/37376821507)
passed archive publication, registry-integrity checks, installed consumers and release
creation. Protected PRs 18 and 19 merged after successful required checks; fresh,
fully paginated audits found no CodeRabbit reviews, comments or review threads.
The intentionally failing coverage PR remains closed without merging.

Private source `fc40b797` passed [CI](https://github.com/q32llc/logtura/actions/runs/37377325779).
The installed public suite passes 1,100 tests; the private backend suite passes
1,819 tests. Required CI exercises workerd/Miniflare, browser/installed CLI and actual
Vector flows. Coverage reports and thresholds are owned by the repositories;
no external coverage service or production Cloudflare credentials are needed in CI.

The service candidate consumes the actual 0.3.3 registry archives, not workspace
sources. Packed isolation, declaration consumers and native lifecycle checks pass.
Its compiled Worker digest is
`sha256:024d6d1be78186c2576e7909656e6e5a1aabbb4c757164500648afdfe9dd0e5b`.

A disposable real Fly canary using those registry packages and the published image
passed source-to-webhook delivery, persistent-checkpoint restart, new-manifest apply
and rollback. It verified the original production machine's configuration and
instance were unchanged. The canary machine, Worker and tail are deleted; volume
deletion is acknowledged with a detached `pending_destroy` record. Physical volume
absence is not claimed.

The image was published by [image CI](https://github.com/q32llc/logtura/actions/runs/37374679601)
from coordinated source `bf0f6b7`. Index digest
`sha256:dc4afa1bc65ac9443341412c6bf43ab2d890999e64c072147a5523c1816fe6a5`
resolves cryptographically to Linux amd64 digest
`sha256:b78e4a41a28595428766c3d0dcf20295386da9653455bcf4d5ad8f3310a3160e`.
Its actual runtime binary matches the versioned build and reports 0.3.3.

Disposable Cloudflare staging passed HTTPS lifecycle, legacy heartbeat/metrics,
and schema 17→36, then verified Worker, database and queue absence. Trigger
migrations require Wrangler's SQL-file import transport: the management `/query`
parser rejected valid trigger SQL that native SQLite accepts. Tests cover complete
SQL preservation and migration-history insertion. No uncertain import is replayed.

A fresh production schema-32 backup was captured at 22:10 UTC on October 5, 2026.
Native replay against both the captured active Worker and the actual-registry
candidate preserved all 833 application rows, all 25 application tables, complete
migration history and all 24 deployment fields after schema 36. Existing-token
heartbeat and metrics returned 204, an invalid token returned 401, foreign keys
passed, and no outbound provider requests were made.

Production schemas 33–36 were imported with a durable per-migration dispatch journal
and canonical history readback. At 22:16 UTC, all 36 migrations were present,
foreign keys passed and the original Worker and forwarder were stable. Production
0.3.3 was subsequently uploaded. Its exact Worker bytes, website index/assets and
existing bindings were verified. Natural persisted telemetry advanced at 22:20 UTC; original forwarder upgrade,
loaded-manifest acknowledgment, delivery,
rollback/cleanup and final restoration remain acceptance gates.

Rollback material is private: the exact prior Worker multipart payload and settings,
the schema-32 backup, original Fly image/configuration and retained apply/activation
journals. Native checks prove the prior Worker accepts schema 36. Forwarder recovery
must reuse the issued old artifact before moving to the new image; it must not
repeat the rejected in-place volume attachment or recreate the retained checkpoint.

The published 0.3.3 CLI subsequently recovered the retained 0.3.2 apply/activation
journals without reissuing the artifact or recreating the checkpoint. The mountless
legacy machine is stopped and retained; the exact journaled candidate is running.
The service accepted its loaded baseline manifest: desired and applied revision 2
match. Fly returned HTTP 412 during the first handoff; GET readback reconciled the
stopped candidate, and the saved handoff resumed successfully without another create.
The immutable 0.3.3 image update passed through the same published CLI. The
website shows desired/applied revision 2 in sync, retaining all 63 sources, one
monitor and one sink. Actual process Prometheus counters subsequently showed
three sources receiving traffic and the existing sink receiving and sending one
natural event. No synthetic Slack event was injected. This recovery closes the retained
journal and initial loaded-manifest gates; original real-delivery, explicit rollback,
cleanup and final restored-current-state checks remain open.

The production rollback preflight exposed a separate metadata-reader defect before
any rollback journal or provider mutation: a same-machine update preserves Fly's
mount `name`, `encrypted` and `size_gb` fields, but replacement validation rejected
that readback shape. The candidate remains running/current. The correction reuses
strict shared mount comparison, accepts only known valid decorations and rejects
unknown fields, wrong volume/path, false encryption and invalid size. Forty focused
replacement tests pass; the installed-CLI native provider fixture now decorates
mounts for the full update/rollback journey. That journey reproduced the defect
with the old compiled archives, then passed with rebuilt corrected archives:
legacy delivery, replacement/update/restart, immutable restoration, both cleanup
modes and fresh accepted delivery. Public [PR 20](https://github.com/logtura/logtura/pull/20)
contains the correction. A subsequent verified public release
is required before retrying original rollback through the published CLI.

The same production observation exposed an outdated legacy website warning despite
an accepted current manifest. The service correction clears it atomically only for
accepted current self-managed reports. Replayed/rejected reports, stale versions
and older revisions preserve the warning; managed jobs retain their separate
readiness/acceptance gate. Twenty-five focused native tests and the complete
1,828-test backend coverage run pass. This correction is not yet deployed.
