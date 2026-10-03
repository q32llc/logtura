# Changelog

## 0.3.1 — Fly volume mount acknowledgments

Fly adds `name`, `encrypted` and `size_gb` metadata to a volume mount after
creating a machine. The shared backend now accepts these provider additions
while checking every requested setting, mount order, volume identity and path.
Previously, a successfully started forwarder could be reported as a failed
creation because its returned mount object contained these fields.

Fly's acknowledged updates may briefly return the previous configuration.
Apply stops the machine under its lease, verifies its configuration again,
then installs with automatic launch disabled. It observes the installed
configuration and quiescent state for a bounded interval before starting once. It never replays
the write or starts during a pending transition. Direct `update` calls keep
their original launch default; recovery still starts a settled stopped machine.

Requested environment and runtime files still match exactly. Unknown mount
settings, unencrypted metadata, invalid sizes, and changed explicit metadata
remain rejected. Provider-shaped creation and negative mutation tests cover
the change. The package family is coordinated at 0.3.1; the 0.3.0 artifacts
remain immutable.

## 0.3.0

This is a coordinated release of all 15 public packages. It adds portable
configuration and shared backend operations while preserving independent CLI and
library use. All 15 packages are published on npm with their exact tested archive
hashes verified. The immutable release and receipts are available at
[GitHub](https://github.com/logtura/logtura/releases/tag/v0.3.0). Hosted-service
deployment and existing-forwarder upgrade remain separate staged rollouts.

- Ship built JavaScript and TypeScript declarations with explicit package exports,
  both `logt` and `logtura` executables, and the `logt-forwarder` runtime executable.
  Ordinary consumers do not need a TypeScript loader or monorepo checkout.
- Add versioned portable configurations, canonical hashes, stable logical IDs,
  graph editing, credential references and safe configuration/link transactions.
- Add optional website account login, deployment pull/diff/push, revision-conflict
  handling, account-token storage/revocation and resumable linked Fly deployment.
  Linked features require a compatible Logtura service. Standalone configuration,
  discovery, rendering, validation and deployment continue to work without it.
- Share provider discovery/verification, bundle/runtime assets, metrics parsing
  and deployment operations between public packages and the hosted backend.
- Add applied-manifest reports tied to loaded configuration, instance identity
  and checkpoint state, with durable retry and recovery behavior. Existing
  heartbeat/metrics payloads remain compatible with the service adapters.
- Add public Fly operations for guarded replacement, rollback and retired-machine
  cleanup with durable journals, provider leases and checkpoint-volume checks.
  Cleanup preserves checkpoint volumes and refuses unresolved provider outcomes.
- Expand Cloudflare, Railway, Vercel, Supabase and custom Vector provider fixtures,
  runtime streaming/delivery tests, and typed filter and routing validation.
- Support user-owned and account-owned Cloudflare tokens with verified owner,
  status and expiry handling, bounded fallback, and Node/Workers request parity.
- Validate installed tarballs outside the workspace, ordinary JavaScript and
  strict TypeScript consumers, CLI aliases and standalone execution. Real runtime
  gates cover generated Vector topologies and Bun streaming helpers.
- Enforce owned CI coverage floors and changed-line coverage; publish HTML,
  LCOV and JSON reports as Actions artifacts. No external coverage service is
  required.
- Publish exact consumer-tested archives with clean commit and SHA-512 evidence,
  dependency ordering, immutable-version collision detection and resumable partial
  publication. The hosted service is separately tested against those same bytes.

Node 22 or newer is required. Generated runtime validation remains pinned to
Vector 0.55.0. See [the CLI documentation](packages/cli/README.md) for supported
commands and [the release runbook](RELEASING.md) for publication and recovery.
Service migration and the existing production forwarder upgrade are separate
rollouts; this package candidate does not change production configuration.
