# logtura

Logtura builds [Vector](https://vector.dev) forwarders for platform logs:
Cloudflare Workers, Fly apps, Supabase Edge Functions, Cloudflare AI Gateway,
and common destinations such as Slack, webhooks, Datadog metrics, and
Prometheus remote-write.

The easiest OSS entry point is the CLI:

```bash
npm install -g @logtura/cli
logtura validate -c logtura.yaml
logtura bundle -c logtura.yaml -o dist
logtura install-zip -c logtura.yaml -o logtura-forwarder.tgz
```

The CLI includes the current Logtura drivers and destinations. Under the hood
it parses `logtura.yaml`, calls `@logtura/core`, and writes `vector.yaml`,
Dockerfile, env manifest, and component manifest artifacts.

## logtura.yaml

Minimal Cloudflare Workers -> Slack example:

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

Useful commands:

```bash
# Parse config and render a bundle in memory.
logtura validate -c logtura.yaml

# Also ask local Vector to validate the generated vector.yaml.
logtura validate -c logtura.yaml --vector-validate

# Write Dockerfile, vector.yaml, .env, install.sh, README.md, manifest.json.
logtura bundle -c logtura.yaml -o dist/logtura-forwarder

# Write a gzipped self-install archive.
logtura install-zip -c logtura.yaml -o logtura-forwarder.tgz

# Print a simple component table from Vector internal_metrics JSON/NDJSON.
logtura stats --metrics metrics.json
```

`env:NAME` values are resolved from the local environment. `validate` exits
with code `2` when required env vars are missing, after confirming the config
and renderer path are otherwise valid.

## Packages

| Package | What it does |
| --- | --- |
| [@logtura/cli](./packages/cli) | OSS CLI: config parser, validation, bundle/archive generation, simple stats |
| [@logtura/core](./packages/core) | Renderer: typed input to Vector YAML, Dockerfile, env-var manifest |
| [@logtura/driver-cloudflare-worker-tail](./packages/driver-cloudflare-worker-tail) | Cloudflare Workers Tail API via `logtura-cf-tail` |
| [@logtura/driver-cloudflare-ai-gateway](./packages/driver-cloudflare-ai-gateway) | Cloudflare AI Gateway logs via Vector `http_client` |
| [@logtura/driver-fly-log-tail](./packages/driver-fly-log-tail) | `flyctl logs --json -a <app>` per Fly app |
| [@logtura/driver-supabase-edge-logs](./packages/driver-supabase-edge-logs) | Supabase Edge Function runtime logs + project HTTP gateway logs |
| [@logtura/destination-slack](./packages/destination-slack) | Slack incoming-webhook |
| [@logtura/destination-webhook](./packages/destination-webhook) | Generic HTTPS POST |
| [@logtura/destination-datadog-metrics](./packages/destination-datadog-metrics) | Datadog metrics intake |
| [@logtura/destination-prometheus-remote-write](./packages/destination-prometheus-remote-write) | Mimir, VictoriaMetrics, Grafana Cloud, Prometheus remote-write receiver |
| [@logtura/cloudflare-shared](./packages/cloudflare-shared) | Shared CF API-token plumbing |
| [@logtura/supabase-shared](./packages/supabase-shared) | Shared Supabase Management API plumbing |

## Library Usage

If you are embedding Logtura in another tool, call the renderer directly:

```bash
npm install @logtura/core @logtura/driver-fly-log-tail @logtura/destination-slack
```

```ts
import { generateBundle } from "@logtura/core";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { slackDriver } from "@logtura/destination-slack";

const bundle = generateBundle({
  providers: [flyLogTailDriver],
  destinations: [slackDriver],
  connections: [
    {
      connection: {
        id: "con_prod",
        provider: "fly-log-tail",
        displayName: "prod",
        externalAccountId: "personal",
      },
      selectedSources: [
        {
          id: "src_app",
          externalId: "my-app",
          displayName: "my-app",
          sourceKind: "fly_app",
          metadata: null,
        },
      ],
      credentials: { apiToken: process.env.FLY_API_TOKEN! },
    },
  ],
  monitors: [
    {
      monitor: {
        id: "mon_errors",
        connectionId: null,
        displayName: "errors to slack",
        filterSteps: [{ kind: "errors" }],
        enabled: true,
      },
      sinks: [
        {
          sink: { id: "snk_slack", filterSteps: [] },
          destination: { id: "dst_slack", kind: "slack", displayName: "alerts" },
          destinationConfig: {
            webhookUrl: process.env.SLACK_WEBHOOK_URL!,
            teamName: null,
            channel: "#alerts",
          },
        },
      ],
    },
  ],
});

console.log(bundle.vectorYaml);
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm vitest run
```

Driver packages include unit tests and Docker-backed `vector validate` tests.
The Docker tests use `timberio/vector:latest-debian` and skip when Docker is
not available.

## Status

`0.2.x`. Packages currently ship raw TypeScript sources. Consumers need a
TS-aware runtime or bundler such as `tsx`, Bun, Vite, Webpack with ts-loader,
or esbuild. Compiled `.js` + `.d.ts` output is still on the roadmap.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache 2.0](./LICENSE).
