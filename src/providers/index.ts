import { cloudflareAiGatewayDriver } from "@logtura/driver-cloudflare-ai-gateway";
import { cloudflareWorkerTailDriver } from "@logtura/driver-cloudflare-worker-tail";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { railwayLogsDriver } from "@logtura/driver-railway-logs";
import { supabaseEdgeLogsDriver } from "@logtura/driver-supabase-edge-logs";
import { vercelLogsDriver } from "@logtura/driver-vercel-logs";
import { cloudflareAiGatewayConnect } from "./connect/cloudflare-ai-gateway";
import { cloudflareWorkerTailConnect } from "./connect/cloudflare-worker-tail";
import { flyLogTailConnect } from "./connect/fly-log-tail";
import { railwayLogsConnect } from "./connect/railway-logs";
import { supabaseEdgeLogsConnect } from "./connect/supabase-edge-logs";
import { vercelLogsConnect } from "./connect/vercel-logs";
import type { ProviderConnectAdapter } from "./connect/types";
import type { ProviderDriver } from "./types";

const REGISTRY: Record<string, ProviderDriver> = {
  [cloudflareWorkerTailDriver.id]: cloudflareWorkerTailDriver as ProviderDriver,
  [cloudflareAiGatewayDriver.id]: cloudflareAiGatewayDriver as ProviderDriver,
  [flyLogTailDriver.id]: flyLogTailDriver as ProviderDriver,
  [railwayLogsDriver.id]: railwayLogsDriver as ProviderDriver,
  [supabaseEdgeLogsDriver.id]: supabaseEdgeLogsDriver as ProviderDriver,
  [vercelLogsDriver.id]: vercelLogsDriver as ProviderDriver,
};

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
