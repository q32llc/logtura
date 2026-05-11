# @logtura/driver-cloudflare-worker-tail

Logtura provider driver for Cloudflare Workers. Tails `wrangler tail <script> --format json` over Vector's `exec` source — same shape as `wrangler tail` in your terminal, but consumed by Vector for routing into your monitors and sinks.

Captures the full tail event: console output, exception stack traces, request outcome, response status, dispatched event metadata. (Cloudflare Logpush only ships request envelopes, not the in-function `console.log` / stack traces; this driver uses the Tail API directly so you get the debugging context.)

```bash
npm install @logtura/driver-cloudflare-worker-tail @logtura/core
```

## Credentials

A Cloudflare API token with:
- **Workers Scripts: Read** — to discover which workers exist
- **Workers Tail: Read** — to tail them

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
  destinations: [/* … */],
  connections: [{
    connection: {
      id: "con_a", provider: "cloudflare-worker-tail",
      displayName: "prod", externalAccountId: accounts[0].id,
    },
    selectedSources: sources,
    credentials: { apiToken: process.env.CLOUDFLARE_API_TOKEN! },
  }],
  monitors: [/* … */],
});
```

## Runtime requirements

The forwarder image needs `node` + `wrangler` installed. The driver's `runtimeSpec` returns the Dockerfile install lines automatically.

## What it emits

Per selected worker, one Vector `exec` source running:

```sh
wrangler tail <script> --format json | jq -c --unbuffered .
```

A driver-level `remap` then flattens the CF tail event into the uniform `{ .script, .message, .level, .error, .timestamp }` shape downstream filters can rely on. Console output, exceptions, and outcome all feed `.level` and `.error` so monitors with `kind: "errors"` catch what you'd expect.

## License

[Apache 2.0](./LICENSE).
