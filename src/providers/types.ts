/**
 * Re-exports the provider-driver contract from @logtura/core so
 * SaaS-side modules (drivers, routes, the generator adapter) can
 * keep importing from "../providers/types" without knowing the
 * package boundary moved.
 *
 * When you want to add a new provider driver, the canonical types
 * live in @logtura/core/types — these re-exports just spare every
 * call site from a churn rename.
 */
export type {
  ConnectFlow,
  ConnectionRef,
  DiscoveredSource,
  DockerfileDep,
  EnvVarSpec,
  FormField,
  ProviderAccount,
  ProviderDriver,
  SourceBlock,
  SourceRef,
} from "@logtura/core";

export { ProviderError } from "@logtura/core";
