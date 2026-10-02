/**
 * @logtura/core — render Vector configs from structured inputs.
 *
 * Drivers (providers, destinations) and the renderer live here.
 * Bring your own credentials + storage layer; this package is pure
 * TS, no D1 or Hono. Rendering performs no I/O; the optional hosted
 * account client uses an explicitly supplied fetch adapter.
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

export { installBundleFiles, renderEnvFile } from "./install";
export { buildTar, type TarFile } from "./tar";

export { parseConfigDocument, normalizeConfigDocument, canonicalConfigJson, hashConfigDocument, ensureSection, ensureListSection, safeId, defaultProviderName } from "./config";
export type { ConfigParseOptions, ConfigIncludeReader, ParsedConfig } from "./config";
export { LogturaServiceClient, isDeploymentPushRequestId, validateDeploymentConfigCommit, ServiceError, normalizeServiceUrl, authorizeCliDevice } from "./service-client";
export type { ServiceClientOptions, DeviceAuthorization, AccountCredential, DevicePoll, ServiceUser, DeploymentConfigExport, DeploymentConfigPush, DeploymentConfigCommit, DeploymentPushReceipt } from "./service-client";

export { manifestSecretName, exportDeploymentManifest, parseDeploymentManifest, normalizeDeploymentManifest, createSecretVersioner, validateDeploymentInput } from "./manifest";
export type { DeploymentManifest, SecretReference, SecretVersioner } from "./manifest";
export { editDeploymentManifest, diffDeploymentManifests } from "./graph";
export type { ManifestEdit, GraphChange, GraphDiff } from "./graph";
export { planDeploymentChanges, resolveDeploymentDiscovery } from "./reconcile";
export type { GraphInventory, DeploymentChangePlan, StoredConnection, StoredSource, StoredDestination, StoredSink } from "./reconcile";

export { validateDeploymentTarget } from "./deployment-target";
export type { DeploymentTarget } from "./deployment-target";

export { isInstanceId, validateDeploymentActivation, validateDeploymentInstanceReceipt, validateDeploymentAppliedReport, validateDeploymentConfigurationState } from "./deployment-state";
export type { DeploymentConfigurationState, DeploymentInstanceActivation, DeploymentInstanceReceipt, DeploymentAppliedReport } from "./deployment-state";

export { DeploymentReportingClient } from "./deployment-reporting";

export { GENERATOR_VERSION, VECTOR_VERSION, validateForwarderRuntimeArtifact, compileForwarderRuntime, verifyLoadedForwarder, reportLoadedForwarder } from "./runtime";
export type { ForwarderRuntimeArtifact, LoadedForwarderObservation, ForwarderReportCheckpoint, ForwarderReportStore } from "./runtime";
export { FORWARDER_NODE_IMAGE, runtimeImageFiles, runtimeImageEntrypoint } from "./runtime-image";

export { FlyMachinesClient, FlyMachineError, validateFlyMachine, immutableFlyImage, flyRollbackConfig, matchesFlyConfig, applyFlyMachine } from "./fly";
export type { FlyMachine, FlyVolume, FlyMachineConfig, FlyMachinePlan } from "./fly";
export { FLY_RUNTIME_DIRECTORY, validateFlyRuntimeVolume, planFlyRuntime } from "./fly-runtime";

export {parseMetricsBody, emptySnapshot, applyMetricsToSnapshot, rateFor} from "./metrics";
export type {ComponentKind, ComponentMetrics, MetricsSnapshot, ParsedMetric} from "./metrics";
