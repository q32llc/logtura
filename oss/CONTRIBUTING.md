# Contributing

The easiest contribution is a new driver. Most platforms with a CLI-based or HTTP-based log API map onto the existing driver shape in around 150 lines.

## Adding a provider driver

A provider driver is a single TypeScript object satisfying the `ProviderDriver<TCreds>` contract from `@logtura/core`. It does five things:

1. `verifyCredentials(creds)` returns the accounts, orgs, or projects the credential can reach. Lets consumers validate a token before generating a config and pick which account to target.
2. `discoverSources({ credentials, accountId })` lists the log sources available for a given account (workers, apps, edge functions, etc.) as `DiscoveredSource[]`. Source `metadata` can carry anything the driver needs later: IDs, expiry hints, region.
3. `generateSourceBlock({ source, connection })` emits one Vector source YAML block per selected source. Keys must be unique within a bundle. Drivers that consolidate multiple selections into one Vector component (Supabase-style) return the same key per connection, and the renderer deduplicates.
4. `generateNormalize?({ inputKeys, connection, sources })` emits a single Vector `remap` that flattens every source's events into the uniform shape `{ .script, .message, .level, .error, .timestamp }`. The renderer's filter steps (`errors`, `level`, `match`, `rate_limit`, `dedup`, `sample`, `rollup`) operate on this shape.
5. `runtimeSpec(connection)` declares the env vars the source needs at runtime (API tokens, account IDs) and any Dockerfile install steps. The renderer rolls these up into `bundle.envVars` and `bundle.dockerfile` so the forwarder image carries what it needs.

Form fields, OAuth flows, and UI copy live in whatever hosting layer wraps the renderer. They are not part of the driver contract.

The fastest path is to copy `packages/driver-fly-log-tail`, which is the smallest existing driver:

```sh
cp -r packages/driver-fly-log-tail packages/driver-railway-logs
# Rename inside: package.json, src/index.ts driver constant, test files.
# Replace the Fly-specific verify/discover/source/normalize/runtime logic.
```

Test with `pnpm vitest run --project @logtura/driver-railway-logs`. Add a `test/vector-validate.test.ts` that pipes the generated bundle through `docker run timberio/vector:latest-debian validate`. Every existing driver has one. It is the only check that catches VRL syntax errors before deploy.

## Adding a destination driver

Similar shape, contracted on `DestinationDriver<TConfig>`. Three methods:

1. `generateSinkBundle({ config, inputs, sinkKey, envVarName })` emits the Vector sink plus any pre-sink transforms that prep the event into the sink's expected shape (Slack's `{ "text": "..." }` body, for example).
2. `runtimeEnvVars({ config, envVarName, displayName })` declares the env vars the sink needs.
3. `envVarValue(config, envVarName)` extracts each env-var value from the typed config. The renderer iterates declared vars and asks the destination for each value.

Copy `packages/destination-webhook` as the smallest example.

## Naming

One driver per transport. `cloudflare-worker-tail` and `cloudflare-ai-gateway` are separate drivers even though they share an API token, because they tail different surfaces via different Vector source types. This keeps each driver narrow enough to reason about.

Package id, displayName, and sourceLabel all live in the driver const. Adding a new driver does not require schema migrations.

## Tests

- `pnpm vitest run` runs every package's tests plus the root vitest projects.
- `pnpm typecheck` runs across the whole workspace.
- Each driver needs a `test/unit.test.ts` (pure renderer + API client) and a `test/vector-validate.test.ts` (docker-based black-box validate). The docker test is skipped automatically when docker is not available, so CI environments without docker access still pass the unit half.

## Submitting

Open a PR against `main`. The CI workflow at `.github/workflows/test.yml` runs the full test matrix on push and PR.

## License

Contributions are accepted under the [Apache 2.0](./LICENSE) license.
