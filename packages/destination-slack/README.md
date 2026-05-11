# @logtura/destination-slack

Logtura destination driver for Slack incoming-webhooks. Emits a Vector pipeline that coerces each matched event into Slack's expected `{ "text": "..." }` body shape and POSTs it to the configured webhook URL.

```bash
npm install @logtura/destination-slack @logtura/core
```

## Config

```ts
interface SlackConfig {
  webhookUrl: string;       // https://hooks.slack.com/services/T.../B.../...
  teamName: string | null;  // optional, label only
  channel: string | null;   // optional, label only
}
```

`webhookUrl` is a Slack Incoming Webhook URL. Get one at [api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks): create or pick a Slack app in your workspace, enable Incoming Webhooks, click "Add New Webhook to Workspace", pick a channel. Slack returns a URL of the shape `https://hooks.slack.com/services/T.../B.../...`.

`teamName` and `channel` are optional labels. The driver does not use them at runtime. They are useful if you want to display "which Slack workspace and channel does this sink post to?" in your own UI.

## Usage

```ts
import { slackDriver } from "@logtura/destination-slack";

// Pass to generateBundle({ destinations: [slackDriver], ... }).
// In the sink, set destinationConfig to a SlackConfig.
```

## What it emits

A pre-sink `remap` plus an `http` sink:

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

The `framing: newline_delimited` plus `max_events: 1` combo is load-bearing. Slack's incoming-webhook endpoint expects a top-level JSON OBJECT per request and 400s on a JSON ARRAY. Vector's `codec: json` defaults to wrapping a batch as an array, so each event has to be its own request.

The fallback `if msg == "" { msg = "(empty .message) " + encode_json(.) }` exists because Slack rejects `{ "text": "" }` with `no_text` 400. Upstream normalizers should produce non-empty messages. This is the last line of defense.

## License

[Apache 2.0](./LICENSE).
