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
require login. `pull` exports existing website deployments; `push` synchronizes local edits back to the website. `deploy fly` applies a linked manifest and reports its accepted revision back to the website.


## Create and link a hosted deployment

```sh
logt login
logt create --connection con_your_connection --name "My forwarder" -o forwarder/logt.yaml
# Link an existing Fly machine instead:
logt create --connection con_your_connection --name "Existing forwarder" \
  --app your-fly-app --machine your-machine-id -o forwarder/logt.yaml
logt -c forwarder/logt.yaml config status
```

Creation adds a self-managed deployment to your signed-in account, then pulls its
manifest and private environment file. It does not provision provider resources.
Optional `--app` and `--machine` must appear together and require `FLY_API_TOKEN`;
the CLI verifies both with read-only Fly requests before creating the record.
The linked deployment appears on the website and uses the same edit, pull, push
and apply flow as a deployment created there. `--target fly` is the default.

`--source-ids all` and `--monitor-ids all` follow all account sources and monitors
(the defaults). Use `none` for an empty selection, or comma-separated owned IDs
for an explicit selection. The connection must belong to your account. Existing
local files require `--force`; unrelated `.env` entries are preserved.

Creation durably saves its exact intent in `.logtura-create.json` before sending
the request. A lost response or failed pull retains this mode-0600 journal. Run
`logt -c forwarder/logt.yaml create --resume` to reconcile the same server receipt
without creating another deployment. Changed local files are preserved; explicit
`--resume --force` repairs them from the current service export. Recover a pending
config transaction first with `config recover`. If the server deployment was
deleted, `create --abandon` archives its observed deletion and never recreates it.
Keep creation journals, `.logtura-create.lock/`, `.logtura-created-*.json` and
`.logtura-abandoned-creation-*.json` private and out of version control.

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

### Durable forwarder reporting adapter

The installed `@logtura/cli` library exports `reportLoadedForwarderFile`,
`withForwarderReportFile` and `runForwarderReporting` for Node 22+ process adapters.
They implement the core runtime/reporting contracts without requiring hosted account
credentials. A reporting transport can use the separate `DeploymentReportingClient`.

Use a dedicated private writable directory on persistent storage and a distinct
checkpoint path for each activated instance. The file adapter holds a process-owner
lock across intent, transport and completion; overlapping reporters fail rather than
race counters. Dead-owner recovery retains uncertain intent. Checkpoints replace
atomically from flushed mode-0600 stages; POSIX directory entries are flushed too.
Windows skips directory fsync. Corrupt/foreign state, unsafe files or symlinked
checkpoint directories fail closed. Only narrowly named abandoned stages are cleaned.
Do not store checkpoints over configuration, artifact or credential files.

The reporting loop calls `observe()` again for every attempt. That callback must
capture files, bound environment, versions and readiness from the process the adapter
actually owns; these functions do not start Vector or manufacture a ready observation.
Supply `report(value)` and an `AbortSignal`. Successful/ignored responses advance the
local checkpoint, with a default 60-second interval. Network failures, HTTP 429/5xx
and transport timeouts retain intent and retry with jittered exponential backoff
(default 1–30 seconds). Integrity, storage, authentication, schema and callback errors
stop. Stop interrupts waiting; an in-flight transport finishes before shutdown returns
(the reporting SDK bounds requests to 20 seconds). No raw transport errors are logged.

This is a library adapter; CLI activation/apply commands and production container
wiring are separate capabilities. Standalone CLI rendering/deployment continues to
work without the Logtura service.

### Owned Vector process supervision

`logt-forwarder --artifact /etc/vector/logtura-runtime.json` starts the installed
Vector binary from a private issued runtime descriptor. Supply the descriptor and
matching `vector.yaml` in the same directory, install declared driver assets under
`/opt/logtura/assets`, and provide generated environment values plus the deployment
reporting token in `LOGTURA_HEARTBEAT_TOKEN`. This executable requires Node 22+ and
a POSIX runtime. It bundles its JavaScript dependencies and can run directly in a
Vector image that supplies Node; it does not require an npm install inside that image.

The default checkpoint is `/var/lib/logtura/reports/<instance-id>.json`. Mount that
directory on persistent private storage before relying on restart recovery. Options
include `--checkpoint`, `--config-directory`, `--vector`, `--interval-ms` and
`--retry-ms`. The executable requires an artifact and fails closed if it is missing;
it does not turn an unissued installation into an applied report.

The library also exports `runForwarderProcess` and `forwarderRuntimeMain`. The process
adapter checks installed bytes/environment and the actual Vector version before
starting, then takes a private read-only YAML snapshot. It removes ambient Vector
configuration/reload/logging controls, starts its own child process group with explicit
config and shutdown arguments, and requires that child's pinned internal API-bind
notice on stderr before checking loopback readiness. User pipeline stdout remains
separate from readiness detection. Installed assets are checked again for every
report and should be baked into the image or mounted read-only. Bound Vector control
variables that conflict with the supervisor's settings fail integrity verification.

A runtime lock prevents overlapping launches for one checkpoint. Stop interrupts
waiting/report scheduling, drains an in-flight SDK request, then stops the owned
process group; unresponsive children are killed after the configured grace period.
Allow at least 35 seconds for container shutdown with default SDK/process timeouts.
Failed process cleanup retains the snapshot. Container runtimes should own the whole
process tree; a host-level SIGKILL can leave an orphan child that needs operator
cleanup before the fixed Vector API port can bind again. Standalone bundle and deployment commands retain direct Vector startup. Linked Fly deployment uses the issued runtime described below. This executable does not activate a service instance or create/update
a deployment itself.


The core image helpers can package this executable with a digest-pinned Node binary;
see `runtimeImageFiles` and `renderDockerfile(deps, {runtimeSupervisor: true})` in the core
README. The service's generated kitchen-sink image now includes that runtime.
Its default entrypoint detects `/etc/vector/logtura-runtime.json`: absent descriptors
preserve direct Vector startup; present descriptors require validation and the bound
config before supervision. Descriptor files, credentials and checkpoints are runtime
mounts, not image layers. Linked Fly apply uses this descriptor path and persistent checkpoint mount.


### Durable linked instance activation

The library exports `activateLinkedDeployment(client, config, {resume?})`,
`readPendingActivation(config)`, `finishLinkedActivation(client, config)`,
`cancelRejectedLinkedActivation(client, config)` and
`abandonObsoleteLinkedActivation(client, config)`. Activation requires a linked,
unchanged local manifest and private payloads, a matching authenticated account/origin
and an already issued desired revision. It records a private intent before the server
call, with compare-and-swap on the previous active instance. A lost response resumes
with the same request ID and recovers the server receipt, rather than issuing twice.

The mode-0600 `.logtura-activation.json` journal contains the linked baseline and
request/receipt metadata, with no resolved payloads or account/reporting tokens.
Configuration mutations, pull and push are blocked while it exists. Read-only
inspection and account login remain available. Offline `config status` shows the
locally recorded pending/issued/rejected phase and instance/request identity, without
contacting the service or exposing private state. Activations share the push lock;
file and parent-directory flushes precede network dispatch and completion.

The caller installs the receipt's issued runtime. Activation does not itself deploy
or acknowledge configuration. `finishLinkedActivation` clears intent only after the
service reports that the same still-current instance has acknowledged its revision.
Retired instances and old applied history cannot complete it. A definitive rejected,
unissued request can be cancelled after checking for a server receipt. Explicitly
abandoning an obsolete issued instance (or an owned deployment's verified deletion)
releases the local journal, without stopping any runtime or changing server activation.
Uncertain requests require resume. Current issued instances retain their intent for
apply recovery. Linked Fly deploy integrates this issuance/completion lifecycle; managed service apply remains separate work.


### Applying a linked Fly forwarder

After `login` and `pull`, edit the portable configuration, then `push` it. Changes to
referenced private payloads require `push --upload-secrets`. `deploy fly` installs
that unchanged linked desired revision into its existing self-managed Fly app:

```sh
logt push
logt deploy fly --image "$LOGTURA_RUNTIME_IMAGE" --volume "$LOGTURA_CHECKPOINT_VOLUME"
logt config status
# Recover an interrupted or uncertain installation:
logt deploy fly --resume
```

`FLY_API_TOKEN` authenticates to the Machines API. The initial `--image` is a complete
registry/repository reference pinned with `@sha256:<64 lowercase hex digits>`.
Read-only preflight verifies registry response hashes and resolves an OCI/Docker
index to its unique Linux/amd64 platform manifest before issuance. Fly receives that
platform pin; a Docker config blob digest cannot acknowledge installation.
Anonymous public registry pulls use scoped bearer challenges. For a registry that
requires an explicit bearer pull token, set `LOGT_REGISTRY_TOKEN` in the CLI process
environment. This token goes only to that registry and is never saved in the apply
journal or forwarded to Fly/the service. Credential acquisition is external.
The image must contain this CLI version's packaged supervisor, its supported Vector/runtime
prerequisites and the generated assets. Apply installs exact generated assets through
machine files, outside image layers, including their modes. An older/incompatible
image cannot acknowledge this issued artifact. Images/releases are still being
validated for the complete convergence rollout; this command does not implicitly
upgrade a production image or choose `latest`.

`--volume` selects an existing encrypted volume in the machine's region, either
unattached or already attached to that machine. It mounts `/var/lib/logtura` for
restart-safe per-instance report counters. Subsequent applies reuse that mount.
Conflicting mounts and volumes attached elsewhere are rejected. Volume provisioning
is currently external to this command. The linked app must already contain exactly
one forwarder machine; this path does not create apps or implement a fleet rollout.
Optional `--app`, `--region`, `--org`, and `--machine` must match the linked target.
Managed deployments use the hosted deployment path.

Read-only preflight renders the configuration and checks verified image identity, target,
credentials, descriptor size and storage before instance issuance. The private
`.logtura-apply.json` records the exact descriptor, resolved machine payload, previous
complete machine config and its actual immutable image digest before provider writes.
A machine lease and version check reject competing changes. Lost responses recover
by reading installed configuration; resume reuses the descriptor and checkpoint
volume instead of issuing again or blindly repeating the update. With no `--image`,
resume uses the saved platform pin without registry access. An explicit `--image`
is verified again and must resolve to that same platform pin. Unrelated machine
settings are retained; startup uses the supervisor with 35 seconds of shutdown grace.
Loader/preload and conflicting Vector launch settings cannot override that startup.

Success requires the service's accepted report from the still-current issued revision
and a started machine with the planned configuration/image. `--wait-seconds` changes
the default 300-second wait (maximum 600). Cancellation/timeout leaves recovery
state. Config writes, push and pull remain fenced while intent exists; offline
`config status` exposes apply identities without resolved payloads. Completion archives
mode-0600 `.logtura-applied-<instance>.json` with private rollback material. Keep these
files outside version control/public artifacts. Restoring a prior machine config
alone does not revert desired configuration or reactivate an old server instance;
converging a rollback requires a new desired revision and issued apply.

`deploy fly --cancel-rejected` clears a definitively rejected, unissued activation
only after receipt lookup. `deploy fly --abandon` archives an owned apply only after
verifying its instance/revision is obsolete or its owned deployment was deleted.
Unknown outcomes require resume; current issued applies cannot be abandoned. These
recovery actions do not stop a machine or change server activation.

Unlinked `deploy fly` still builds and deploys through `flyctl` without Logtura login.
The CLI library also exports `applyLinkedFlyDeployment`, `readPendingFlyApply` and
`abandonObsoleteFlyApply` for adapters.

For retained-machine replacement adapters, `PrivateFlyReplacementStore(config)`
implements the public core `FlyReplacementStore` contract using a directory lock
and a mode-0600 `.logtura-replacement.json` journal. Call `prepare()` with a
`prepared` state before dispatching any provider operation, then pass the store to
the core `executeFlyReplacement()` backend. State transitions compare the exact
previous state and retain immutable plans and candidate identity. File and directory
flushes precede each successful transition acknowledgement. Resume reads the same
intent; a create outcome that cannot be observed remains pending and is never
dispatched again.

`readPrivateFlyReplacement(config)` returns that private state for recovery. It
contains generated files, environment and rollback payloads: keep it private.
`config status` prints only bounded replacement phase and machine identifiers;
configuration edits are fenced while the journal exists. `store.archive(state,
assertCurrent)` keeps a private archive and clears pending state only after the
adapter's acknowledgement check passes twice. The caller must check the accepted
current runtime/target or completed rollback; running-machine health is insufficient.
The linked deployment command's automatic replacement integration is still pending.

`stats --metrics <file>` and `stats <file>` accept JSON arrays, pretty single events,
and NDJSON, including paths with spaces. They use the same public metrics interpreter
as the service, select the latest samples and sum error labels. Empty exports produce
a header-only table; invalid JSON returns exit code 1 without printing its contents.

Provider setup discovers Railway services, Vercel projects and Supabase functions
with the packaged drivers. Railway stores a `project:environment` scope (an empty
environment selects every visible environment in that project) and preserves each
service's environment in the configuration. Supabase preserves function IDs and
represents the HTTP gateway once. Vercel defaults to personal projects; use
`--account-id <team-id>` for team projects.

Reconnect with the same `--name` updates its existing source block. Failed
discovery prints a warning and retains that block's previous selections. Successful
empty discovery clears its inventory. Credential files are written with mode 0600;
replacement tokens use the same confirmation/`--force` rules for Fly as other
providers. Duplicate assignments for a replaced key are removed so the effective
token matches the verified value.
