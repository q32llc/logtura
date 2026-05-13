# Contributing

The easiest contribution is a new driver. Most platforms with a CLI-based or HTTP-based log API map onto the existing driver shape in around 150 lines.

## Adding a provider driver

A provider driver is a single TypeScript object satisfying the `ProviderDriver<TCreds>` contract from `@logtura/core`. It does four things:

1. `verifyCredentials(creds)` returns the accounts, orgs, or projects the credential can reach. Lets consumers validate a token before generating a config and pick which account to target.
2. `discoverSources({ credentials, accountId })` lists the log sources available for a given account (workers, apps, edge functions, etc.) as `DiscoveredSource[]`. Source `metadata` can carry anything the driver needs later: IDs, expiry hints, region.
3. `generatePipeline({ connection, selection })` emits the driver's complete Vector subgraph: sources, transforms, `outputKey`, env vars, Dockerfile deps, and optional component manifest rows. Simple drivers can emit one source per selected app. Multiplexed drivers can emit one transport plus per-logical-source filter transforms.
4. `checkCredentialFreshness?(creds)` optionally lets hosts detect stale stored credentials before generating/deploying a bundle.

Every driver's `outputKey` should produce the uniform event shape `{ .script, .message, .level, .error, .timestamp }`. The renderer's filter steps (`errors`, `level`, `match`, `rate_limit`, `dedup`, `sample`, `rollup`) operate on that shape.

Form fields, OAuth flows, and UI copy live in whatever hosting layer wraps the renderer. They are not part of the driver contract.

The fastest path is to copy `packages/driver-fly-log-tail`, which is the smallest existing driver:

```sh
cp -r packages/driver-fly-log-tail packages/driver-railway-logs
# Rename inside: package.json, src/index.ts driver constant, test files.
# Replace the Fly-specific verify/discover/generatePipeline logic.
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

## Releasing

Every package shares one version. To cut a release:

```sh
node scripts/bump-oss.mjs 0.X.Y   # in the private monorepo
# commit, sync to logtura/logtura, push main
cd ../logtura-public
git tag v0.X.Y
git push origin v0.X.Y
```

That tag push fires `.github/workflows/release.yml`. The workflow runs the full test matrix, publishes every `@logtura/*` package to npm via OIDC trusted publishing (no long-lived token to rotate), and creates the GitHub release with auto-generated notes from the commits since the previous tag. No manual `pnpm publish`, no OTP prompt.

Each `@logtura/*` package needs a trusted publisher configured on npmjs.com pointing at this repo's `release.yml`. To add a new package to the workspace: publish it once interactively (`pnpm publish --access public --otp=...`), then configure trusted publishing with:

```sh
npm trust github @logtura/<package> --repo logtura/logtura --file release.yml
```

From then on it ships through the workflow.

## License

Contributions are accepted under the [Apache 2.0](./LICENSE) license.
