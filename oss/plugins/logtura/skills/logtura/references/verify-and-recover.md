# Delivery verification and recovery

Use a unique marker in a harmless event from the selected resource. Record its
time and source identity. Confirm it at the intended destination; when changing
filters, also emit a nonmatching event and confirm the exclusion policy.

Inspect source ingestion, transform errors/discards, and sink delivery counters.
`logtura stats --metrics FILE` reads Vector internal-metrics JSON/NDJSON, not an
arbitrary Prometheus text file or a hosted metrics URL. Never infer delivery from
a build, a healthy process, or a sink counter without connecting it to the test.

Common failures:

- **Missing environment variable:** `env --check` and `validate` identify the
  missing reference. Fill it privately; keep public config as a reference.
- **Permission or expiry failure:** inspect the provider recipe's credential scope
  and reverify access. A native CLI login may not be a durable forwarder token.
- **Discovery failed:** don't replace existing selections with an empty catalog.
  Correct the credential/account scope and reconnect.
- **No matching event:** check source selection, Railway environment identity,
  Vercel production deployment, Supabase function/gateway kind, and filters.
- **Sink failure:** check destination URL, authentication, response and retries.
  Preserve the event buffer/checkpoint when fixing configuration.
- **Push conflict:** inspect remote diff and current revision before reconciling.
- **Interrupted operation:** inspect `config status`; recover local writes with
  `config recover`, push with `push --resume`, and linked Fly apply with
  `deploy fly --resume`. Use rollback/cleanup only for their recorded target and
  phase; do not improvise machine deletion or repeat deployment creation.

If credentials, host entitlements, or target tooling are unavailable, still
validate the config and generated artifact, then report the specific unverified
live step. Provider fixture tests demonstrate protocol behavior, not a particular
user account's production permissions.
