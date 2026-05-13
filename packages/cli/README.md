# @logtura/cli

OSS command-line tool for the Logtura renderer.

The CLI includes the current Logtura source drivers and destinations. It parses
a human-authored `logtura.yaml`, feeds the existing `@logtura/core` renderer,
and writes complete forwarder artifacts: `vector.yaml`, Dockerfile, `.env`,
install script, and component manifest.

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

Vercel Runtime Logs:

```yaml
sources:
  vercel:
    provider: vercel-logs
    # Optional for team-owned projects.
    team_id: env:VERCEL_TEAM_ID
    api_token: env:VERCEL_API_TOKEN
    projects:
      - prj_xxx
```

Custom Vector source and sink:

```yaml
sources:
  bob:
    provider: custom-vector
    display_name: Bob
    vector:
      include: ./vector/bob.yaml
      feed: bob_norm

sinks:
  joe:
    type: custom-vector
    vector:
      include: ./vector/joe.yaml

monitors:
  - name: bob-to-joe
    filter: [errors]
    sinks: [joe]
```

`bob.yaml` may define `sources` and `transforms`; `feed` names the component
Logtura reads from. `joe.yaml` may define `transforms` and `sinks`; Logtura
rewrites its single dangling input reference to the monitor output. Set
`vector.input` when the sink graph has more than one dangling input.

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

The CLI starts from explicit config and environment variables. It validates,
bundles, and installs a local forwarder from `logtura.yaml`.
