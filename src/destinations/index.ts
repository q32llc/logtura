import { datadogMetricsDriver } from "./datadog-metrics";
import { prometheusRemoteWriteDriver } from "./prometheus-remote-write";
import { slackDriver } from "./slack";
import type { DestinationDriver, DestinationFlow } from "./types";
import { webhookDriver } from "./webhook";

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
