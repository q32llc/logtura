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
require login. `pull` exports existing website deployments; `push` synchronizes local edits back to the website. Forwarder apply/acknowledgement remains upcoming.


## Pull a website deployment

```sh
logt login
logt pull dep_your_deployment -o forwarder/logt.yaml
logt -c forwarder/logt.yaml validate
logt -c forwarder/logt.yaml bundle -o forwarder/bundle
```

The service must include deployment export and account identity endpoints,
with account configuration-version and deployment desired-sequence baselines. Pull creates a versioned
`kind: logtura.deployment` graph and a mode-0600 companion `.env`. The graph keeps
connection, source, monitor, destination and sink identities, source metadata,
all filter steps and reporting settings. Driver credentials, destination payloads,
metadata and runtime reporting tokens are JSON-valued environment references.
The manifest contains opaque versions so changes to private payloads change its
revision without putting the payloads in the manifest. Keep `.env` private.

Pull requires an account CLI credential; a forwarder's reporting token cannot
export configuration. Existing configuration and conflicting secret values require
`--force`. Unrelated `.env` entries are preserved. Staged writes roll back ordinary
I/O failures. A durable, mode-0600 `.logtura-transaction.json` journal protects
both files during replacement. After an interrupted write, run:

```sh
logt -c forwarder/logt.yaml config recover
```

Recovery restores the previous pair before commit, or keeps the new pair after
commit and removes backups. It refuses to race a live writer or recover invalid
journals, symlink artifacts or a missing committed destination. All configurations
sharing that directory's `.env` refuse reads/edits until recovery finishes. Keep
stages, backups and the journal together; do not delete them to bypass recovery.
The CLI does not print exported secrets. Directory fsync is used on platforms
that support it; Windows recovery covers process interruption without claiming
the same power-loss durability.

Pulled manifests use the same public parser and renderer as local shorthand files.
`validate`, `bundle`, `env`, `config normalize/hash` and local deployment operate
without contacting the website. Existing OAuth broker URLs and opted-in reporting
still contact the configured endpoints when the forwarder runs. Shorthand
`connect/source add/sink add/monitor add` commands refuse this graph format;
Use the portable graph editing commands below and authenticated `push` to synchronize changes.
Pull currently describes the service's current graph, rather than a persisted
separate desired or applied revision. It does not update the service.


## Edit a portable graph locally

```sh
# Start with a pulled graph, or convert an existing standalone shorthand config.
logt -c logt.yaml config export -o portable.yaml
logt -c portable.yaml source select con_workers new-website --kind cf_worker
logt -c portable.yaml source remove src_old_website
logt -c portable.yaml config diff baseline.yaml
logt -c portable.yaml diff dep_your_deployment
```

`source select` preserves an existing selection's ID. A new selection gets an ID
once; `--id` supplies a caller-owned ID, and `--name` changes its label. Supply
`--kind` for an empty or mixed source inventory. `--metadata-file metadata.json`
loads provider-specific metadata from a private JSON file. The command keeps the
connection's all-source selection setting. Removing a site edits this local
manifest; it does not delete a provider resource or mutate the website.

`config edit operations.json` applies an ordered JSON array of graph operations.
The public library implements the same transaction. Available operations are
`connection.add/update/remove`, `source.add/update/remove`,
`monitor.add/update/remove`, `sink.add/update/remove`, `destination.update` and
`reporting.update` and `selection.update`. Add operations supply complete entities with stable IDs;
updates use `id` plus `patch`. Connection updates may include `credentials`, and
destination updates may include `destinationConfig`. IDs cannot be patched.

```json
[
  {"kind":"source.update","id":"src_site","patch":{"displayName":"New label"}},
  {"kind":"monitor.update","id":"mon_errors","patch":{"enabled":false}},
  {"kind":"sink.update","id":"snk_alerts","patch":{"filterSteps":[{"kind":"errors"}]}}
]
```

A destination update affects every sink and metrics target using that ID. Removing
a monitor removes its graph-owned sinks. Removing a connection requires adjusting
or removing monitors scoped to it in the same transaction. Duplicate identities,
duplicate selections, broken references and unsupported fields fail before any
file replacement. Private JSON input errors do not print the input payload.

Graph edits keep unchanged payload versions and give changed payloads new opaque
versions. Credential and metadata changes belong in explicit operations; editing
`.env` by hand does not currently refresh public version references. `push --upload-secrets` detects these changes and refreshes their public versions.
Local `config diff` and account `diff` report identities and changed field names,
including ordering, without printing values. These commands compare manifests;
they do not push, deploy, resolve conflicts or persist desired/applied revisions.
Existing `bundle`, `validate`, `env` and local deployment consume the edited graph.

Portable graphs retain `discoverSources` on a connection and `discoverMonitors`
on the root when the hosted deployment follows discovered inventory. Rendering
an exported graph offline uses its captured snapshot. Discovery requires a fresh
catalog and configuration regeneration; it does not subscribe to future streams
inside the running forwarder. Provider-native `selectAll` is a separate mode.

Use an edit file to change the policy explicitly:

```json
[
  {"kind":"connection.update","id":"con_existing","patch":{},"discoverSources":false},
  {"kind":"selection.update","discoverMonitors":false}
]
```

Apply it with `logt config edit edits.json`. Removing a selected source
freezes discovery for that connection; removing a monitor or sink freezes monitor
discovery. This keeps a later catalog refresh from restoring a removed selection.


## Linked deployment baseline and offline status

Hosted pull also creates `<config>.logtura-link.json` with mode 0600. It records
the service origin, account/deployment identity, both revision fences, and the public
baseline manifest. Private payloads are represented by keyed fingerprints; their
random private key stays in this file. It contains no account/reporting credentials
or resolved payloads. Keep the file private and exclude it and its recovery
artifacts from version control:

```gitignore
*.logtura-link.json*
.logtura-transaction.json*
.logtura-push.json*
.logtura-push.lock/
.env
.env.*
```

```sh
logt -c forwarder/logt.yaml config status
```

Status runs offline and returns JSON with public graph changes and value-free
private change entries. A changed private payload with an unchanged reference
version has `requiresVersionUpdate:true`; JSON whitespace/key order alone is not
a change. Missing values, additions and removals are reported separately. Only
referenced environment values are inspected. Local edits preserve the hosted
baseline; exporting to a new config path does not copy the source's deployment
identity. An explicit forced pull can replace an existing link.

YAML, companion `.env` and the link are committed and recovered together on hosted
pull. Earlier two-file journals remain supported. A service without revision fences
cannot establish a link; pull fails before changing local files.


## Push local changes to the website

```sh
logt -c forwarder/logt.yaml source select con_workers new-website --kind cf_worker
logt -c forwarder/logt.yaml push
# Authorize transfer of changed referenced private JSON payloads.
logt -c forwarder/logt.yaml push --upload-secrets
```

Push requires a hosted link and login to its service and account. It uses the saved
configuration version and desired sequence to reject concurrent website edits.
Only changed referenced private payloads are uploaded with `--upload-secrets`;
unchanged credentials stay on the service. Private changes receive new opaque
manifest versions. Changed OAuth broker URLs require raw grant values or a fresh
website pull. Push updates the website graph and desired revision; updating the
running forwarder and reporting its applied revision remain separate capabilities.

Before sending a write, the CLI durably saves a request ID and exact request in
`.logtura-push.json` (mode 0600). Explicitly authorized private uploads are stored
there until recovery completes. Exclude this file and `.logtura-push.lock/` from
version control. Configurations sharing the directory cannot edit or pull over a
pending push. Status and validation remain available.

```sh
# Recover a lost response or interrupted push using the exact saved request.
logt -c forwarder/logt.yaml push --resume
# After a confirmed commit or definitive rejection, accept the latest website state.
logt -c forwarder/logt.yaml push --resume --accept-remote
# Also explicitly replace local edits made since the pending push started.
logt -c forwarder/logt.yaml push --resume --accept-remote --force
```

Resume checks the immutable service receipt before retrying the same request ID.
It does not change the saved upload authorization or payloads. An uncertain outcome
must be retried before accepting remote state. Local edits or a newer website
revision stop automatic replacement and retain the pending request. Successful
recovery commits YAML, `.env` and the linked baseline together, then removes the
pending request. If a local file transaction was interrupted, run `config recover`
before resuming. A live push process holds a directory lock; dead-process locks can
be reclaimed without deleting another process's ownership marker.


## Update an existing Fly forwarder

Hosted pulls retain a public target record in the private deployment link: the
existing app, optional machine/region/organization, managed flag and pinned image
digest. The service exports known identity fields and excludes target credentials.
Target identity stays separate from the portable pipeline graph.

```sh
logt -c forwarder/logt.yaml push
logt -c forwarder/logt.yaml deploy fly
```

For a linked self-managed deployment, `deploy fly` uses the saved app and region.
Local graph or private payload changes must be pushed first. Conflicting app,
region or organization overrides fail before writing artifacts or secrets. If the
existing app cannot be reached, deployment stops before creating another app.
Legacy website rows without a recorded app require `--app existing-app`; the CLI
does not infer the running app from a folder or renamed website label. Links from
older services without target records require a fresh pull from an updated service.

Managed forwarders use the service deployment path, which owns their image and
machine settings. Standalone configs retain local `flyctl` creation and deployment
without service login. This target binding does not yet report a loaded forwarder
revision to the website; runtime acknowledgement remains upcoming.
