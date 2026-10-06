# Railway

`railway-logs` selects `services` of kind `railway_service`. Resources belong to
a project **and** environment. The runtime is a Bun GraphQL WebSocket helper;
the generated bundle contains the helper assets.

For a new source project, use native Railway CLI setup (`railway login`,
`railway init`, and `railway up` as appropriate). For an existing project, link
the actual project/environment/service rather than initializing another one.
Inspect the local CLI's help before selecting flags. [Railway CLI](https://docs.railway.com/cli).

Provide `RAILWAY_API_TOKEN` securely. Workspace/account and project/environment
tokens have different scopes. Use an explicit project/environment account scope
when it is known:

```sh
logtura connect railway --account-id PROJECT_ID:ENVIRONMENT_ID
```

Keep discovery's service IDs and `environment_id` metadata. Do not reinterpret
an environment ID as a project ID or replace resource IDs with display names.
Review the selected service list; identical services in staging and production
must remain scoped correctly. [Railway API authentication](https://docs.railway.com/integrations/api).

In a linked graph, `source select` uses the actual discovered external ID and
`--kind railway_service`; supply environment metadata via `--metadata-file` when
required. See [linked-service.md](../linked-service.md).

There is no native `logtura deploy railway` command. Run the generated forwarder
on the selected Docker/Fly target. Verify an event from the selected service and
environment, and inspect helper reconnect/auth errors if delivery stops.
Recipe reviewed 2026-10-06.
