import { selfDeployFiles } from "@logtura/core";
import { serializeBundleFiles } from "./bundle-files";
import type { DeployTargetDriver, TargetBundle } from "./types";

/**
 * "Other" target — customer didn't tell us where they're deploying, so
 * we can't tailor the bundle. Returns the generic Dockerfile +
 * vector.yaml + a docker-run example. Customer figures out the rest.
 *
 * supportsManaged is false because we can't deploy somewhere we don't
 * know about.
 */
export const otherDriver: DeployTargetDriver<never> = {
  id: "other",
  displayName: "Other / not listed",
  description:
    "Get the generic Dockerfile + vector.yaml + run command. Use it on whatever platform you like — your VPS, Kubernetes, ECS, Cloud Run, anywhere Docker runs.",
  supportsManaged: false,
  formFields: [],

  generateTargetBundle({ sourceBundle }): TargetBundle {
    const files = serializeBundleFiles(selfDeployFiles(sourceBundle), {Dockerfile: "dockerfile", "vector.yaml": "yaml", "run.sh": "bash"});
    const instructions = [
      "1. Save the files in this bundle to an empty directory, preserving the shown assets/ subdirectories and permission modes.",
      "2. Build:    docker build -t logtura-forwarder .",
      "3. Run:      bash run.sh   (set any missing credential environment variables first)",
      "4. Heartbeat (Prometheus) on :9598 inside the container; Vector API on :8686.",
    ].join("\n");
    return { files, selfDeployInstructions: instructions };
  },
};
