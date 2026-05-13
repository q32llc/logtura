# @logtura/driver-railway-logs

Railway environment log source driver for Logtura.

The runtime tailer opens one GraphQL WebSocket subscription per selected
Railway environment using `environmentLogs(anchorDate, afterDate, afterLimit)`.
Events are demultiplexed by `tags.serviceId`, so one helper process can cover
multiple selected services in the same environment.

```yaml
sources:
  railway:
    provider: railway-logs
    api_token: env:RAILWAY_API_TOKEN
    environment_id: env:RAILWAY_ENVIRONMENT_ID
    services:
      - 3f42c93d-db5c-4d21-8d8c-063b0fca4a53
```
