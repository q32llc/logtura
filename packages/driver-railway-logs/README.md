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

Selections retain both environment and service identity. Selecting the same
service in production and staging creates independent routes; logs from one
environment do not enter the other's route. Discovered sources include
`environment_id` and `service_id` metadata for this purpose.

The package baseline covers authentication/discovery HTTP contracts, executes
the emitted tail helper with explicit WebSocket/token-broker fixtures, and runs
the generated normalization/routing transforms with Vector 0.55.0. These fixtures
do not establish live Railway log delivery or OAuth grants. See the official
[Railway API documentation](https://docs.railway.com/integrations/api) for provider
authentication and [Vector configuration testing](https://vector.dev/docs/reference/configuration/unit-tests/)
for the transform test mechanism.
