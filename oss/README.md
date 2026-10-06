# logtura

Logtura builds [Vector](https://vector.dev) forwarders for platform logs:
Cloudflare Workers, Fly apps, Railway services, Vercel runtime logs, Supabase Edge Functions, Cloudflare AI Gateway,
and common destinations such as Slack, webhooks, Datadog metrics, and
Prometheus remote-write.

The easiest OSS entry point is the CLI:

```bash
npm install -g @logtura/cli
logtura validate -c logtura.yaml
logtura bundle -c logtura.yaml -o dist
```

The CLI includes the current Logtura drivers and destinations. Under the hood
it parses `logtura.yaml`, calls `@logtura/core`, and writes `vector.yaml`,
Dockerfile, env manifest, and component manifest artifacts.

## logtura.yaml

Minimal standalone Cloudflare Workers → webhook example:

```yaml
providers:
  cloudflare:
    provider: cloudflare
    account_id: env:CLOUDFLARE_ACCOUNT_ID
    credentials:
      api_token: env:CLOUDFLARE_API_TOKEN
sources:
  workers:
    source: cloudflare-worker-tail
    provider: cloudflare
    scripts: [my-worker]
sinks:
  alerts:
    sink: webhook
    url: env:ALERT_URL
monitors:
  - name: errors
    source: workers
    sinks: [alerts]
    filter: [errors]
```

Set the referenced variables privately, then validate and bundle. No Logtura
website account is needed. `logtura init` and `logtura connect cloudflare` can
scaffold an installation and discover available resources.

## Claude Code and Codex

Install the [Logtura skill](AGENT_SKILLS.md) to guide project setup, supported-host
onboarding, standalone forwarding, or website-linked CLI updates. One portable
instruction package is distributed through both clients' native plugin installers.
It includes delivery verification and preserves existing deployment identities.


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

## Build and verify release artifacts

```sh
pnpm install
pnpm build
pnpm test:packed
pnpm test
```

Packages publish ordinary JavaScript and TypeScript declarations. The CLI has
compiled `logt` and `logtura` executables and requires Node 22 or newer.
`test:packed` installs every package tarball outside the workspace and checks
standalone CLI generation with outbound fetch disabled, plus normal Node imports.

CI enforces aggregate and module coverage thresholds plus a 95% changed-line
gate. Each Actions run includes a coverage summary and a downloadable `coverage`
artifact with HTML, LCOV, and JSON reports, retained for 14 days. No external
coverage service is required. To check a local baseline, run
`pnpm test:coverage`, then
`node scripts/coverage-report.mjs --report coverage --base <commit>`.
