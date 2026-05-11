# @logtura/destination-webhook

Logtura destination driver for arbitrary HTTPS webhooks. POSTs each matched event as JSON to whatever URL you configure. Works with Discord, n8n, Better Stack's HTTP source, a Cloudflare Worker, or anything that accepts a POST.

```bash
npm install @logtura/destination-webhook @logtura/core
```

## Config

```ts
interface WebhookConfig {
  url: string;  // https only
}
```

## What it emits

```yaml
sink_<id>:
  type: http
  inputs: [<upstream>]
  uri: "${WEBHOOK_URL_<id>}"
  method: post
  encoding: { codec: json }
  batch: { max_events: 50, timeout_secs: 5 }
```

Up to 50 events per request, batched on a 5s flush. Events ship in Vector's default schema. Your endpoint receives the full normalized event (`.message`, `.level`, `.error`, `.script`, `.timestamp`, plus any driver-specific fields).

## License

[Apache 2.0](./LICENSE).
