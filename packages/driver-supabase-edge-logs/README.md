# @logtura/driver-supabase-edge-logs

Logtura provider driver for Supabase Edge Functions and the project HTTP
gateway. Polls the Management API's analytics endpoint
(`GET /v1/projects/<ref>/analytics/endpoints/logs.all`) over Vector's
`http_client` source. Same SQL family the Supabase dashboard runs under the
hood.

The driver exposes two selectable surfaces:

- one source per Edge Function runtime log stream (`function_edge_logs`)
- one synthetic `Project HTTP gateway` source for inbound HTTP (`edge_logs`)

Function runtime logs are multiplexed through one poller per connection, then
split into per-function metric rows after normalization. Gateway logs use a
separate poller because they come from a different table.

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
const sources = await supabaseEdgeLogsDriver.discoverSources({
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
    selectedSources: sources,
    credentials: { pat: process.env.SUPABASE_PAT! },
  }],
  monitors: [/* ... */],
});
```

## Runtime requirements

None beyond Vector itself. The `http_client` source is built in.

## What It Emits

For function runtime logs:

- one `http_client` or refresh-sidecar `exec` source per connection
- one normalize transform mapping `function_id` UUIDs to selected slugs
- per-function filter transforms so Vector metrics can show throughput per selected function

For project gateway logs:

- one `http_client` or refresh-sidecar `exec` source
- one normalize transform that derives surface from the HTTP path (`rest`, `auth`, `storage`, `functions`, etc.)

The normalize remaps unwrap Supabase's real `{ result: [...] }` envelope and:
- Drop unselected function events in list mode.
- In all-selection mode, tag unknown function IDs with the UUID.
- For function runtime logs, infer `.level` from `event_message` text because `function_edge_logs` does not expose HTTP status.
- For gateway logs, infer `.level` from `status_code` (>=500 error, >=400 warn, else info).
- Converts the microsecond `timestamp` to milliseconds.
- Prefixes `.message` with `[<script>]` so non-rollup monitors still ship tagged events.

## License

[Apache 2.0](./LICENSE).
