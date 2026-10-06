# Fly.io

`fly-log-tail` uses `apps` selections of kind `fly_app` and an organization scope.
Its runtime uses the Fly CLI log transport. Source app setup and forwarder app
setup are separate.

For a new source application, inspect its Dockerfile/framework and run native
`fly launch` in that application directory, then `fly deploy` as appropriate.
Choose the user's organization, region and resource settings. Reuse an existing
`fly.toml` rather than creating another app. Record the actual app and organization.
[Fly launch](https://docs.fly.io/flyctl/cmd/fly_launch).

Connect using `FLY_API_TOKEN` and the intended organization:

```sh
logtura connect fly --account-id ORG_SLUG
```

Without an explicit/environment token the connector can obtain `fly auth token`.
That token is short-lived; use an appropriately scoped automation credential for
a durable forwarder, accounting for organization/app access and expiry. The
credential used to deploy a forwarder can require different permissions from
the credential used only to read source logs. [Fly tokens](https://docs.fly.io/security/tokens).

Review `apps` and keep the source apps the user requested. To deploy a standalone
forwarder, use a distinct app with `logtura deploy fly --app FORWARDER_APP`,
following [standalone.md](../standalone.md). For an already linked Fly machine,
follow [linked-service.md](../linked-service.md) and preserve its volume/reporting
identity; do not replace it using a standalone launch flow.

Emit a source app event and verify destination delivery. Transport access is not
proved by successful forwarder deployment alone. Recipe reviewed 2026-10-06.
