/**
 * Public types for @logtura/core. These are plain TS shapes the
 * renderer + drivers consume — no database rows, no D1/Hono
 * coupling. Callers feed the renderer the structured inputs they
 * already have in whatever form, and get back a Vector config + a
 * component manifest.
 */

// ---- Entity refs -----------------------------------------------------
// Minimal shapes the renderer needs from each entity. Anything else
// the caller's storage layer carries (created_at, audit fields,
// encrypted blobs) stays in the caller.

export interface Connection {
  id: string;
  provider: string;
  displayName: string;
  externalAccountId: string | null;
}

export interface Source {
  id: string;
  externalId: string;
  displayName: string;
  sourceKind: string;
  metadata: Record<string, unknown> | null;
}

export interface Monitor {
  id: string;
  /** null = applies to events from any connection. */
  connectionId: string | null;
  displayName: string;
  filterSteps: FilterStep[];
  enabled: boolean;
}

export interface Sink {
  id: string;
  filterSteps: FilterStep[];
}

export interface Destination {
  id: string;
  kind: string;
  displayName: string;
}

// ---- Filter steps ----------------------------------------------------
// The structured "monitor pipeline" DSL. Each kind is one driver-
// authored compiler that emits Vector transforms.

export type FilterStep =
  | { kind: "errors" }
  | { kind: "level"; level: string; mode?: "include" | "exclude" }
  | {
      kind: "match";
      pattern: string;
      mode: "include" | "exclude";
      field?: string;
    }
  | { kind: "rate_limit"; per_minute: number }
  | { kind: "dedup"; window_secs: number; fields?: string[] }
  | { kind: "sample"; rate: number }
  | {
      kind: "rollup";
      window_secs: number;
      group_by?: string[];
      max_samples?: number;
    };

// ---- Canonical event shape --------------------------------------------

export interface LogturaException {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Normalized log event shape emitted by provider drivers and consumed by
 * monitor filters and destinations. Drivers may preserve provider-specific
 * raw fields alongside these fields unless they intentionally drop them.
 *
 * Required normalized fields: `.message`, `.level`, `.error`.
 * Recommended source fields: `.timestamp`, `.script`.
 * Error fields: `.error_reason`, `.exceptions`.
 * Renderer-added fields:
 * `.logtura_connection_id`, `.logtura_provider`, `.logtura_received_at`.
 */
export interface LogturaEvent {
  message: string;
  level: string;
  error: boolean;
  timestamp?: unknown;
  script?: string;
  error_reason?: string;
  exceptions?: LogturaException[];
  logtura_connection_id?: string;
  logtura_provider?: string;
  logtura_received_at?: unknown;
  [field: string]: unknown;
}

// ---- Provider driver contract ----------------------------------------

/** Caller view of a connection that the driver needs at code-gen
 *  time — the same shape as the public Connection but with `id`
 *  kept narrow to what drivers read. (Most drivers only need id +
 *  externalAccountId; some need displayName for naming.) */
export interface ConnectionRef {
  id: string;
  externalAccountId: string | null;
  displayName: string;
  /** Hint to the driver about the credential's nature without
   *  exposing the secret itself. `"static"` means a stable bearer
   *  (PAT, long-lived API key) — drivers can poll the endpoint
   *  directly with the env-injected value. `"refreshable"` means
   *  the credential rotates and a companion sidecar (e.g.
   *  logtura-http-client) is responsible for keeping a fresh token
   *  available. Drivers that don't care leave the default
   *  ("static") behavior.
   *
   *  Callers set this from credential shape (e.g. "is there a
   *  refresh_token field?"). The OSS surface only sees the kind. */
  credentialKind?: "static" | "refreshable";
}

/** Caller view of a single source row for the driver. `id` is the
 *  caller's opaque identifier for the source; drivers echo it back
 *  into `manifest.links.sourceId` so callers can connect picked
 *  rows to live components. Drivers don't otherwise interpret it. */
export interface SourceRef {
  id: string;
  externalId: string;
  displayName: string;
  sourceKind: string;
  metadata: Record<string, unknown> | null;
}

/** A source the driver discovered. */
export interface DiscoveredSource {
  sourceKind: string;
  externalId: string;
  displayName: string;
  metadata: Record<string, unknown> | null;
}

/** An account-like principal returned by `verifyCredentials`. */
export interface ProviderAccount {
  id: string;
  name: string;
}

/** Env-var the bundle expects at runtime. The caller fills `value`
 *  from stored credentials / external account / user input. */
export interface EnvVarSpec {
  name: string;
  description: string;
  source: "credential" | "external_account_id" | "destination" | "manual";
  credentialPath?: string;
  helpUrl?: string;
}

/** Dockerfile install step the driver needs in the forwarder image
 *  (for self-deploy users). Use `install` for a shell command that
 *  needs `RUN` prefixing (apt installs, curl, etc). Use `directive`
 *  for raw Dockerfile lines like `COPY --from=<image>:<tag> ...` or
 *  `ARG ...` that aren't shell commands and shouldn't be wrapped. */
export interface DockerfileDep {
  install?: string;
  directive?: string;
  aptPackages?: string[];
}

export interface RuntimeAsset {
  /** Driver-relative POSIX path. Core writes it under assets/<driver-id>/. */
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

export interface GeneratedRuntimeAsset extends RuntimeAsset {
  driverId: string;
}

export interface RenderDockerfileOptions {
  mountVectorYamlAtRuntime?: boolean;
  includeRuntimeAssets?: boolean;
}

/** A single Vector component emitted by a driver. */
export interface VectorComponent {
  /** Top-level component name in vector.yaml. Must be unique across
   *  the entire bundle. Convention: prefix with driver id and
   *  connection.id to avoid collisions between drivers and between
   *  multiple connections using the same driver. */
  key: string;
  /** Where the component goes in vector.yaml. `source` is anything
   *  receiving data from outside (exec, http_client, http_server).
   *  `transform` is anything operating on events from upstream
   *  components (remap, filter, dedupe, reduce, sample, throttle). */
  kind: "source" | "transform";
  /** YAML body for the component. Indented one level (4 spaces) so
   *  it sits cleanly under `<sources|transforms>.<key>:`. */
  yaml: string;
}

/** Caller's view of which platform components the user picked. */
export type ProviderSelection =
  | { kind: "list"; sources: SourceRef[] }
  | { kind: "all" };

/** The driver's contribution to the bundle. The driver decides
 *  how many Vector components to emit and how they wire together
 *  internally. The renderer just plugs `outputKey` into downstream
 *  monitor / sink pipelines. */
export interface DriverPipeline {
  /** Source + transform components the driver wants in the bundle. */
  components: VectorComponent[];
  /** Vector component name that produces the driver's normalized
   *  output stream. Downstream tag_conn / tag_received transforms
   *  read from this key. Must match one of the `components[].key`. */
  outputKey: string;
  /** Env vars the driver needs at runtime. The caller fills `value`
   *  from stored credentials / external account / user input. */
  envVars: EnvVarSpec[];
  /** Dockerfile install steps the forwarder image needs. */
  dockerfileDeps: DockerfileDep[];
  /** Runtime helper files this driver needs. Written under assets/<driver-id>. */
  runtimeAssets?: RuntimeAsset[];
  /** Optional manifest entries describing the emitted components.
   *  Each entry's id should match a `components[].key`. Consumers that
   *  display per-component status can use these; others can ignore them. */
  manifest?: ComponentManifestEntry[];
}

/** Static metadata about a driver's runtime behavior. Callers read
 *  this to gate UI affordances and set user expectations without
 *  trying inputs against `generatePipeline` to see what works.
 *
 *  Grows by adding optional fields; existing consumers don't have
 *  to handle absence of fields that didn't exist when they were
 *  written. */
export interface ProviderCapabilities {
  /** Which selection kinds the driver accepts via generatePipeline:
   *
   *  - `"list"` only: caller must supply an explicit list of sources.
   *    Most per-component drivers (today's flyctl logs, etc.).
   *  - `"all"` only: the platform exposes one account-wide stream
   *    and nothing finer-grained. The renderer passes
   *    `{ kind: "all" }`; sources are not selectable.
   *  - `"both"`: the driver supports either. Today's
   *    supabase-edge-logs (one project poll either filters to picked
   *    functions or keeps everything).
   */
  selection: "all" | "list" | "both";
}

/** The provider-driver contract. One driver = one transport (e.g.
 *  cloudflare-worker-tail, fly-log-tail).
 *
 *  This is the OSS surface: pure renderer + API client. Anything
 *  web-shaped (form schemas, OAuth start paths, paste button copy)
 *  lives outside these driver packages. That keeps the
 *  @logtura/driver-* packages narrow enough for outside contributors
 *  to ship driver PRs without touching routing code. */
export interface ProviderDriver<TCreds = unknown> {
  readonly id: string;
  readonly displayName: string;
  /** Friendly noun used in UI labels ("Worker", "App"). */
  readonly sourceLabel: string;
  /** Static metadata about runtime behavior (what selection kinds
   *  the driver accepts, etc). See ProviderCapabilities. */
  readonly capabilities: ProviderCapabilities;

  /** Verify credentials, return accessible accounts. */
  verifyCredentials(credentials: TCreds): Promise<ProviderAccount[]>;

  /** Optional freshness check for stored creds at bundle time. */
  checkCredentialFreshness?(credentials: TCreds): Promise<{
    fresh: boolean;
    reason?: string;
    expiresAt?: number | null;
  }>;

  /** Enumerate log sources for an authenticated account. */
  discoverSources(input: {
    credentials: TCreds;
    accountId: string;
  }): Promise<DiscoveredSource[]>;

  /** Render this connection's complete driver-side pipeline.
   *  Returns Vector source and transform components, runtime env
   *  vars, Dockerfile install steps, and optional manifest entries.
   *  The renderer plugs the returned `outputKey` into downstream
   *  monitor / sink wiring; the driver controls everything inside
   *  the sub-graph. */
  generatePipeline(input: {
    connection: ConnectionRef;
    selection: ProviderSelection;
  }): DriverPipeline;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class DestinationError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "DestinationError";
  }
}

// ---- Destination driver contract -------------------------------------

export type DestinationFlow = "logs" | "metrics";

export interface SinkBundle {
  preSinkTransforms?: Array<{ key: string; yaml: string }>;
  sink?: { key: string; yaml: string };
  sinks?: Array<{ key: string; yaml: string }>;
}

/** The destination-driver contract. Pure renderer + (optional)
 *  config verifier. The CLI passes parsed destination config. */
export interface DestinationDriver<TConfig = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly flows: readonly DestinationFlow[];

  verifyConfig?(config: TConfig): Promise<void>;

  generateSinkBundle(input: {
    config: TConfig;
    inputs: string[];
    sinkKey: string;
    envVarName: string;
  }): SinkBundle;

  runtimeEnvVars(input: {
    config: TConfig;
    envVarName: string;
    displayName: string;
  }): EnvVarSpec[];

  envVarValue(config: TConfig, envVarName: string): string | null;
}

// ---- Bundle generation -----------------------------------------------

/** Decrypted bundle of inputs for the renderer. The caller is
 *  responsible for fetching + decrypting credentials before
 *  calling generateBundle; the renderer doesn't talk to storage. */
export interface GeneratorConnection {
  connection: Connection;
  /** Components the user picked. Empty array is valid (zero-source
   *  connections are useful for heartbeat-only deploys). Ignored
   *  when `selectAll` is true. */
  selectedSources: Source[];
  /** When true, the driver subscribes to every component visible to
   *  the connection's account, including future additions. Requires
   *  the driver to declare `supportsAllSelection: true`. */
  selectAll?: boolean;
  /** Decrypted credentials matching the driver's TCreds shape.
   *  Optional when the renderer should emit placeholders rather
   *  than inlining values (e.g., self-deploy bundle UI). */
  credentials?: Record<string, unknown>;
}

export interface GeneratorMonitor {
  monitor: Monitor;
  sinks: GeneratorSink[];
}

export interface GeneratorSink {
  sink: Sink;
  destination: Destination;
  /** Decrypted destination config matching the driver's TConfig. */
  destinationConfig: unknown;
}

export interface GenerateInput {
  /** Drivers to look up by id. Caller registers what they want
   *  available — no global registry, no implicit side-effects. */
  providers: ProviderDriver[];
  destinations: DestinationDriver[];

  /** One or more connections feeding this bundle's pipeline. */
  connections: GeneratorConnection[];

  /** Monitor definitions with their sinks pre-joined. */
  monitors: GeneratorMonitor[];

  /** Heartbeat config; one of two shapes today. */
  heartbeat?: {
    kind: "logtura" | "none";
    deploymentId: string;
    appUrl: string;
  };

  /** Metrics-target config — none / a built-in Logtura sink / a
   *  destination that accepts the "metrics" flow. */
  metrics?:
    | { kind: "none" }
    | { kind: "logtura"; deploymentId: string; appUrl: string }
    | {
        kind: "destination";
        destination: Destination;
        destinationConfig: unknown;
      };
}

export interface BundleEnvVar {
  name: string;
  description: string;
  source: "credential" | "external_account_id" | "destination" | "manual";
  value: string | null;
  helpUrl?: string;
  staleReason?: string;
  credentialExpiresAt?: number | null;
}

export interface ComponentManifestEntry {
  id: string;
  role:
    | "source"
    | "sink"
    | "normalize"
    | "tag_source"
    | "monitor_filter"
    | "sink_filter"
    | "sink_format"
    | "internal_metrics"
    | "heartbeat"
    | "metrics"
    | "prom_exporter"
    | "stdout";
  category: "primary" | "plumbing";
  label: string;
  detail?: string;
  links?: {
    connectionId?: string;
    sourceId?: string;
    parentId?: string;
    monitorId?: string;
    sinkId?: string;
    destinationId?: string;
  };
}

export interface GeneratedBundle {
  vectorYaml: string;
  dockerfile: string;
  runtimeAssets: GeneratedRuntimeAsset[];
  runCommand: string;
  envVars: BundleEnvVar[];
  selectedCount: number;
  monitorSummary: string;
  componentManifest: ComponentManifestEntry[];
}
