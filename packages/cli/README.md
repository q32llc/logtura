# @logtura/cli

OSS command-line host for the Logtura renderer.

```sh
logtura validate -c logtura.yaml
logtura bundle -c logtura.yaml -o dist
logtura install-zip -c logtura.yaml -o logtura-forwarder.tgz
logtura stats --metrics metrics.json
```

The CLI uses the same `@logtura/core` renderer and driver packages as
the SaaS product. The config parser is the CLI-specific layer.

Minimal `logtura.yaml`:

```yaml
sources:
  workers:
    account_id: env:CLOUDFLARE_ACCOUNT_ID
    api_token: env:CLOUDFLARE_API_TOKEN
    scripts: [dirtsignal, ipogrid]

sinks:
  slack:
    type: slack
    webhook_url: env:SLACK_WEBHOOK_URL

monitors:
  - name: errors-rollup
    filter:
      - errors
      - rollup:
          window_secs: 30
          group_by: [script]
          max_samples: 5
    sinks: [slack]
```
