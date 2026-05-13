# @logtura/core

Compose Vector configs from typed driver inputs. The renderer takes a typed input
(connections, selected sources, monitors, sinks, heartbeat and metrics targets)
and produces a complete `vector.yaml`, Dockerfile, env-var manifest, and
component manifest describing the pipeline.

Pure TypeScript. No I/O. Drivers (providers and destinations) plug in via small
contracts. This package is the renderer behind `@logtura/cli`.

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

## Provider Driver Contract

A provider driver is a single TypeScript object satisfying `ProviderDriver<TCreds>`:

```ts
{
  id: string;
  displayName: string;
  sourceLabel: string;
  capabilities: { selection: "all" | "list" | "both" };
  verifyCredentials(creds): Promise<ProviderAccount[]>;
  discoverSources({ credentials, accountId }): Promise<DiscoveredSource[]>;
  checkCredentialFreshness?(creds): Promise<{ fresh: boolean; reason?: string }>;
  generatePipeline({
    connection,
    selection,
  }): {
    components: VectorComponent[];
    outputKey: string;
    envVars: EnvVarSpec[];
    dockerfileDeps: DockerfileDep[];
    manifest?: ComponentManifestEntry[];
  };
}
```

`generatePipeline` owns the driver's whole internal subgraph. Simple drivers can
emit one Vector source per selected source. Multiplexed drivers can emit one
transport plus per-logical-source filters and merge transforms. The renderer
only wires the returned `outputKey` into downstream monitor/sink transforms.

A destination driver is similar. `DestinationDriver<TConfig>` declares
`generateSinkBundle`, `runtimeEnvVars`, and `envVarValue`.

Form schemas, OAuth flows, and `FormData` parsing are intentionally not part of this contract. The CLI supplies plain typed inputs from `logtura.yaml`.

## Logtura Event Shape

Provider drivers normalize raw platform payloads into `LogturaEvent`:

```ts
import type { LogturaEvent } from "@logtura/core";
```

Every normalized event should have `.message`, `.level`, and `.error`.
Drivers should also populate source context such as `.timestamp` and `.script`
when the provider exposes it. The renderer adds `.logtura_connection_id`,
`.logtura_provider`, and `.logtura_received_at` after the driver output.

Errors should preserve structured context with `.error_reason` and
`.exceptions` where available. Provider-specific raw fields may remain on the
event unless a driver intentionally drops them.

## Related packages

- [@logtura/driver-cloudflare-worker-tail](../driver-cloudflare-worker-tail). Cloudflare Workers Tail API over Vector's exec source.
- [@logtura/driver-cloudflare-ai-gateway](../driver-cloudflare-ai-gateway). Cloudflare AI Gateway logs via http_client.
- [@logtura/driver-fly-log-tail](../driver-fly-log-tail). `flyctl logs --json` over Vector's exec source.
- [@logtura/driver-supabase-edge-logs](../driver-supabase-edge-logs). Supabase Edge Functions via the analytics API.
- [@logtura/driver-vercel-logs](../driver-vercel-logs). Vercel Runtime Logs via the REST API.
- [@logtura/custom-vector](../custom-vector). Bring-your-own Vector source, transform, and sink fragments.
- [@logtura/destination-slack](../destination-slack). Incoming-webhook.
- [@logtura/destination-webhook](../destination-webhook). Generic HTTPS POST.
- [@logtura/destination-datadog-metrics](../destination-datadog-metrics)
- [@logtura/destination-prometheus-remote-write](../destination-prometheus-remote-write)

## Status

`0.2.x`. Packages currently ship raw TypeScript sources. Consumers need a
TS-aware toolchain such as `tsx`, Bun, Vite, Webpack with ts-loader, or esbuild.
Compiled `.js` + `.d.ts` distribution is still on the roadmap.

## License

[Apache 2.0](./LICENSE).
