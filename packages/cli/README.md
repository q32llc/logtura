# @logtura/cli

OSS command-line host for the Logtura renderer.

The CLI includes the current Logtura source drivers and destinations. It parses
a human-authored `logtura.yaml`, feeds the existing `@logtura/core` renderer,
and writes the same forwarder artifacts used by the hosted product:
`vector.yaml`, Dockerfile, `.env`, install script, and component manifest.

```sh
npm install -g @logtura/cli
```

## Commands

```sh
logtura validate -c logtura.yaml
logtura validate -c logtura.yaml --vector-validate
logtura bundle -c logtura.yaml -o dist/logtura-forwarder
logtura install-zip -c logtura.yaml -o logtura-forwarder.tgz
logtura stats --metrics metrics.json
```

- `validate` parses config and renders a bundle without writing files.
- `--vector-validate` writes a temporary generated config and runs
  `vector validate` if Vector is installed locally.
- `bundle` writes an unpacked self-hostable forwarder directory.
- `install-zip` writes a gzipped tarball containing the same files.
- `stats` reads Vector `internal_metrics` JSON/NDJSON and prints a simple
  component counter table.

## Config

Minimal Cloudflare Workers -> Slack config:

```yaml
sources:
  workers:
    provider: cloudflare-worker-tail
    account_id: env:CLOUDFLARE_ACCOUNT_ID
    api_token: env:CLOUDFLARE_API_TOKEN
    scripts:
      - dirtsignal
      - ipogrid

sinks:
  slack:
    type: slack
    webhook_url: env:SLACK_WEBHOOK_URL
    channel: "#alerts"

monitors:
  - name: worker-errors
    filter:
      - errors
      - rollup:
          window_secs: 30
          group_by: [script]
          max_samples: 5
    sinks: [slack]
```

`env:NAME` values are resolved from the local environment. Missing env values
are reported by `validate`; the command exits with code `2` after confirming
the rest of the config can render.

## Source Examples

Fly apps:

```yaml
sources:
  fly:
    provider: fly-log-tail
    account_id: personal
    api_token: env:FLY_API_TOKEN
    apps: [my-app]
```

Supabase Edge Functions and project gateway:

```yaml
sources:
  supabase:
    provider: supabase-edge-logs
    account_id: env:SUPABASE_PROJECT_REF
    pat: env:SUPABASE_PAT
    gateway: true
    functions:
      - slug: agent-chat
        function_id: 00000000-0000-0000-0000-000000000000
```

Cloudflare AI Gateway:

```yaml
sources:
  ai:
    provider: cloudflare-ai-gateway
    account_id: env:CLOUDFLARE_ACCOUNT_ID
    api_token: env:CLOUDFLARE_API_TOKEN
    gateways: [my-gateway]
```

## Output

`logtura bundle -o dist/logtura-forwarder` writes:

- `Dockerfile`
- `vector.yaml`
- `manifest.json`
- `.env`
- `install.sh`
- `README.md`

Run the generated forwarder with:

```sh
cd dist/logtura-forwarder
./install.sh
```

## Notes

The CLI is intentionally small. Hosted OAuth, managed Fly deploys, and
database-backed source discovery live in the SaaS host. The OSS CLI starts from
explicit config and environment variables.
