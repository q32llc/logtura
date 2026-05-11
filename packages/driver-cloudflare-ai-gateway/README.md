# @logtura/driver-cloudflare-ai-gateway

Logtura provider driver for Cloudflare AI Gateway. Polls `GET /accounts/<id>/ai-gateway/gateways/<gw>/logs` over Vector's `http_client` source. One source per selected gateway, 30s poll cadence.

```bash
npm install @logtura/driver-cloudflare-ai-gateway @logtura/core
```

## Credentials

A Cloudflare API token with **AI Gateway: Read** scoped to the account that owns the gateway. Create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).

## Usage

```ts
import { generateBundle } from "@logtura/core";
import { cloudflareAiGatewayDriver } from "@logtura/driver-cloudflare-ai-gateway";

const accounts = await cloudflareAiGatewayDriver.verifyCredentials({
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
});
const gateways = await cloudflareAiGatewayDriver.discoverSources({
  credentials: { apiToken: process.env.CLOUDFLARE_API_TOKEN! },
  accountId: accounts[0].id,
});

const bundle = generateBundle({
  providers: [cloudflareAiGatewayDriver],
  destinations: [/* ... */],
  connections: [{
    connection: {
      id: "con_a", provider: "cloudflare-ai-gateway",
      displayName: "prod", externalAccountId: accounts[0].id,
    },
    selectedSources: gateways,
    credentials: { apiToken: process.env.CLOUDFLARE_API_TOKEN! },
  }],
  monitors: [/* ... */],
});
```

## What it emits

Per selected gateway, one Vector `http_client` source polling Cloudflare's AI Gateway logs endpoint. The driver's normalize maps the response (`provider`, `model`, `status_code`, `success`) into the uniform `{ .script, .message, .level, .error }` shape. `.level` becomes `error` when `!success || status >= 500`. `.script` is the gateway's provider slug (`openai`, `anthropic`, and similar).

## Runtime requirements

None beyond Vector itself. The `http_client` source is built in.

## License

[Apache 2.0](./LICENSE).
