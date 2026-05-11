# @logtura/destination-datadog-metrics

Logtura destination driver for Datadog's metrics intake. Forwards Vector internal metrics (events processed, sink delivery rates, errors per pipeline) to your Datadog account via Vector's native `datadog_metrics` sink.

```bash
npm install @logtura/destination-datadog-metrics @logtura/core
```

## Config

```ts
interface DatadogMetricsConfig {
  apiKey: string;  // issued in Datadog → Organization Settings → API Keys
  site: string;    // datadoghq.com (default), datadoghq.eu, us3.datadoghq.com, etc.
}
```

## What it emits

```yaml
sink_<id>:
  type: datadog_metrics
  inputs: [<metrics-stream>]
  default_api_key: "${DATADOG_API_KEY_<id>}"
  site: "datadoghq.com"
```

Only consumes the `metrics` flow — i.e. wire this through `generateBundle({ metrics: { kind: "destination", destination: …, destinationConfig: … } })`, not through a log monitor's sinks.

## License

[Apache 2.0](./LICENSE).
