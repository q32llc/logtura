# logtura

Compose [Vector](https://vector.dev) configs from typed driver inputs. One package per platform we know how to tail (Cloudflare Workers, Fly, Supabase Edge Functions, …); one package per destination we know how to ship to (Slack, generic HTTPS webhook, Datadog metrics, Prometheus remote-write); a renderer that wires them together into a runnable Vector pipeline.

Drivers are small TypeScript files satisfying a narrow contract: `verifyCredentials`, `discoverSources`, `generateSourceBlock`, `generateNormalize`, `runtimeSpec`. No framework, no form schemas, no UI assumptions. The hosted product at [logtura.com](https://logtura.com) runs on these same packages; this repo is the same code with no fork.

## Packages

| Package | What it does |
| --- | --- |
| [@logtura/core](./packages/core) | Renderer: typed input → Vector YAML + Dockerfile + env-var manifest |
| [@logtura/driver-cloudflare-worker-tail](./packages/driver-cloudflare-worker-tail) | `wrangler tail <script> --format json` per worker |
| [@logtura/driver-cloudflare-ai-gateway](./packages/driver-cloudflare-ai-gateway) | Cloudflare AI Gateway logs via http_client poll |
| [@logtura/driver-fly-log-tail](./packages/driver-fly-log-tail) | `flyctl logs --json -a <app>` per Fly app |
| [@logtura/driver-supabase-edge-logs](./packages/driver-supabase-edge-logs) | Supabase Edge Functions via the analytics API |
| [@logtura/destination-slack](./packages/destination-slack) | Slack incoming-webhook |
| [@logtura/destination-webhook](./packages/destination-webhook) | Generic HTTPS POST |
| [@logtura/destination-datadog-metrics](./packages/destination-datadog-metrics) | Datadog metrics intake |
| [@logtura/destination-prometheus-remote-write](./packages/destination-prometheus-remote-write) | Mimir / VictoriaMetrics / Grafana Cloud / self-hosted Prom |
| [@logtura/cloudflare-shared](./packages/cloudflare-shared) | Shared CF token plumbing (used by the cloudflare-* drivers) |
| [@logtura/supabase-shared](./packages/supabase-shared) | Shared Supabase Management API plumbing |

## Why this exists

Most logging products are either expensive (Datadog, Splunk) or check-the-box (Cloudflare Logpush ships request envelopes — `method`, `status`, `outcome` — but not the `console.log` output or stack traces that make a log useful for debugging). Logtura's drivers go after the tail/streaming APIs that carry the actual debugging context, normalize them into a uniform shape, and let you route events into the destinations you already use.

If you've got a handful of side projects scattered across Cloudflare, Fly, Supabase, Railway, etc., you probably don't want to set up a Datadog account per side project. You want one place to point them all, and you want to know when something errors. Each `@logtura/driver-*` is one platform you no longer have to think about.

## Quick start (standalone)

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
      displayName: "errors → slack",
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

// Write bundle.vectorYaml + bundle.dockerfile somewhere your forwarder picks up.
// Each entry in bundle.envVars carries the resolved value the forwarder needs.
```

## Quick start (hosted)

Skip the bring-your-own-forwarder plumbing — sign up at [logtura.com](https://logtura.com), connect your accounts through the UI, pick monitors + sinks, click Deploy. The hosted product builds the same bundle this package would and runs it on Fly Machines, Cloud Run, or your own infra.

## Status

`0.1.0`. Driver contract + renderer + the four existing drivers and four destinations are stable enough to run the hosted product on. Expect breakage in the driver/renderer surface as we add more platforms (Railway, Render, Heroku, AWS CloudWatch are queued).

Packages currently ship raw TypeScript sources — consumers need a TS-aware toolchain (Bun, tsx, Vite, Webpack + ts-loader, esbuild). Compiled `.js` + `.d.ts` distribution is on the roadmap.

## Adding a driver

See [CONTRIBUTING.md](./CONTRIBUTING.md). The fastest path is to copy an existing driver (start with `packages/driver-fly-log-tail` — it's the smallest), rename, and implement the five methods.

## License

[Apache 2.0](./LICENSE).
