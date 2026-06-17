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
