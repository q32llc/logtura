# logtura v0

Multi-provider log forwarder control plane. v0 covers: GitHub sign-in,
add a Cloudflare connection, discover Workers + AI Gateways, pick
sources, generate a Vector + Dockerfile bundle the user runs themselves.

## Stack

- Hono on Cloudflare Workers (API)
- React + Mantine + Vite (UI)
- D1 (SQLite) for users, connections, discovered sources
- React Router for client routing
- Vector for the generated forwarder

## Provider model

The whole point of the abstraction is that adding a new provider (Fly,
AWS, Supabase, …) is a single new file under `src/providers/`. See
`src/providers/types.ts` for the `ProviderDriver` contract; each driver
owns:

1. Form fields shown when adding a connection
2. Parsing those fields into a credential shape
3. Verifying credentials against the upstream API
4. Discovering log sources
5. Emitting Vector source-block YAML for each selected source
6. Declaring runtime env vars and Dockerfile install steps

The control plane does not branch on `provider === "cloudflare"` anywhere.
If you're tempted to do that, push the logic onto the driver instead.

## First-time setup

```bash
pnpm install

# 1. Create the D1 database (one-time). Copy the printed database_id
#    into wrangler.toml under [[d1_databases]].
pnpm db:create

# 2. Apply migrations to the local D1.
pnpm db:migrate:local

# 3. Make sure .dev.vars has GITHUB_CLIENT_ID/SECRET, SESSION_SECRET,
#    and CREDENTIAL_ENCRYPTION_KEY set. (.dev.vars is git-ignored.)
#    The GitHub OAuth app must register
#    http://localhost:8787/auth/github/callback as a callback URL.
```

## Dev

```bash
pnpm dev
```

Runs Vite (port 5173, with HMR) and Wrangler (port 8787) concurrently.
Vite proxies `/api`, `/login`, `/auth`, `/logout` to Wrangler.

Visit http://localhost:5173 for the dev experience with hot reload.

## Build & deploy

```bash
pnpm build       # vite build → ./dist
pnpm deploy      # vite build + wrangler deploy
```

Wrangler serves `./dist` as static assets and runs the Worker for the
API routes. SPA fallback is configured so client-side routes resolve to
`index.html`.

## Schema

See `migrations/0001_init.sql`. Provider-agnostic shape:

- `users` — one row per GitHub identity
- `connections` — one row per linked provider account; `provider` is a
  string id (e.g. "cloudflare"), `credentials_encrypted` is an opaque
  AES-GCM blob holding the JSON-serialized credential object the driver
  defined
- `log_sources` — one row per discovered source; `source_kind` is
  driver-namespaced (e.g. `cf_worker`, `cf_ai_gateway`); `selected`
  drives whether the source goes into the generated config

Adding a new provider does not require schema changes.

## Adding a Cloudflare connection

After signing in, click "Add connection" and paste a Cloudflare API
token with permissions to read:

- Account → Workers Scripts (Read)
- Account → AI Gateway (Read), if you use it

Account ID auto-detects from the token's accessible accounts. Submit;
discovery runs immediately.

## Generated forwarder bundle

From a connection's detail page, click "Generate Dockerfile" — get a
`Dockerfile`, a `vector.yaml`, the `docker run` command, and the env
var spec (which the driver produces). Save the files into a directory
and:

```bash
docker build -t logtura-forwarder .
docker run --rm \
  -e CLOUDFLARE_API_TOKEN="<token>" \
  -e CLOUDFLARE_ACCOUNT_ID="<account-id>" \
  logtura-forwarder
```

Logs stream to stdout as JSON. Add a Vector sink (HTTP, S3, Loki, etc.)
in `vector.yaml` to point at your destination of choice.

## What v0 does NOT do

- No anomaly detection (that's the `logtura-novelty` track).
- No deploy automation — you build and run the container yourself.
- No destinations UX yet; Vector output is stdout.
- Only Cloudflare as a provider.
- No team accounts; everything is per-user.

These are deferred deliberately. See
`log-source-forwarder-product.md` for the full roadmap.
