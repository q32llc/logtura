# @logtura/destination-slack

Logtura destination driver for Slack incoming-webhooks. Emits a Vector pipeline that coerces each matched event into Slack's expected `{ "text": "…" }` body shape and POSTs it to the configured webhook URL.

```bash
npm install @logtura/destination-slack @logtura/core
```

## Config

```ts
interface SlackConfig {
  webhookUrl: string;       // https://hooks.slack.com/services/T.../B.../...
  teamName: string | null;  // optional, captured from the OAuth callback
  channel: string | null;   // optional, captured from the OAuth callback
}
```

In the hosted product, `webhookUrl` is captured via Slack's OAuth2 redirect flow (`slack.com/oauth/v2/authorize` → exchange code for `incoming_webhook.url`). Standalone consumers can paste a webhook URL directly.

## Usage

```ts
import { slackDriver } from "@logtura/destination-slack";

// In a generateBundle({ destinations: [slackDriver], … }) call.
// The sink's destinationConfig is the SlackConfig above.
```

## What it emits

A pre-sink `remap` + an `http` sink:

```yaml
sink_<id>_format:
  type: remap
  inputs: [<upstream>]
  source: |-
    msg = string(.message) ?? ""
    if msg == "" { msg = "(empty .message) " + encode_json(.) }
    . = { "text": msg }

sink_<id>:
  type: http
  inputs: ["sink_<id>_format"]
  uri: "${SLACK_WEBHOOK_URL_<id>}"
  method: post
  encoding: { codec: json }
  framing: { method: newline_delimited }
  batch: { max_events: 1, timeout_secs: 5 }
```

The `framing: newline_delimited` + `max_events: 1` combo is load-bearing — Slack's incoming-webhook endpoint expects a top-level JSON OBJECT per request and 400s on a JSON ARRAY. Vector's `codec: json` defaults to wrapping a batch as an array, so each event has to be its own request.

The fallback `if msg == "" { msg = "(empty .message) " + encode_json(.) }` exists because Slack rejects `{ "text": "" }` with `no_text` 400. Upstream normalizers should produce non-empty messages, but this is the last line of defense.

## License

[Apache 2.0](./LICENSE).
