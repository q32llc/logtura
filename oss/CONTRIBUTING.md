# Contributing

The easiest contribution is a new driver. Most platforms with a CLI-based or HTTP-based log API map onto the existing driver shape in ~150 lines.

## Adding a provider driver

A provider driver is a single TypeScript object satisfying the `ProviderDriver<TCreds>` contract from `@logtura/core`. It does five things:

1. `verifyCredentials(creds)` — given a credential blob, return the accounts/orgs/projects the credential can reach. Used both by the hosted UI (to populate an account picker) and by anyone using the package standalone (to validate a token before generating a config).
2. `discoverSources({ credentials, accountId })` — given an account, list the log sources available (workers, apps, edge functions, …) as `DiscoveredSource[]`. Source `metadata` can carry anything the driver needs later — IDs, expiry hints, region.
3. `generateSourceBlock({ source, connection })` — emit one Vector source YAML block per selected source. Keys must be unique within a bundle; drivers consolidating multiple selections into one Vector component (Supabase-style) return the same key per connection, and the renderer dedupes.
4. `generateNormalize?({ inputKeys, connection, sources })` — emit a single Vector `remap` that flattens every source's events into the uniform shape `{ .script, .message, .level, .error, .timestamp }`. The hosted UI's monitors (`errors`, `level`, `match`, `rate_limit`, `dedup`, `sample`, `rollup`) operate on this shape.
5. `runtimeSpec(connection)` — declare the env vars the source needs at runtime (API tokens, account IDs) and any Dockerfile install steps. The renderer rolls these up into `bundle.envVars` and `bundle.dockerfile` so the forwarder image carries what it needs.

That's it. No form fields, no OAuth, no UI strings — those live in whatever hosting layer wraps the renderer.

The fastest path is to copy `packages/driver-fly-log-tail` (the smallest existing driver):

```sh
cp -r packages/driver-fly-log-tail packages/driver-railway-logs
# Rename inside: package.json, src/index.ts driver constant, test files.
# Replace the Fly-specific verify/discover/source/normalize/runtime logic.
```

Test it with `pnpm vitest run --project @logtura/driver-railway-logs`. Add a `test/vector-validate.test.ts` that pipes the generated bundle through `docker run timberio/vector:latest-debian validate` — every existing driver has one, and they're the only check that catches VRL syntax errors before deploy.

## Adding a destination driver

Similar shape, contracted on `DestinationDriver<TConfig>`. Three methods:

1. `generateSinkBundle({ config, inputs, sinkKey, envVarName })` — emit the Vector sink (and any pre-sink transforms that prep the event into the sink's expected shape, e.g. Slack's `{ "text": "…" }` body).
2. `runtimeEnvVars({ config, envVarName, displayName })` — declare the env vars the sink needs.
3. `envVarValue(config, envVarName)` — extract each env-var value from the typed config. The renderer iterates declared vars and asks the destination for each value.

Copy `packages/destination-webhook` as the smallest example.

## Naming

- **One driver per transport, not per vendor.** `cloudflare-worker-tail` and `cloudflare-ai-gateway` are separate drivers even though they share an API token, because they tail different things via different Vector source types. This keeps each driver narrow enough to reason about.
- Package id, displayName, sourceLabel all live in the driver const — no schema migrations needed to add a new driver.

## Tests

- `pnpm vitest run` — runs every package's tests + the root vitest projects.
- `pnpm typecheck` — across the whole workspace.
- Each driver needs a `test/unit.test.ts` (pure renderer + API client) and a `test/vector-validate.test.ts` (Docker-based black-box validate). The Docker test is skipped automatically when docker isn't available, so CI environments without docker access still pass the unit half.

## Submitting

Open a PR against `main`. The CI workflow at `.github/workflows/test.yml` runs the full test matrix on push + PR.

## License

Contributions are accepted under the [Apache 2.0](./LICENSE) license — same as the rest of the repo.
