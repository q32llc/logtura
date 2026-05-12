# @logtura/core

Compose Vector configs from typed driver inputs. The renderer takes a typed input (connections, selected sources, monitors, sinks, heartbeat and metrics targets) and produces a complete `vector.yaml`, a Dockerfile fragment, an env-var manifest, and a component manifest describing the pipeline.

Pure TypeScript. No I/O. Drivers (providers and destinations) plug in via small contracts. This package is the renderer they feed.

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
        displayName: "errors to slack",
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

// bundle.vectorYaml          the full vector.yaml
// bundle.dockerfile          Dockerfile lines for a forwarder image
// bundle.runCommand          the `vector --config ...` invocation
// bundle.envVars             { name, description, source, value, ... }[]
// bundle.componentManifest   primary + plumbing components for a UI
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

A destination driver is similar. `DestinationDriver<TConfig>` declares `generateSinkBundle`, `runtimeEnvVars`, and `envVarValue`.

Form schemas, OAuth flows, and `FormData` parsing are intentionally not part of this contract. They live host-side in whatever app is rendering a UI on top of the renderer.

## Related packages

- [@logtura/driver-cloudflare-worker-tail](../driver-cloudflare-worker-tail). Cloudflare Workers Tail API over Vector's exec source.
- [@logtura/driver-cloudflare-ai-gateway](../driver-cloudflare-ai-gateway). Cloudflare AI Gateway logs via http_client.
- [@logtura/driver-fly-log-tail](../driver-fly-log-tail). `flyctl logs --json` over Vector's exec source.
- [@logtura/driver-supabase-edge-logs](../driver-supabase-edge-logs). Supabase Edge Functions via the analytics API.
- [@logtura/destination-slack](../destination-slack). Incoming-webhook.
- [@logtura/destination-webhook](../destination-webhook). Generic HTTPS POST.
- [@logtura/destination-datadog-metrics](../destination-datadog-metrics)
- [@logtura/destination-prometheus-remote-write](../destination-prometheus-remote-write)

## Status

`0.1.0`. The renderer and driver contract surface area will continue to change as more platforms get added.

Packages currently ship raw TypeScript sources. Consumers need a TS-aware toolchain such as Bun, tsx, Vite, Webpack with ts-loader, or esbuild. Compiled `.js` + `.d.ts` distribution is on the roadmap for `0.2.0`.

## License

[Apache 2.0](./LICENSE).
