import type { ComponentMetrics, MetricsSnapshot } from "@logtura/core";
import type { OrderedDeploymentSelection } from "../deployment-selection";
// API response shapes — mirrors what src/index.ts emits. Kept as plain
// types so both the worker and the React app can import them.

export interface ApiUser {
  id: string;
  githubLogin: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface ApiConnection {
  id: string;
  provider: string;
  displayName: string;
  externalAccountId: string | null;
  providerInstallationId: string | null;
  createdAt: number;
  updatedAt: number;
  lastDiscoveredAt: number | null;
}

export interface ApiSource {
  id: string;
  sourceKind: string;
  sourceKindLabel: string;
  externalId: string;
  displayName: string;
  metadata: Record<string, unknown> | null;
  selected: boolean;
  discoveredAt: number;
}

export interface ApiFormField {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  description?: string;
  required: boolean;
}

export type ApiConnectFlow =
  | {
      kind: "external_token";
      url: string;
      buttonLabel: string;
      buttonDescription: string;
      pasteFieldName: string;
      manualInstructions?: string;
    }
  | {
      kind: "oauth_redirect";
      startPath: string;
      buttonLabel: string;
      buttonDescription: string;
    }
  | {
      kind: "cli_session";
      startPath: string;
      pollPath: string;
      buttonLabel: string;
      buttonDescription: string;
    };

export interface ApiDeployTarget {
  id: string;
  kind: string;
  displayName: string;
  externalAccountId: string | null;
  /** Source-provider IDs this deploy target can mint scoped
   *  credentials for. Empty for targets without a bootstrap-mint
   *  path. Drives the "use existing X connection" UI. */
  mintsForProviders: readonly string[];
  createdAt: number;
  updatedAt: number;
}

export interface ApiProvider {
  id: string;
  displayName: string;
  connectFlow: ApiConnectFlow | null;
  formFields: ApiFormField[];
  /** Optional OAuth shortcut that lives alongside connectFlow. When
   *  present, UI renders an OAuth button above the regular PAT-paste
   *  form so both options are reachable from one screen. Today only
   *  supabase-edge-logs surfaces this; the field is generic for
   *  future providers that gain a SaaS-managed OAuth alongside
   *  user-pasted credentials. */
  oauthShortcut?: {
    startPath: string;
    buttonLabel: string;
    buttonDescription: string;
  } | null;
}

export interface ApiEnvVar {
  name: string;
  description: string;
  source: "credential" | "external_account_id" | "destination" | "manual";
  credentialPath?: string;
}

export interface ApiBundle {
  vectorYaml: string;
  dockerfile: string;
  runCommand: string;
  envVars: ApiEnvVar[];
  selectedCount: number;
}

export interface ApiBundleEnvVar {
  name: string;
  description: string;
  source: "credential" | "external_account_id" | "destination" | "manual";
  value: string | null;
  helpUrl?: string;
  /** Set when stored credential exists but is unusable (expired, disabled). */
  staleReason?: string;
  /** ms epoch the credential expires, when known. null = no expiry. */
  credentialExpiresAt?: number | null;
}

export interface ApiBundleFile {
  name: string;
  content: string;
  language?: string;
}

export interface ApiTargetBundle {
  target: { id: string; displayName: string; supportsManaged: boolean };
  files: ApiBundleFile[];
  selfDeployInstructions: string;
  envVars: ApiBundleEnvVar[];
  selectedCount: number;
  monitorSummary: string;
  /** Per-Vector-component metadata so the metrics UI can group rows,
   *  hide plumbing by default, and label primary rows with the
   *  originating entity. Generator emits this; the UI doesn't
   *  pattern-parse component ids. */
  componentManifest: ApiComponentManifestEntry[];
}

export interface ApiComponentManifestEntry {
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

export interface ApiDestinationDriver {
  id: string;
  displayName: string;
  description: string;
  connectFlow: ApiConnectFlow | null;
  formFields: ApiFormField[];
}

export interface ApiDestination {
  id: string;
  kind: string;
  displayName: string;
  /** Which Vector flows this destination accepts. UI filters
   *  destinations by flow when configuring heartbeat/metrics. */
  flows: readonly ("logs" | "metrics")[];
  createdAt: number;
  updatedAt: number;
}

export type FilterStep =
  | { kind: "errors" }
  | { kind: "level"; level: string; mode?: "include" | "exclude" }
  | { kind: "match"; pattern: string; mode: "include" | "exclude"; field?: string }
  | { kind: "rate_limit"; per_minute: number }
  | { kind: "dedup"; window_secs: number; fields?: string[] }
  | { kind: "sample"; rate: number }
  | {
      kind: "rollup";
      window_secs: number;
      group_by?: string[];
      max_samples?: number;
    };

export interface ApiMonitor {
  id: string;
  connectionId: string | null;
  displayName: string;
  filterSteps: FilterStep[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ApiSinkRecord {
  id: string;
  monitorId: string;
  destinationId: string;
  filterSteps: FilterStep[];
  createdAt: number;
}

export interface ApiDeployTargetDriver {
  id: string;
  displayName: string;
  description: string;
  supportsManaged: boolean;
  connectFlow: ApiConnectFlow | null;
  formFields: ApiFormField[];
}

export type ApiDeploymentStatus =
  | "pending"
  | "running"
  | "crashed"
  | "stopped"
  | "detached";

export type ApiMetricsComponent = ComponentMetrics;
export type ApiMetricsSnapshot = MetricsSnapshot;

export interface ApiDeployment {
  /** Absent on older service versions. */
  graphSelection?: OrderedDeploymentSelection | null;
  id: string;
  connectionId: string;
  displayName: string;
  targetKind: string;
  managed: boolean;
  status: ApiDeploymentStatus;
  externalId: string | null;
  /** null = all sources from the connection */
  sourceIds: string[] | null;
  /** null = wildcard (every applicable monitor) */
  monitorIds: string[] | null;
  /** "logtura" | "none" | null. null means "logtura by default". */
  heartbeatTarget: string | null;
  /** "logtura" | "none" | <destination_id> | null. null means
   *  "no metrics export" (we don't emit a metrics sink). */
  metricsTarget: string | null;
  /** Snapshot of latest Vector internal_metrics. null when no
   *  metrics have ever been received. */
  metricsSnapshot: ApiMetricsSnapshot | null;
  /** true iff the generated bundle differs from what's running on
   *  the machine (or no successful deploy has happened yet). Set by
   *  any config mutation; cleared on successful deploy or manual
   *  mark-as-deployed. */
  bundleOutdated: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
}

export type ApiJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ApiJobProgress {
  label: string;
  detail?: string;
  fraction?: number;
}

export interface ApiJob {
  id: string;
  kind: string;
  status: ApiJobStatus;
  /** null for top-level jobs (the ones the UI polls). When non-null,
   *  this is a step kid in the chain. */
  parentJobId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  result: Record<string, unknown> | null;
  /** UX progress hint from the in-flight kid (parents) or this row
   *  itself (kids). null when no handler has set it. */
  progress: ApiJobProgress | null;
}
