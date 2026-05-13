import { cloudflareAiGatewayDriver } from "@logtura/driver-cloudflare-ai-gateway";
import { cloudflareWorkerTailDriver } from "@logtura/driver-cloudflare-worker-tail";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { railwayLogsDriver } from "@logtura/driver-railway-logs";
import { supabaseEdgeLogsDriver } from "@logtura/driver-supabase-edge-logs";
import { vercelLogsDriver } from "@logtura/driver-vercel-logs";
import { datadogMetricsDriver } from "@logtura/destination-datadog-metrics";
import { prometheusRemoteWriteDriver } from "@logtura/destination-prometheus-remote-write";
import { slackDriver } from "@logtura/destination-slack";
import { webhookDriver } from "@logtura/destination-webhook";
import {
  customVectorDestination,
  customVectorProvider,
} from "@logtura/custom-vector";
import type { DestinationDriver, ProviderDriver } from "@logtura/core";

export function listProviders(): ProviderDriver[] {
  return [
    cloudflareWorkerTailDriver,
    cloudflareAiGatewayDriver,
    flyLogTailDriver,
    railwayLogsDriver,
    supabaseEdgeLogsDriver,
    customVectorProvider,
    vercelLogsDriver,
  ] as ProviderDriver[];
}

export function listDestinations(): DestinationDriver[] {
  return [
    slackDriver,
    webhookDriver,
    datadogMetricsDriver,
    prometheusRemoteWriteDriver,
    customVectorDestination,
  ] as DestinationDriver[];
}

export function getProvider(id: string): ProviderDriver | null {
  return listProviders().find((p) => p.id === id) ?? null;
}

export function getDestination(id: string): DestinationDriver | null {
  return listDestinations().find((d) => d.id === id) ?? null;
}
