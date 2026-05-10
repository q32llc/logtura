import { slackDriver } from "./slack";
import type { DestinationDriver } from "./types";
import { webhookDriver } from "./webhook";

const REGISTRY: Record<string, DestinationDriver> = {
  [slackDriver.id]: slackDriver as DestinationDriver,
  [webhookDriver.id]: webhookDriver as DestinationDriver,
};

export function getDestinationDriver(id: string): DestinationDriver | null {
  return REGISTRY[id] ?? null;
}

export function listDestinationDrivers(): DestinationDriver[] {
  return Object.values(REGISTRY);
}

export type { DestinationDriver, SinkBlock } from "./types";
export { DestinationError } from "./types";
