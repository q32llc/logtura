# Changelog

## 0.3.0 candidate

This is a coordinated release of all 15 public packages. It adds portable
configuration and shared backend operations while preserving independent CLI and
library use. Publication is complete only when the release workflow verifies every
tested archive in npm; a candidate commit is not a published release.

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
