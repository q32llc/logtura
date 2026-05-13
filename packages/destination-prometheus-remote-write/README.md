# @logtura/destination-prometheus-remote-write

Logtura destination driver for any Prometheus-compatible TSDB that accepts remote-write: Mimir, VictoriaMetrics, Thanos, Cortex, Prometheus with the remote_write receiver enabled, Grafana Cloud, etc.

```bash
npm install @logtura/destination-prometheus-remote-write @logtura/core
```

## Config

```ts
interface PrometheusRemoteWriteConfig {
  endpoint: string;             // https://prometheus.example.com/api/v1/write
  bearerToken: string | null;   // null if the endpoint is open
}
```

## What it emits

```yaml
sink_<id>:
  type: prometheus_remote_write
  inputs: [<metrics-stream>]
  endpoint: "${PROM_URL_<id>}"
  # When bearerToken is set:
  auth:
    strategy: bearer
    token: "${PROM_URL_<id>_TOKEN}"
```

Only consumes the `metrics` flow. Like the Datadog destination, wire this through `generateBundle({ metrics: { kind: "destination", ... } })`.

## License

[Apache 2.0](./LICENSE).
