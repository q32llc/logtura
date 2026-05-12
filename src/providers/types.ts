/**
 * Re-exports the provider-driver contract from @logtura/core so
 * existing SaaS imports keep compiling. ConnectFlow + FormField are
 * SaaS-side now (src/providers/connect/types.ts) and are re-exported
 * from src/providers/index.ts.
 */
export type {
  ConnectionRef,
  DiscoveredSource,
  DockerfileDep,
  EnvVarSpec,
  ProviderAccount,
  ProviderDriver,
  SourceRef,
  VectorComponent,
} from "@logtura/core";

export { ProviderError } from "@logtura/core";
