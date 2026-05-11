# @logtura/core

Compose Vector configs from structured driver inputs. The renderer takes a typed input — connections + selected sources + monitors + sinks + heartbeat/metrics targets — and produces a complete `vector.yaml`, a Dockerfile fragment, an env-var manifest, and a component manifest describing the pipeline.

Pure TypeScript, no I/O. Drivers (providers + destinations) plug in via small contracts; this package is the renderer they feed.

```bash
npm install @logtura/core @logtura/driver-fly-log-tail @logtura/destination-slack
```

## Usage

```ts
import { generateBundle } from "@logtura/core";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { slackDriver } from "@logtura/destination-slack";

const sources = await flyLogTailDriver.discoverSources({
  credentials: { apiToken: process.env.FLY_API_TOKEN! },
  accountId: "my-org",
});

const bundle = generateBundle({
  providers: [flyLogTailDriver],
  destinations: [slackDriver],
  connections: [
    {
      connection: {
        id: "con_a",
        provider: "fly-log-tail",
        displayName: "prod",
        externalAccountId: "my-org",
      },
      selectedSources: sources,
      credentials: { apiToken: process.env.FLY_API_TOKEN! },
    },
  ],
  monitors: [
    {
      monitor: {
        id: "mon_errors",
        connectionId: null,
        displayName: "errors → slack",
        filterSteps: [{ kind: "errors" }],
        enabled: true,
      },
      sinks: [
        {
          sink: { id: "snk_a", filterSteps: [] },
          destination: { id: "dst_a", kind: "slack", displayName: "alerts" },
          destinationConfig: {
            webhookUrl: process.env.SLACK_WEBHOOK_URL!,
            teamName: null,
            channel: null,
          },
        },
      ],
    },
  ],
});

// bundle.vectorYaml      — the full vector.yaml
// bundle.dockerfile      — Dockerfile lines for a forwarder image
// bundle.runCommand      — the `vector --config …` invocation
// bundle.envVars         — { name, description, source, value, … }[]
// bundle.componentManifest — primary + plumbing components for a UI
```

## Driver contract

A provider driver is a single TypeScript object satisfying `ProviderDriver<TCreds>`:

```ts
{
  id: string;
  displayName: string;
  sourceLabel: string;                                // friendly UI noun
  verifyCredentials(creds): Promise<ProviderAccount[]>;
  discoverSources({ credentials, accountId }): Promise<DiscoveredSource[]>;
  generateSourceBlock({ source, connection }): SourceBlock;
  generateNormalize?({ inputKeys, connection, sources }): { key, yaml } | null;
  runtimeSpec(connection): { envVars, dockerfileDeps };
}
```

A destination driver is similar — `DestinationDriver<TConfig>` with `generateSinkBundle`, `runtimeEnvVars`, `envVarValue`.

No form schemas, no OAuth flows, no `FormData` parsing. Those live host-side in whatever app is rendering a UI on top of the renderer.

## What's around it

- [@logtura/driver-cloudflare-worker-tail](../driver-cloudflare-worker-tail) — `wrangler tail` over Vector's exec source
- [@logtura/driver-cloudflare-ai-gateway](../driver-cloudflare-ai-gateway) — Cloudflare AI Gateway logs via http_client
- [@logtura/driver-fly-log-tail](../driver-fly-log-tail) — `flyctl logs --json` over Vector's exec source
- [@logtura/driver-supabase-edge-logs](../driver-supabase-edge-logs) — Supabase Edge Functions via the analytics API
- [@logtura/destination-slack](../destination-slack) — incoming-webhook
- [@logtura/destination-webhook](../destination-webhook) — generic HTTPS POST
- [@logtura/destination-datadog-metrics](../destination-datadog-metrics)
- [@logtura/destination-prometheus-remote-write](../destination-prometheus-remote-write)

## Status

`0.1.0`. The renderer + the driver contract are stable enough that the hosted product at logtura.com runs on them; the public release is the same code, no fork.

Packages currently ship raw TypeScript sources. Consumers need a TS-aware toolchain (Bun, tsx, Vite, Webpack + ts-loader, esbuild, etc.) — compiled `.js` + `.d.ts` distribution is on the roadmap for `0.2.0`.

## License

[Apache 2.0](./LICENSE).
