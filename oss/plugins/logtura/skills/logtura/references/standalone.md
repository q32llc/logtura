# Standalone setup

Run in the user's project or a dedicated forwarder directory. Existing configs
take priority over scaffolding. No website login or Logtura service is required.

```sh
logtura --help
logtura providers list --json
logtura init
```

Choose a provider recipe, make its credentials available securely, then connect:

```sh
logtura connect cloudflare
```

Replace `cloudflare` with `fly`, `railway`, `vercel`, or `supabase` as appropriate.
Use `--account-id` for an explicit account/project scope and `--name` for multiple
connections to one host. `--quiet` reuses available credentials without prompts;
it should fail when a required credential is missing. Do not use `--force` just
to suppress a replacement conflict.

Connect stores credential references and discovered resources in the shorthand
config. Review that config and reduce selections to the user's intended sites.
The catalog names selection fields (`scripts`, `gateways`, `apps`, `services`,
`projects`, `functions`). Preserve Railway environment metadata and Supabase
function/gateway distinctions. Native list-only drivers do not support `all: true`.

Example destination and monitor scaffolding:

```sh
logtura sink add webhook alerts
logtura monitor add errors alerts
```

Fill the generated destination environment reference through a private `.env`
file or process environment. `errors` is the CLI's error-filter scaffold; inspect
other monitor names and edit the config's filter steps for the requested policy.
Supported destinations include Slack, webhook, Datadog metrics, Prometheus remote
write, and custom Vector. Metrics destinations are not ordinary log-alert sinks.

```sh
logtura env --check
logtura validate
logtura bundle -o forwarder
```

The generated directory includes runtime assets when needed, the Dockerfile,
Vector config, manifest, and private environment data. Build/run it using the
generated installation instructions or the project's existing Docker workflow.
Bind Vector's metrics endpoint to a private interface if exposing it for checks.

For native standalone Fly deployment:

```sh
logtura deploy fly --app YOUR_FORWARDER_APP --region YOUR_REGION
```

Inspect the installed CLI's Fly options and generated config first; use
`--write-env` when that is the selected secret-upload workflow. Choose a separate
forwarder app rather than overwriting the source application. Verify live delivery
using [verify-and-recover.md](verify-and-recover.md).

To change a shorthand config, edit its selected resource arrays/filter steps and
repeat validation, bundling, deployment, and delivery checks. Keep entity IDs;
`config normalize` can make legacy shorthand identities explicit. `config export`
produces a portable graph for graph operations, but does not link a standalone
deployment to the website automatically.
