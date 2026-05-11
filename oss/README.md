# logtura

Compose [Vector](https://vector.dev) configs from typed driver inputs.

Each `@logtura/driver-*` package wraps one platform's log API (Cloudflare Workers tail, Fly app logs, Supabase Edge Functions, etc.) and emits the Vector source and normalize transform that turns its events into a uniform `{ .script, .message, .level, .error, .timestamp }` shape. Each `@logtura/destination-*` package emits the corresponding Vector sink (Slack incoming-webhook, HTTPS webhook, Datadog metrics, Prometheus remote-write).

`@logtura/core` is the renderer that ties them together. Given a typed input (connections, selected sources, monitors, sinks, heartbeat and metrics targets), it returns a complete `vector.yaml`, a Dockerfile fragment, an env-var manifest, and a component manifest describing the pipeline.

## Packages

| Package | What it does |
| --- | --- |
| [@logtura/core](./packages/core) | Renderer: typed input to Vector YAML, Dockerfile, env-var manifest |
| [@logtura/driver-cloudflare-worker-tail](./packages/driver-cloudflare-worker-tail) | `wrangler tail <script> --format json` per worker |
| [@logtura/driver-cloudflare-ai-gateway](./packages/driver-cloudflare-ai-gateway) | Cloudflare AI Gateway logs via http_client poll |
| [@logtura/driver-fly-log-tail](./packages/driver-fly-log-tail) | `flyctl logs --json -a <app>` per Fly app |
| [@logtura/driver-supabase-edge-logs](./packages/driver-supabase-edge-logs) | Supabase Edge Functions via the analytics API |
| [@logtura/destination-slack](./packages/destination-slack) | Slack incoming-webhook |
| [@logtura/destination-webhook](./packages/destination-webhook) | Generic HTTPS POST |
| [@logtura/destination-datadog-metrics](./packages/destination-datadog-metrics) | Datadog metrics intake |
| [@logtura/destination-prometheus-remote-write](./packages/destination-prometheus-remote-write) | Mimir, VictoriaMetrics, Grafana Cloud, self-hosted Prometheus |
| [@logtura/cloudflare-shared](./packages/cloudflare-shared) | Shared CF API token plumbing, used by the cloudflare-* drivers |
| [@logtura/supabase-shared](./packages/supabase-shared) | Shared Supabase Management API plumbing |

## Quick start

```bash
npm install @logtura/core @logtura/driver-fly-log-tail @logtura/destination-slack
```

```ts
import { generateBundle } from "@logtura/core";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { slackDriver } from "@logtura/destination-slack";

const orgs = await flyLogTailDriver.verifyCredentials({
  apiToken: process.env.FLY_API_TOKEN!,
});
const apps = await flyLogTailDriver.discoverSources({
  credentials: { apiToken: process.env.FLY_API_TOKEN! },
  accountId: orgs[0].id,
});

const bundle = generateBundle({
  providers: [flyLogTailDriver],
  destinations: [slackDriver],
  connections: [{
    connection: {
      id: "con_a", provider: "fly-log-tail",
      displayName: "prod", externalAccountId: orgs[0].id,
    },
    selectedSources: apps,
    credentials: { apiToken: process.env.FLY_API_TOKEN! },
  }],
  monitors: [{
    monitor: {
      id: "mon_errors", connectionId: null,
      displayName: "errors to slack",
      filterSteps: [{ kind: "errors" }],
      enabled: true,
    },
    sinks: [{
      sink: { id: "snk_a", filterSteps: [] },
      destination: { id: "dst_a", kind: "slack", displayName: "alerts" },
      destinationConfig: {
        webhookUrl: process.env.SLACK_WEBHOOK_URL!,
        teamName: null, channel: null,
      },
    }],
  }],
});

// Write bundle.vectorYaml and bundle.dockerfile to wherever your
// forwarder picks them up. Each entry in bundle.envVars carries
// the resolved value the forwarder needs.
```

## Status

`0.1.0`. The driver and renderer surface area will continue to change as more platforms get added (Railway, Render, Heroku, AWS CloudWatch are queued).

Packages currently ship raw TypeScript sources. Consumers need a TS-aware toolchain (Bun, tsx, Vite, Webpack with ts-loader, esbuild). Compiled `.js` + `.d.ts` distribution is on the roadmap.

## Adding a driver

See [CONTRIBUTING.md](./CONTRIBUTING.md). The fastest path is to copy an existing driver (start with `packages/driver-fly-log-tail`, which is the smallest), rename, and implement the five methods.

## License

[Apache 2.0](./LICENSE).
