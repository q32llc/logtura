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

// ---- Provider driver contract ----------------------------------------

/** Caller view of a connection that the driver needs at code-gen
 *  time — the same shape as the public Connection but with `id`
 *  kept narrow to what drivers read. (Most drivers only need id +
 *  externalAccountId; some need displayName for naming.) */
export interface ConnectionRef {
  id: string;
  externalAccountId: string | null;
  displayName: string;
}

/** Caller view of a single source row for the driver. */
export interface SourceRef {
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

/** Env-var the bundle expects at runtime. The host fills `value`
 *  from stored credentials / external account / user input. */
export interface EnvVarSpec {
  name: string;
  description: string;
  source: "credential" | "external_account_id" | "destination" | "manual";
  credentialPath?: string;
  helpUrl?: string;
}

/** Dockerfile install step the driver needs in the forwarder image
 *  (for self-deploy users). */
export interface DockerfileDep {
  install: string;
  aptPackages?: string[];
}

/** A driver's emitted Vector source block. */
export interface SourceBlock {
  /** Unique YAML key under `sources:`. */
  key: string;
  /** YAML body for `sources.<key>:` (without the key itself). */
  yaml: string;
}

/** The provider-driver contract. One driver = one transport (e.g.
 *  cloudflare-worker-tail, fly-log-tail).
 *
 *  This is the OSS surface — pure renderer + API client. Anything
 *  web-shaped (form schemas, OAuth start paths, paste button copy)
 *  lives in a host-side adapter, not here. That keeps the
 *  @logtura/driver-* packages narrow enough for outside
 *  contributors to ship driver PRs without touching SaaS routing. */
export interface ProviderDriver<TCreds = unknown> {
  readonly id: string;
  readonly displayName: string;
  /** Friendly noun used in UI labels ("Worker", "App"). */
  readonly sourceLabel: string;

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

  /** Render a single source block (key + yaml) for a selected
   *  source. The renderer concatenates these into `sources:`. */
  generateSourceBlock(input: {
    source: SourceRef;
    connection: ConnectionRef;
  }): SourceBlock;

  /** Render this driver's one normalize transform (fans in every
   *  source it emitted). One driver, one transport, one normalize.
   *  Return null if events already carry the uniform shape.
   *
   *  `sources` is the same list whose `generateSourceBlock` results
   *  are wired in as `inputKeys`. Drivers whose log payload carries
   *  the source identity natively (cf-worker `.scriptName`, fly
   *  `.app` injected via jq) can ignore it. Drivers whose payload
   *  identifies the source by an opaque id (eg Supabase Edge
   *  Functions reference functions by UUID, not slug) use it to
   *  inject a UUID → human-slug map into the emitted VRL. */
  generateNormalize?(input: {
    inputKeys: string[];
    connection: ConnectionRef;
    sources: SourceRef[];
  }): { key: string; yaml: string } | null;

  /** Runtime needs — env vars + dockerfile install steps. */
  runtimeSpec(connection: ConnectionRef): {
    envVars: EnvVarSpec[];
    dockerfileDeps: DockerfileDep[];
  };
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
  sink: { key: string; yaml: string };
}

/** The destination-driver contract. Pure renderer + (optional)
 *  config verifier; form schemas + OAuth flows live in a
 *  host-side adapter (see DestinationConnectAdapter SaaS-side). */
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
  selectedSources: Source[];
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

  /** Heartbeat config — host-side; one of two shapes today. */
  heartbeat?: {
    kind: "logtura" | "none";
    deploymentId: string;
    appUrl: string;
  };

  /** Metrics-target config — none / a host-mediated sink / a
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
    monitorId?: string;
    sinkId?: string;
    destinationId?: string;
  };
}

export interface GeneratedBundle {
  vectorYaml: string;
  dockerfile: string;
  runCommand: string;
  envVars: BundleEnvVar[];
  selectedCount: number;
  monitorSummary: string;
  componentManifest: ComponentManifestEntry[];
}
