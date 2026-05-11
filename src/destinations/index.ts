import { datadogMetricsDriver } from "@logtura/destination-datadog-metrics";
import { prometheusRemoteWriteDriver } from "@logtura/destination-prometheus-remote-write";
import { slackDriver } from "@logtura/destination-slack";
import { webhookDriver } from "@logtura/destination-webhook";
import type { DestinationDriver, DestinationFlow } from "./types";

const REGISTRY: Record<string, DestinationDriver> = {
  [slackDriver.id]: slackDriver as DestinationDriver,
  [webhookDriver.id]: webhookDriver as DestinationDriver,
  [datadogMetricsDriver.id]: datadogMetricsDriver as DestinationDriver,
  [prometheusRemoteWriteDriver.id]:
    prometheusRemoteWriteDriver as DestinationDriver,
};

export function listDestinationDriversForFlow(
  flow: DestinationFlow,
): DestinationDriver[] {
  return Object.values(REGISTRY).filter((d) => d.flows.includes(flow));
}

export function getDestinationDriver(id: string): DestinationDriver | null {
  return REGISTRY[id] ?? null;
}

export function listDestinationDrivers(): DestinationDriver[] {
  return Object.values(REGISTRY);
}

export type { DestinationDriver, DestinationFlow, SinkBlock } from "./types";
export { DestinationError } from "./types";
