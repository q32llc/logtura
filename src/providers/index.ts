import { listProviders as publicProviders } from "@logtura/cli/providers";
import { cloudflareAiGatewayConnect } from "./connect/cloudflare-ai-gateway";
import { cloudflareWorkerTailConnect } from "./connect/cloudflare-worker-tail";
import { flyLogTailConnect } from "./connect/fly-log-tail";
import { railwayLogsConnect } from "./connect/railway-logs";
import { supabaseEdgeLogsConnect } from "./connect/supabase-edge-logs";
import { vercelLogsConnect } from "./connect/vercel-logs";
import type { ProviderConnectAdapter } from "./connect/types";
import type { ProviderDriver } from "./types";

/** SaaS-side connect-UX adapters keyed by driver id. The OSS
 *  driver packages don't know any of these exist; we look up the
 *  adapter by `driver.id` when rendering the connect screen or
 *  parsing the create-connection form. */
const CONNECT: Record<string, ProviderConnectAdapter> = {
  [cloudflareWorkerTailConnect.driverId]:
    cloudflareWorkerTailConnect as ProviderConnectAdapter,
  [cloudflareAiGatewayConnect.driverId]:
    cloudflareAiGatewayConnect as ProviderConnectAdapter,
  [flyLogTailConnect.driverId]: flyLogTailConnect as ProviderConnectAdapter,
  [railwayLogsConnect.driverId]:
    railwayLogsConnect as ProviderConnectAdapter,
  [supabaseEdgeLogsConnect.driverId]:
    supabaseEdgeLogsConnect as ProviderConnectAdapter,
  [vercelLogsConnect.driverId]: vercelLogsConnect as ProviderConnectAdapter,
};

// Service availability follows its explicit connect adapters; standalone custom
// drivers are not enabled on the website merely by entering the public registry.
const REGISTRY: Record<string, ProviderDriver> = Object.fromEntries(
  publicProviders().filter(driver => Object.hasOwn(CONNECT, driver.id)).map(driver => [driver.id, driver]),
);

export function getProvider(id: string): ProviderDriver | null {
  return Object.hasOwn(REGISTRY, id) ? REGISTRY[id]! : null;
}

export function listProviders(): ProviderDriver[] {
  return Object.values(REGISTRY);
}

export function getProviderConnect(
  id: string,
): ProviderConnectAdapter | null {
  return Object.hasOwn(CONNECT, id) ? CONNECT[id]! : null;
}

export type { ProviderConnectAdapter } from "./connect/types";
export type { ConnectFlow, FormField } from "./connect/types";
export type { ProviderDriver } from "./types";
export { ProviderError } from "./types";
export type {
  ConnectionRef,
  DiscoveredSource,
  DockerfileDep,
  EnvVarSpec,
  ProviderAccount,
  SourceRef,
  VectorComponent,
} from "./types";
