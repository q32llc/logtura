# @logtura/cli

OSS CLI for configuring and running local logt forwarders.

The binary is `logt` (`logtura` remains as an alias). The CLI treats config as
a plain file you edit, not a TTY wizard. TTY prompts are reserved for secrets:
tokens, webhooks, and account-choice ambiguity.

```sh
npm install -g @logtura/cli
```

## Happy Path

```sh
logt init
logt connect cloudflare
logt source add cloudflare-worker-tail
logt sink add slack errors-slack
logt monitor add errors errors-slack
logt deploy fly
```

`connect` is the main setup command. It acquires or reuses local credentials,
verifies them locally, writes `.env`, discovers inventory, and updates
`logt.yaml`.

`logt.yaml` is preferred. `logtura.yaml` still works.

## Taxonomy

- **Provider**: root account/credential connection, for example `cloudflare`.
- **Source**: log surface/tailer using a provider, for example
  `cloudflare-worker-tail`, `cloudflare-ai-gateway`, future
  `cloudflare-d1-*`, etc.
- **Sink**: delivery destination, for example Slack or webhook.
- **Monitor**: filters/routing from sources to sinks.

Cloudflare is the motivating case: one Cloudflare provider connection should
unlock many source drivers. Workers, AI Gateway, D1, R2, Pages, Queues, and
other log surfaces should not each own credentials.

## Config Shape

```yaml
providers:
  cloudflare:
    provider: cloudflare
    display_name: q32llc
    account_id: env:CLOUDFLARE_ACCOUNT_ID
    credentials:
      api_token: env:CLOUDFLARE_API_TOKEN

sources:
  cloudflare-worker:
    source: cloudflare-worker-tail
    provider: cloudflare
    scripts:
      - api-worker
      - admin-worker

  cloudflare-ai-gateway:
    source: cloudflare-ai-gateway
    provider: cloudflare
    gateways:
      - main-gateway

sinks:
  errors-slack:
    sink: slack
    webhook_url: env:SLACK_ERRORS_SLACK_WEBHOOK_URL

monitors:
  - name: errors
    filter: [errors]
    sinks: [errors-slack]
```

If there is only one compatible provider, source commands infer it. Multiple
Cloudflare providers require an explicit `provider:` in YAML or `--provider` on
the command.

## Secret Acquisition

Every secret prompt follows the same rules:

1. Explicit flags win: `--token=...`, `--webhook=...`, etc.
2. Existing process env or `.env` values are detected.
3. If a value exists and TTY is allowed, ask whether to reuse it.
4. `-q` / `--quiet` never prompts and never opens a browser.
5. If a pasted/flag value would overwrite a different `.env` value, ask first.
6. In quiet mode, overwrites require `--force`.

Provider connectors should try the nicest local path first:

- native/provider CLI token minting when supported;
- provider token template or browser page plus hidden paste prompt;
- manual placeholder only as a fallback.

Examples:

```sh
logt connect cloudflare
logt connect cloudflare --token=cfat_...
logt connect cloudflare -q
logt connect cloudflare --token=cfat_... --force -q
```

Cloudflare opens a token-template page when no local token is present. If
Cloudflare source blocks already exist, the template uses provider-owned
metadata supplied by those source drivers. `logt connect cloudflare --all`
uses metadata from all known Cloudflare source drivers. Fly uses
`fly auth token` when available. Railway, Vercel, and Supabase currently use
token-page plus hidden paste prompt unless an env value already exists.

## Utility Commands

```sh
logt env
logt env --write
logt env --check
logt validate
logt bundle -o dist/logt-forwarder
logt deploy fly -W
logt stats --metrics metrics.json
```

`env` is a repair/CI helper. The happy path is still `connect`, which should
leave the project with credentials already written to `.env`.

`logt deploy fly --write-env` is a shortcut for:

```sh
logt env --write && logt deploy fly
```

`logt deploy fly` shells `flyctl` locally. It writes the bundle to
`dist/logt-fly`, creates the Fly app if needed, imports resolved env vars as
Fly secrets, runs `flyctl deploy --remote-only`, and finishes with
`flyctl status`. Use `--app`, `--region`, and `--org` to override defaults.

## Provider Connector Contract

Root provider connectors own:

- acquiring root credentials;
- verifying credentials;
- selecting or writing account IDs;
- discovering available source inventories;
- writing `.env` values.

Per-source drivers own:

- discovering one source kind using the provider credentials;
- rendering runtime config for that source kind;
- declaring runtime env vars;
- optionally declaring arbitrary provider-connect metadata. This metadata is a
  contract between that source driver and its root provider connector, not a
  global CLI schema.

This keeps the model scalable: adding a ninth Cloudflare source driver should
not create a ninth Cloudflare credential flow.


## Portable configuration and revisions

```sh
logt config normalize               # update the selected file in place
logt config normalize -o portable.yaml
logt config hash
logt --json config hash
```

Normalization adds `schema_version: 1` and stable IDs, makes monitor defaults and
connection links explicit, and embeds custom Vector include files. The resulting
file no longer depends on the original include paths. Keep explicit IDs when
renaming sources, destinations or monitors. Invalid or duplicate identities and unsupported
schema versions fail before writing output.

The hash includes the normalized configuration and custom fragment contents,
while retaining unresolved `env:` references. It does not contact Logtura or a
provider, require credentials to be present, or hash resolved environment secrets.
Normalization preserves any literal credentials already in the input file; use
`env:` references for a portable file you intend to share. CLI/website account
synchronization is not enabled by these local commands.


## Optional website account login

```sh
logt login
logt login --service http://localhost:8787 --no-browser
logt --json whoami
logt logout
logt logout --local
```

`login` prints a short code and opens the website. Confirm the code and account
before approving. The credential expires after 90 days and can be revoked from
**CLI access** on the website. Default logout revokes it on the service; `--local`
only removes the local file. Network revocation failures preserve the credential
so logout can be retried. Revoked/expired credentials can be removed normally.

Credentials are saved atomically with mode 0600 under
`$XDG_CONFIG_HOME/logtura/account.json` (default `~/.config/logtura/account.json`).
Use `LOGT_AUTH_FILE` for an explicit file. `LOGT_SERVICE_URL` selects the service;
`LOGT_SERVICE_TOKEN` supplies an existing account token for automation. Credentials
for one service origin are not sent to another, and token values are not printed.
Forwarder reporting tokens cannot authorize account configuration operations.

These account commands require a service deployment with CLI authorization
support. Standalone setup, config, bundle and provider deployment commands do not
require login. `pull` exports existing website deployments; push and desired/applied synchronization are upcoming slices.


## Pull a website deployment

```sh
logt login
logt pull dep_your_deployment -o forwarder/logt.yaml
logt -c forwarder/logt.yaml validate
logt -c forwarder/logt.yaml bundle -o forwarder/bundle
```

The service must include the deployment export endpoint. Pull creates a versioned
`kind: logtura.deployment` graph and a mode-0600 companion `.env`. The graph keeps
connection, source, monitor, destination and sink identities, source metadata,
all filter steps and reporting settings. Driver credentials, destination payloads,
metadata and runtime reporting tokens are JSON-valued environment references.
The manifest contains opaque versions so changes to private payloads change its
revision without putting the payloads in the manifest. Keep `.env` private.

Pull requires an account CLI credential; a forwarder's reporting token cannot
export configuration. Existing configuration and conflicting secret values require
`--force`. Unrelated `.env` entries are preserved. Staged writes roll back ordinary
I/O failures; a process or machine crash during the two-file replacement can leave
backup files requiring recovery. The CLI does not print exported secrets.

Pulled manifests use the same public parser and renderer as local shorthand files.
`validate`, `bundle`, `env`, `config normalize/hash` and local deployment operate
without contacting the website. Existing OAuth broker URLs and opted-in reporting
still contact the configured endpoints when the forwarder runs. Shorthand
`connect/source add/sink add/monitor add` commands refuse this graph format;
graph editing commands and authenticated push are still being implemented.
Pull currently describes the service's current graph, rather than a persisted
separate desired or applied revision. It does not update the service.
