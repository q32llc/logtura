# @logtura/driver-supabase-edge-logs

Logtura provider driver for Supabase Edge Functions. Polls the Management API's analytics endpoint (`GET /v1/projects/<ref>/analytics/endpoints/logs.all`) over Vector's `http_client` source. Same SQL the Supabase dashboard runs under the hood.

**One poll per connection**, regardless of how many functions are selected. The analytics endpoint rate-limits hard. The driver pulls every edge-function event for the project and the normalize remap routes by `function_id` against a codegen-time UUID-to-slug map.

```bash
npm install @logtura/driver-supabase-edge-logs @logtura/core
```

## Credentials

A Supabase Personal Access Token, issued at [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens). These are **full-account scope**. Supabase does not offer per-project PATs yet, so treat the token like a password and revoke it from the dashboard when you are done.

## Usage

```ts
import { generateBundle } from "@logtura/core";
import { supabaseEdgeLogsDriver } from "@logtura/driver-supabase-edge-logs";

const projects = await supabaseEdgeLogsDriver.verifyCredentials({
  pat: process.env.SUPABASE_PAT!,
});
const functions = await supabaseEdgeLogsDriver.discoverSources({
  credentials: { pat: process.env.SUPABASE_PAT! },
  accountId: projects[0].id, // project ref
});

const bundle = generateBundle({
  providers: [supabaseEdgeLogsDriver],
  destinations: [/* ... */],
  connections: [{
    connection: {
      id: "con_a", provider: "supabase-edge-logs",
      displayName: "askthe prod", externalAccountId: projects[0].id,
    },
    selectedSources: functions,
    credentials: { pat: process.env.SUPABASE_PAT! },
  }],
  monitors: [/* ... */],
});
```

## Runtime requirements

None beyond Vector itself. The `http_client` source is built in.

## What it emits

One Vector `http_client` source per connection, polling every 30s with a 90s lookback window (3x overlap; downstream `dedup` by event id drops duplicates).

The normalize remap unwraps Logflare's `{ result: { result: [...] } }` envelope and per-record:
- Maps `function_id` (UUID) to the human slug via a codegen-time dict. Drops events for functions not in the selected set.
- Derives `.level` from `.status_code` (>=500 becomes error, >=400 becomes warn, else info). Supabase does not surface a semantic level on the invocation summary, so the HTTP response is the strongest signal.
- Converts the microsecond `timestamp` to milliseconds.
- Prefixes `.message` with `[<slug>]` so non-rollup monitors still ship tagged events.

## License

[Apache 2.0](./LICENSE).
