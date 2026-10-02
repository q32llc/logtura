# logtura

This repository is the hosted Logtura control plane plus the OSS package
workspace.

The hosted app lets a user connect log sources, choose monitors and sinks,
generate Vector forwarder bundles, deploy managed Fly Machines forwarders, and
inspect Vector internal metrics. The OSS packages under `packages/` contain the
renderer, drivers, destinations, and CLI that can be synced to
`github.com/logtura/logtura`.

## Main Surfaces

- Hosted SaaS app: Hono on Cloudflare Workers, React/Mantine/Vite UI, D1,
  Queues, managed Fly deploy jobs.
- OSS renderer: `@logtura/core`.
- OSS drivers/destinations: `@logtura/driver-*`, `@logtura/destination-*`.
- OSS CLI: `@logtura/cli`, parsing `logtura.yaml` into the same renderer input
  the SaaS builds from D1 rows.

## Development

```bash
pnpm install
pnpm build:packages
pnpm dev
```

`pnpm dev` runs Vite on port 5173 and Wrangler on port 8787. Vite proxies API
routes to Wrangler.

First-time local setup:

```bash
pnpm db:create
pnpm db:migrate:local
```

Make sure `.dev.vars` contains:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`
- `CREDENTIAL_ENCRYPTION_KEY`

The GitHub OAuth app must allow:

```text
http://localhost:8787/auth/github/callback
```

## Tests

```bash
pnpm typecheck
pnpm test
pnpm test:workerd
pnpm test:drivers
pnpm test:destinations
```

The full test suite includes workerd integration tests, package unit tests, and
Docker-backed Vector validation tests where available.

CI enforces Vitest's coverage thresholds and our own 95% changed-executable-line
gate. Each Actions run publishes a coverage summary and a `coverage` artifact
containing HTML, LCOV, and JSON reports, retained for 14 days. Reports inherit
repository access; no external coverage service or credential is needed.
To check a local baseline after generating backend and UI coverage, run
`node scripts/coverage-report.mjs --report coverage --report coverage/ui --base <commit>`.

## Deploy SaaS

```bash
pnpm run deploy
```

This builds the Vite app and deploys the Cloudflare Worker.

When generated Vector topology or runtime Docker deps change, also redeploy the
affected managed forwarder so the running machine picks up the new bundle.

## OSS CLI

Example config is in [example.yml](./example.yml):

```bash
CLOUDFLARE_ACCOUNT_ID=acct \
CLOUDFLARE_API_TOKEN=token \
SLACK_WEBHOOK_URL=https://hooks.slack.test/x \
pnpm tsx packages/cli/src/main.ts validate -c example.yml
```

Generate an unpacked local forwarder:

```bash
pnpm tsx packages/cli/src/main.ts bundle -c example.yml -o dist/logtura-forwarder
```

## OSS Sync

The public OSS repo is a sibling checkout, synced one-way for now:

```bash
scripts/sync-oss.sh --commit-message-file /tmp/logtura-oss-release.md
```

That copies `oss/` root files and mirrors `packages/` into
`../logtura-public`. Forwarder container assets are generated from package
sources during the private image build, not checked into the public OSS repo.
Until the first real external OSS PR, this is the accepted sync mechanism.
The commit message file is required because GitHub release notes are generated
from public repo history; write it as a release-note-grade summary, not a
generic sync or version-bump message.

## Release Notes

Every OSS package shares one version. Release flow:

```bash
node scripts/bump-oss.mjs 0.X.Y
pnpm install
git add packages/*/package.json pnpm-lock.yaml
git commit -m "Bump OSS packages to 0.X.Y"
cat >/tmp/logtura-oss-release.md <<'EOF'
Release v0.X.Y

Added:
- ...

Changed:
- ...

Fixed:
- ...
EOF
scripts/sync-oss.sh --commit-message-file /tmp/logtura-oss-release.md
cd ../logtura-public
pnpm install
pnpm -r typecheck
pnpm vitest run
git add .
git commit -F .git/logtura-oss-commit-message
git push origin main
git tag v0.X.Y
git push origin v0.X.Y
```

The public tag runs `.github/workflows/release.yml`, which publishes via npm
Trusted Publishing and creates the GitHub release.

## Package artifact validation

Public packages ship JavaScript and declarations. Build them before running
Node-based development commands or packaging a release:

```sh
pnpm build:packages
pnpm test:packed
```

The packed consumer check installs all tarballs outside the workspace, invokes
both CLI aliases, validates and generates a standalone bundle with outbound
fetch disabled, and imports every public package in ordinary Node. The service
production build also builds these package artifacts. Tests use the development
export condition so coverage continues measuring package source.

The website suite includes native workerd API lifecycle tests alongside browser
component interactions. Build the packages and website assets first:

```sh
pnpm build
pnpm test:ui:coverage
```

Coverage includes all website TypeScript source and enforces at least 93%
statements, 90% branches, 95% functions and 94% lines, with stricter file gates.
Native tests use a disposable local database, session and explicit provider
fixtures; they require no production credentials. The full installed CLI,
browser and Docker forwarder journey runs separately with `pnpm test:e2e:local`.
