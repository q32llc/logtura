import { datadogMetricsDriver } from "@logtura/destination-datadog-metrics";
import { prometheusRemoteWriteDriver } from "@logtura/destination-prometheus-remote-write";
import { slackDriver } from "@logtura/destination-slack";
import { webhookDriver } from "@logtura/destination-webhook";
import { datadogMetricsConnect } from "./connect/datadog-metrics";
import { prometheusRemoteWriteConnect } from "./connect/prometheus-remote-write";
import { slackConnect } from "./connect/slack";
import type { DestinationConnectAdapter } from "./connect/types";
import { webhookConnect } from "./connect/webhook";
import type { DestinationDriver, DestinationFlow } from "./types";

const REGISTRY: Record<string, DestinationDriver> = {
  [slackDriver.id]: slackDriver as DestinationDriver,
  [webhookDriver.id]: webhookDriver as DestinationDriver,
  [datadogMetricsDriver.id]: datadogMetricsDriver as DestinationDriver,
  [prometheusRemoteWriteDriver.id]:
    prometheusRemoteWriteDriver as DestinationDriver,
};

const CONNECT: Record<string, DestinationConnectAdapter> = {
  [slackConnect.driverId]: slackConnect as DestinationConnectAdapter,
  [webhookConnect.driverId]: webhookConnect as DestinationConnectAdapter,
  [datadogMetricsConnect.driverId]:
    datadogMetricsConnect as DestinationConnectAdapter,
  [prometheusRemoteWriteConnect.driverId]:
    prometheusRemoteWriteConnect as DestinationConnectAdapter,
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

export function getDestinationConnect(
  id: string,
): DestinationConnectAdapter | null {
  return CONNECT[id] ?? null;
}

export type { DestinationConnectAdapter } from "./connect/types";
export type { DestinationDriver, DestinationFlow, SinkBlock } from "./types";
export { DestinationError } from "./types";
