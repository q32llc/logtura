/**
 * @logtura/core — render Vector configs from structured inputs.
 *
 * Drivers (providers, destinations) and the renderer live here.
 * Bring your own credentials + storage layer; this package is pure
 * TS, no D1, no Hono, no I/O.
 */

export { generateBundle, renderDockerfile } from "./render";

export type {
  // Plain entity shapes the caller maps from their storage.
  Connection,
  Source,
  Monitor,
  Sink,
  Destination,

  // The "monitor pipeline" DSL.
  FilterStep,
  LogturaEvent,
  LogturaException,

  // Driver contracts.
  ProviderDriver,
  DestinationDriver,
  ConnectionRef,
  SourceRef,
  DiscoveredSource,
  ProviderAccount,
  EnvVarSpec,
  DockerfileDep,
  RuntimeAsset,
  GeneratedRuntimeAsset,
  RenderDockerfileOptions,
  VectorComponent,
  DriverPipeline,
  ProviderCapabilities,
  ProviderSelection,
  SinkBundle,
  DestinationFlow,

  // Bundle inputs / outputs.
  GenerateInput,
  GeneratorConnection,
  GeneratorMonitor,
  GeneratorSink,
  GeneratedBundle,
  BundleEnvVar,
  ComponentManifestEntry,
} from "./types";

export { DestinationError, ProviderError } from "./types";
