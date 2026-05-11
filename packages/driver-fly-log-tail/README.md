# @logtura/driver-fly-log-tail

Logtura provider driver for Fly.io. Tails `flyctl logs --json -a <app>` over Vector's `exec` source. One source per selected app.

```bash
npm install @logtura/driver-fly-log-tail @logtura/core
```

## Credentials

A Fly API token. Read-only is strongly recommended:

```sh
fly tokens create readonly -o <your-org>
```

The driver accepts both bare-bearer tokens (legacy) and `FlyV1 fm1r_.../fm2_...` macaroons. Tokens are revocable from the Fly dashboard.

## Usage

```ts
import { generateBundle } from "@logtura/core";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";

const orgs = await flyLogTailDriver.verifyCredentials({
  apiToken: process.env.FLY_API_TOKEN!,
});
const apps = await flyLogTailDriver.discoverSources({
  credentials: { apiToken: process.env.FLY_API_TOKEN! },
  accountId: orgs[0].id, // org slug
});

const bundle = generateBundle({
  providers: [flyLogTailDriver],
  destinations: [/* ... */],
  connections: [{
    connection: {
      id: "con_a", provider: "fly-log-tail",
      displayName: "prod", externalAccountId: orgs[0].id,
    },
    selectedSources: apps,
    credentials: { apiToken: process.env.FLY_API_TOKEN! },
  }],
  monitors: [/* ... */],
});
```

## Runtime requirements

The forwarder image needs `flyctl` installed and `jq` for compacting flyctl's pretty-printed JSON to single-line events. The driver's `runtimeSpec` returns the Dockerfile install line automatically.

## What it emits

Per selected app, one Vector `exec` source running:

```sh
stdbuf -oL flyctl logs --json -a <app> | jq -c --unbuffered --arg app <app> '. + {app: $app}'
```

`stdbuf -oL` is required. libc's default block-buffered stdio stalls events in flyctl's pipe until 4 KB accumulates. `--arg app ...` pre-injects the app name into each event so the driver-level normalize can set `.script` per source.

Fly's log stream only carries the stdio channel (stdout vs stderr). The application's semantic level is absent from the event. The normalize handles this by trying to parse the message body as structured JSON and preferring an embedded `level`, `severity`, or `lvl` field (pino, winston, bunyan, zap, Go slog, Rust tracing, GCP Logging) before falling back to Fly's stdio channel. As a result, `console.warn` does not get mis-flagged as an error when Node writes it to stderr.

## License

[Apache 2.0](./LICENSE).
