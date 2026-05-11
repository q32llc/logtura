import { cloudflareAiGatewayDriver } from "@logtura/driver-cloudflare-ai-gateway";
import { cloudflareWorkerTailDriver } from "@logtura/driver-cloudflare-worker-tail";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { supabaseEdgeLogsDriver } from "@logtura/driver-supabase-edge-logs";
import type { ProviderDriver } from "./types";

const REGISTRY: Record<string, ProviderDriver> = {
  [cloudflareWorkerTailDriver.id]: cloudflareWorkerTailDriver as ProviderDriver,
  [cloudflareAiGatewayDriver.id]: cloudflareAiGatewayDriver as ProviderDriver,
  [flyLogTailDriver.id]: flyLogTailDriver as ProviderDriver,
  [supabaseEdgeLogsDriver.id]: supabaseEdgeLogsDriver as ProviderDriver,
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
