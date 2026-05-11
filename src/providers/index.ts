import { cloudflareDriver } from "./cloudflare";
import { flyDriver } from "./fly";
import type { ProviderDriver } from "./types";

const REGISTRY: Record<string, ProviderDriver> = {
  [cloudflareDriver.id]: cloudflareDriver as ProviderDriver,
  [flyDriver.id]: flyDriver as ProviderDriver,
};

export function getProvider(id: string): ProviderDriver | null {
  return REGISTRY[id] ?? null;
}

export function listProviders(): ProviderDriver[] {
  return Object.values(REGISTRY);
}

export type { ProviderDriver } from "./types";
export { ProviderError } from "./types";
export type {
  ConnectionRef,
  DiscoveredSource,
  DockerfileDep,
  EnvVarSpec,
  FormField,
  ProviderAccount,
  SourceBlock,
  SourceRef,
} from "./types";
