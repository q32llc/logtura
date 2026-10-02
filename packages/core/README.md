# @logtura/core

Compose Vector configs from typed driver inputs. The renderer takes a typed input
(connections, selected sources, monitors, sinks, heartbeat and metrics targets)
and produces a complete `vector.yaml`, Dockerfile, env-var manifest, and
component manifest describing the pipeline.

Pure TypeScript. No I/O. Drivers (providers and destinations) plug in via small
contracts. This package is the renderer behind `@logtura/cli`.

```bash
npm install @logtura/core @logtura/driver-fly-log-tail @logtura/destination-slack
```

## Usage

```ts
import { generateBundle } from "@logtura/core";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { slackDriver } from "@logtura/destination-slack";

const sources = await flyLogTailDriver.discoverSources({
  credentials: { apiToken: process.env.FLY_API_TOKEN! },
  accountId: "my-org",
});

const bundle = generateBundle({
  providers: [flyLogTailDriver],
  destinations: [slackDriver],
  connections: [
    {
      connection: {
        id: "con_a",
        provider: "fly-log-tail",
        displayName: "prod",
        externalAccountId: "my-org",
      },
      selectedSources: sources,
      credentials: { apiToken: process.env.FLY_API_TOKEN! },
    },
  ],
  monitors: [
    {
      monitor: {
        id: "mon_errors",
        connectionId: null,
        displayName: "errors to slack",
        filterSteps: [{ kind: "errors" }],
        enabled: true,
      },
      sinks: [
        {
          sink: { id: "snk_a", filterSteps: [] },
          destination: { id: "dst_a", kind: "slack", displayName: "alerts" },
          destinationConfig: {
            webhookUrl: process.env.SLACK_WEBHOOK_URL!,
            teamName: null,
            channel: null,
          },
        },
      ],
    },
  ],
});

// bundle.vectorYaml          the full vector.yaml
// bundle.dockerfile          Dockerfile lines for a forwarder image
// bundle.runCommand          the `vector --config ...` invocation
// bundle.envVars             { name, description, source, value, ... }[]
// bundle.componentManifest   primary + plumbing components for a UI
```

## Provider Driver Contract

A provider driver is a single TypeScript object satisfying `ProviderDriver<TCreds>`:

```ts
{
  id: string;
  displayName: string;
  sourceLabel: string;
  capabilities: { selection: "all" | "list" | "both" };
  verifyCredentials(creds): Promise<ProviderAccount[]>;
  discoverSources({ credentials, accountId }): Promise<DiscoveredSource[]>;
  checkCredentialFreshness?(creds): Promise<{ fresh: boolean; reason?: string }>;
  generatePipeline({
    connection,
    selection,
  }): {
    components: VectorComponent[];
    outputKey: string;
    envVars: EnvVarSpec[];
    dockerfileDeps: DockerfileDep[];
    manifest?: ComponentManifestEntry[];
  };
}
```

`generatePipeline` owns the driver's whole internal subgraph. Simple drivers can
emit one Vector source per selected source. Multiplexed drivers can emit one
transport plus per-logical-source filters and merge transforms. The renderer
only wires the returned `outputKey` into downstream monitor/sink transforms.

A destination driver is similar. `DestinationDriver<TConfig>` declares
`generateSinkBundle`, `runtimeEnvVars`, and `envVarValue`.

Form schemas, OAuth flows, and `FormData` parsing are intentionally not part of this contract. The CLI supplies plain typed inputs from `logtura.yaml`.

## Logtura Event Shape

Provider drivers normalize raw platform payloads into `LogturaEvent`:

```ts
import type { LogturaEvent } from "@logtura/core";
```

Every normalized event should have `.message`, `.level`, and `.error`.
Drivers should also populate source context such as `.timestamp` and `.script`
when the provider exposes it. The renderer adds `.logtura_connection_id`,
`.logtura_provider`, and `.logtura_received_at` after the driver output.

Errors should preserve structured context with `.error_reason` and
`.exceptions` where available. Provider-specific raw fields may remain on the
event unless a driver intentionally drops them.

## Related packages

- [@logtura/driver-cloudflare-worker-tail](../driver-cloudflare-worker-tail). Cloudflare Workers Tail API over Vector's exec source.
- [@logtura/driver-cloudflare-ai-gateway](../driver-cloudflare-ai-gateway). Cloudflare AI Gateway logs via http_client.
- [@logtura/driver-fly-log-tail](../driver-fly-log-tail). `flyctl logs --json` over Vector's exec source.
- [@logtura/driver-supabase-edge-logs](../driver-supabase-edge-logs). Supabase Edge Functions via the analytics API.
- [@logtura/driver-vercel-logs](../driver-vercel-logs). Vercel Runtime Logs via the REST API.
- [@logtura/custom-vector](../custom-vector). Bring-your-own Vector source, transform, and sink fragments.
- [@logtura/destination-slack](../destination-slack). Incoming-webhook.
- [@logtura/destination-webhook](../destination-webhook). Generic HTTPS POST.
- [@logtura/destination-datadog-metrics](../destination-datadog-metrics)
- [@logtura/destination-prometheus-remote-write](../destination-prometheus-remote-write)

## Status

Packages build to ESM JavaScript and TypeScript declarations. Built artifacts
work with Node 22+ and Workers without a TypeScript loader.

`installBundleFiles(bundle, directoryName?, displayName?)` composes the same
Dockerfile, Vector config, runtime assets, credential file, installer and
component manifest used by the CLI and hosted service. `buildTar(files)` creates
a reproducible uncompressed ustar archive; callers choose Node or Workers gzip.
Secrets belong only in the mode-0600 `.env` file. The installer exports them to
Docker without changing shell-quoted values. `manifest.json` is currently the
Vector component diagram, not a portable deployment configuration.

Tar paths must be relative, unique, free of traversal and at most 100 UTF-8
bytes. Install environment variable names must be valid shell identifiers.

## License

[Apache 2.0](./LICENSE).


## Portable configuration

`parseConfigDocument(document, options?)` accepts a decoded YAML/JSON object.
Supply `providers`, `destinations`, `env` and an optional `readInclude(path)`
callback. The parser performs no filesystem access, provider requests, or ambient
environment lookup, so the same API runs in Node and Workers. `env:KEY` values
resolve only through the supplied environment; missing keys are returned in
`missingEnv` and all explicit references in `requiredEnv`.

`normalizeConfigDocument(document, options?)` upgrades unversioned documents to
`schema_version: 1`, adds explicit `con_`, `dst_` and `mon_` identities, captures
monitor defaults, stores source links as `connection_id`, and embeds custom
Vector includes as `vector.fragment`. Existing derived identities are preserved.
Explicit IDs survive label/key edits. Collisions and ambiguous source references
fail validation. A monitor without a source link applies to every connection.

`hashConfigDocument(document, options?)` returns `sha256:<hex>` over deterministic,
normalized JSON. Object key order and resolved environment values do not affect
the revision; ordered filter/monitor arrays and included fragment contents do.
`canonicalConfigJson(value)` exposes the JSON encoding and rejects cycles,
non-finite numbers, non-JSON values and non-plain objects.

Normalization preserves literal credentials if the original document contains
them. Use `env:` references for configuration intended to be stored or shared;
these APIs do not silently redact or guess which custom fields contain secrets.
Portable documents and revisions are a foundation for deployment synchronization;
account authentication, remote conflict handling and applied-revision reporting
are separate service capabilities.


## Optional hosted account access

`LogturaServiceClient({ url, token?, fetch })` provides account API access through
an explicit fetch adapter. Service origins require HTTPS, except loopback HTTP
for local testing. API paths remain on that origin, redirects are not followed,
and browser cookies are omitted. Only `lt_cli_` account tokens are accepted.

`authorizeCliDevice(client, label, { show, sleep, now? })` starts browser approval,
polls with backoff, and returns an expiring credential. `show` receives the
verification URL and terminal code; the user must explicitly approve on the
website. `client.whoami()` resolves the account and `client.logout()` revokes the
current credential. Lost poll responses can be retried during the authorization
window. Server denial, expiration and malformed responses fail closed.

The hosted client is opt-in. Configuration parsing, rendering, drivers and
standalone deployment do not require it or hosted authentication.


### Portable deployment manifests

`exportDeploymentManifest(input, await createSecretVersioner(privateKey))` returns
`{document, secretValues}`. It preserves complete public rendering inputs while
moving driver payloads, metadata and runtime values to versioned JSON environment
references. Retain the version key privately and use the same key to generate
stable revisions; do not publish it. `parseDeploymentManifest(document, {env,
providers, destinations})` resolves those references with caller-supplied values.
The normal `parseConfigDocument`, `normalizeConfigDocument` and
`hashConfigDocument` functions also accept this schema. Unknown graph fields,
filter kinds and broken identities fail rather than being silently dropped.
`LogturaServiceClient.pullDeploymentConfig(id, true)` is the optional account
transport; the standalone parser and renderer perform no hosted requests.


`editDeploymentManifest(document, secretValues, edits, versioner)` applies ordered
portable graph changes without I/O or input mutation. It preserves unchanged
opaque payload versions, validates the final graph, and returns a new manifest
and private secret map. `diffDeploymentManifests(before, after)` reports stable
entity IDs, operations and changed field names, with revision hashes. It does not
return changed values, even for labels, filter patterns or credential payloads.
Source and routing order changes are represented explicitly. These shared pure
operations can be used by terminal, browser and storage adapters; they do not
perform service persistence or optimistic-concurrency writes.

`planDeploymentChanges(ownedInventory, resolvedInput)` computes storage changes
without I/O. It reuses an existing source ID when the connection, source kind and
provider resource match, and returns the ID mapping in `sourceAliases`. An adopted
source retains discovered metadata when the incoming metadata is null. Explicit
labels and metadata can update it. Existing source identities cannot be rebound
to another resource, connection providers cannot change, and sinks cannot move
between monitors.

The plan contains dependency-ordered upsert lists, retained-monitor sink removals,
and ordered deployment selections. Deselecting an inventory entity or monitor
does not delete it. Shared destinations must have consistent payloads. Plans
contain private values: keep them local to the storage adapter and never expose
them as an HTTP diff or log. The caller supplies an owned inventory, validates
provider/account policy, resolves credentials, and executes changes atomically
with its concurrency guard. `validateDeploymentInput(input)` validates the graph
and payloads synchronously without rendering, signing or making network requests.

### Preserve discovery intent

A portable connection's optional `discoverSources: true` refreshes its materialized
source list from a caller-supplied discovered catalog. The manifest's optional
`discoverMonitors: true` includes enabled monitors applicable to its connections
and their current sinks. These flags preserve legacy hosted selections through
pull/edit/push. They differ from `selectAll: true`, which asks a supporting driver
to subscribe to every stream directly; native all-source and discovered-source
modes are mutually exclusive for a connection.

`resolveDeploymentDiscovery(ownedInventory, input)` returns a materialized input
without network calls, service dependencies or mutation. Explicit snapshot order
is retained, and new rows append in inventory order. A standalone adapter can
provide its own catalog before calling `generateBundle`. `planDeploymentChanges`
resolves the flags against its owned inventory automatically. An already
materialized manifest can render offline from its captured snapshot; discovery
flags take effect again when its catalog is refreshed.

Graph `connection.add`/`connection.update` edits accept `discoverSources`; a
`selection.update` edit accepts `discoverMonitors`. Removing a source freezes that
connection's discovery policy to the retained explicit snapshot. Removing a
monitor or sink freezes monitor discovery so a later refresh will not silently
re-add the removed selection. Other edits retain discovery policy. Diffs expose
changed policy field names without disclosing private catalog payloads.

### Optional account configuration push

`LogturaServiceClient.pushDeploymentConfig(deploymentId, request)` sends a portable
manifest to an authenticated account. Supply `expectedConfigurationVersion` and
`expectedSequence` from the most recent `pullDeploymentConfig` response; newer
services return both counters. Older exports can omit them, so callers must check
availability before offering push rather than guessing a baseline.

Unchanged references resolve from account-owned storage without uploading secret
values. New or changed payloads require `uploadSecrets: true` plus `secretValues`
containing only referenced JSON environment values. The client rejects unrelated
or malformed uploads before sending them. Change the reference version when
editing a private payload; unchanged versions with changed values are rejected.
Hosted OAuth references retain grant identity across renewal and resolve fresh raw
credentials without persisting an exported broker envelope.

A successful commit returns the canonical public `document`, its `revision`,
`configurationVersion`, desired `sequence` and canonical `sourceAliases`. The
client verifies the response's schema, counters and document hash. A conflict
returns a `ServiceError` with status 409; pull and reconcile before retrying.
Push records desired configuration; it does not acknowledge that a forwarder has
applied it. The client uses caller-provided fetch, authenticated HTTPS (or loopback
HTTP), manual redirects, omitted cookies and bounded request timeouts. Standalone
parsing, rendering and discovery do not construct this client or need the service.

`manifestSecretName(category,id)` exposes the schema's canonical UTF-8 identity
encoding for reference namespaces. Hosted secret resolution restricts unchanged
references to their owned connection, source, destination or deployment purpose.


Configuration pushes can opt into durable deduplication with a caller-generated
canonical UUIDv4 `requestId`. Persist the ID and exact intended request before
sending it. Repeating the same effective request returns its original commit,
even after later website edits; changing the request under that ID returns
`request_id_reused` (409). JSON formatting inside explicit payload uploads does
not change their effective identity.

`getDeploymentPushReceipt(deploymentId, requestId)` retrieves the original public
commit. It returns `null` only for an owned deployment's missing receipt; ownership,
authorization and storage failures remain errors. Receipts prove an earlier commit
and may be older than the current desired configuration. They contain no resolved
private values or request fingerprints. The service stores a keyed request digest
and retains receipts until the deployment is deleted. Receipt storage and graph
mutations commit atomically, including graph no-ops. The service must have migration
0024 and these endpoints before consumers rely on recovery. The CLI push/recovery
consumer is a subsequent capability; the SDK never retries writes implicitly.

The library also exports `isDeploymentPushRequestId` and
`validateDeploymentConfigCommit` for validating request identities and canonical
public commit responses without contacting a service.
