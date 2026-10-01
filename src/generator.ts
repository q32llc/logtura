/**
 * SaaS-side adapter for @logtura/core. Maps the DB-row shapes
 * stored in D1 to the plain entity shapes the renderer expects,
 * then forwards to @logtura/core's `generateBundle`. The
 * renderer itself lives in `packages/core/`.
 *
 * Keeping this thin adapter (rather than rewiring every caller to
 * use plain shapes directly) means routes, jobs, tests, and the
 * deploy chain all keep their DB-typed inputs. The plain shapes
 * are an internal hop — nobody upstream needs to know.
 */
import {
  generateBundle as coreGenerateBundle,
  type GeneratedBundle,
  type GenerateInput as CoreGenerateInput,
} from "@logtura/core";
import type {
  ConnectionRow,
  DestinationRow,
  LogSourceRow,
  MonitorRow,
  SinkRow,
} from "./db";
import { parseFilterSteps } from "./db";
import { listDestinationDrivers } from "./destinations";
import { listProviders } from "./providers";

export type {
  GeneratedBundle,
  BundleEnvVar,
  ComponentManifestEntry,
} from "@logtura/core";

// SaaS-shaped generator inputs. The renderer in @logtura/core
// takes plain entity shapes; here we wrap the DB rows so call
// sites don't have to do the mapping themselves.
export interface GeneratorConnection {
  connection: ConnectionRow;
  selectedSources: LogSourceRow[];
  /** When true, the driver subscribes to every component in this
   *  connection's account, including future additions. Driver must
   *  declare capabilities.selection === "all" or "both". */
  selectAll?: boolean;
  credentials?: Record<string, unknown>;
}

export interface GeneratorSink {
  sink: SinkRow;
  destination: DestinationRow;
  destinationConfig: unknown;
}

export interface GeneratorMonitor {
  monitor: MonitorRow;
  sinks: GeneratorSink[];
}

export interface GenerateInput {
  runtimeEnv?: Record<string,string>;
  connections: GeneratorConnection[];
  monitors: GeneratorMonitor[];
  heartbeat?: {
    kind: "logtura" | "none";
    deploymentId: string;
    appUrl: string;
  };
  metrics?:
    | { kind: "none" }
    | { kind: "logtura"; deploymentId: string; appUrl: string }
    | {
        kind: "destination";
        destination: DestinationRow;
        destinationConfig: unknown;
      };
}

export function generateBundle(input: GenerateInput): GeneratedBundle {
  return coreGenerateBundle(toCoreInput(input));
}

export function toCoreInput(input: GenerateInput): CoreGenerateInput {
  return {
    runtimeEnv: input.runtimeEnv,
    providers: listProviders(),
    destinations: listDestinationDrivers(),
    connections: input.connections.map((c) => ({
      connection: rowToConnection(c.connection),
      selectedSources: c.selectedSources.map(rowToSource),
      selectAll: c.selectAll,
      credentials: c.credentials,
    })),
    monitors: input.monitors.map((m) => ({
      monitor: rowToMonitor(m.monitor),
      sinks: m.sinks.map((s) => ({
        sink: rowToSink(s.sink),
        destination: rowToDestination(s.destination),
        destinationConfig: s.destinationConfig,
      })),
    })),
    heartbeat: input.heartbeat,
    metrics:
      input.metrics?.kind === "destination"
        ? {
            kind: "destination",
            destination: rowToDestination(input.metrics.destination),
            destinationConfig: input.metrics.destinationConfig,
          }
        : input.metrics,
  };
}

function rowToConnection(c: ConnectionRow) {
  return {
    id: c.id,
    provider: c.provider,
    displayName: c.display_name,
    externalAccountId: c.external_account_id,
  };
}

function rowToSource(s: LogSourceRow) {
  return {
    id: s.id,
    externalId: s.external_id,
    displayName: s.display_name,
    sourceKind: s.source_kind,
    metadata: s.metadata_json
      ? (JSON.parse(s.metadata_json) as Record<string, unknown>)
      : null,
  };
}

function rowToMonitor(m: MonitorRow) {
  return {
    id: m.id,
    connectionId: m.connection_id,
    displayName: m.display_name,
    filterSteps: parseFilterSteps(m.filter_steps_json),
    enabled: m.enabled === 1,
  };
}

function rowToSink(s: SinkRow) {
  return {
    id: s.id,
    filterSteps: parseFilterSteps(s.filter_steps_json),
  };
}

function rowToDestination(d: DestinationRow) {
  return {
    id: d.id,
    kind: d.kind,
    displayName: d.display_name,
  };
}
