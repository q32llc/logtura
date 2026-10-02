import { flyDriver } from "./fly";
import { otherDriver } from "./other";
import type { DeployTargetDriver } from "./types";

const REGISTRY: Record<string, DeployTargetDriver> = {
  [flyDriver.id]: flyDriver as DeployTargetDriver,
  [otherDriver.id]: otherDriver as DeployTargetDriver,
};

export function getDeployTargetDriver(id: string): DeployTargetDriver | null {
  return Object.hasOwn(REGISTRY, id) ? REGISTRY[id]! : null;
}

export function listDeployTargetDrivers(): DeployTargetDriver[] {
  return Object.values(REGISTRY);
}

export type {
  BundleFile,
  DeployStatus,
  DeployTargetDriver,
  TargetBundle,
} from "./types";
export { DeployTargetError } from "./types";
