# @logtura/driver-cloudflare-worker-tail

Logtura provider driver for Cloudflare Workers. Tails selected Workers with `logtura-cf-tail` over Vector's `exec` source. The output has the same shape as `wrangler tail --format json`, but is consumed by Vector for routing into your monitors and sinks.

Captures the full tail event: console output, exception stack traces, request outcome, response status, dispatched event metadata. Cloudflare Logpush only ships request envelopes. The in-function `console.log` and stack traces are not in Logpush. This driver uses the Tail API directly so you get the debugging context.

```bash
npm install @logtura/driver-cloudflare-worker-tail @logtura/core
```

## Credentials

A Cloudflare API token with:
- **Workers Scripts: Read**. Lets the driver discover which workers exist.
- **Workers Tail: Read**. Lets the driver tail them.

Create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).

## Usage

```ts
import { generateBundle } from "@logtura/core";
import { cloudflareWorkerTailDriver } from "@logtura/driver-cloudflare-worker-tail";

const accounts = await cloudflareWorkerTailDriver.verifyCredentials({
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
});
const sources = await cloudflareWorkerTailDriver.discoverSources({
  credentials: { apiToken: process.env.CLOUDFLARE_API_TOKEN! },
  accountId: accounts[0].id,
});

const bundle = generateBundle({
  providers: [cloudflareWorkerTailDriver],
  destinations: [/* ... */],
  connections: [{
    connection: {
      id: "con_a", provider: "cloudflare-worker-tail",
      displayName: "prod", externalAccountId: accounts[0].id,
    },
    selectedSources: sources,
    credentials: { apiToken: process.env.CLOUDFLARE_API_TOKEN! },
  }],
  monitors: [/* ... */],
});
```

## Runtime requirements

The forwarder image needs the small `logtura-cf-tail` binary. The driver's runtime spec returns the Dockerfile `COPY --from=ghcr.io/logtura/logtura-cf-tail:...` line automatically.

## What it emits

One Vector `exec` source per Cloudflare connection, running:

```sh
logtura-cf-tail --config /tmp/logtura-cf-tail-<connection>.toml
```

The helper opens one Cloudflare Tail API WebSocket per selected Worker inside a single process, merges the event stream to stdout as newline-delimited JSON, and reconnects/refreshes tail sessions as needed. A driver-level `remap` then flattens the CF tail event into the uniform `{ .script, .message, .level, .error, .timestamp }` shape downstream filters can rely on. Console output, exceptions, and outcome all feed `.level` and `.error` so monitors with `kind: "errors"` catch what you expect.

## License

[Apache 2.0](./LICENSE).
