import { assembleDeploymentBundle } from "../../bundle-assembly";
import {
  decryptDeployTargetCredentials,
  getDeployTargetById,
  updateDeployment,
} from "../../db";
import {
  base64Encode,
  createFlyApp,
  createFlyMachine,
  getFlyApp,
  listFlyMachines,
  resolveFlyOrgSlug,
  updateFlyMachine,
  type FlyMachineConfig,
} from "../../deploy-targets/fly-machines";
import type { Env } from "../../env";
import type {
  FlyDeployPayload,
  FlyDeployResult,
  JobRecord,
} from "../types";

const DEFAULT_REGION = "iad";
const VECTOR_IMAGE = "timberio/vector:latest-debian";
const MACHINE_NAME = "forwarder";

/**
 * Deploy a logtura forwarder to Fly. Idempotent: re-running picks up
 * the existing app + machine and updates the machine config in place,
 * so a config change (new monitor, rotated credential) just redeploys.
 *
 * App name is derived from the deployment id and stays stable across
 * runs. The machine carries the generated vector.yaml as a config.files
 * entry — no per-customer image build.
 */
export async function runFlyDeploy(
  env: Env,
  job: JobRecord,
): Promise<FlyDeployResult> {
  const payload = job.payload as unknown as FlyDeployPayload;
  if (!payload.deploymentId || !payload.deployTargetId) {
    throw new Error("fly_deploy payload missing ids");
  }

  const target = await getDeployTargetById(
    env.DB,
    job.userId,
    payload.deployTargetId,
  );
  if (!target) throw new Error("deploy_target not found");
  if (target.kind !== "fly") {
    throw new Error(`expected fly target, got ${target.kind}`);
  }

  const creds = await decryptDeployTargetCredentials<{ apiToken: string }>(
    env,
    target,
  );
  if (!creds.apiToken) throw new Error("fly token missing from deploy_target");

  const assembled = await assembleDeploymentBundle(
    env,
    job.userId,
    payload.deploymentId,
  );
  const { deployment, bundle } = assembled;

  if (!assembled.credentialIsFresh) {
    throw new Error(
      `connection credential is unusable: ${assembled.credentialStaleReason ?? "stale"}`,
    );
  }

  // Every env var must have a value at deploy time. The bundle UI
  // tolerates user-supplied "manual" entries, but for managed deploy
  // we require everything resolved up front (token freshness check
  // above covers credentials; destinations are always inlined).
  const env_: Record<string, string> = {};
  for (const v of bundle.envVars) {
    if (v.value === null) {
      throw new Error(
        `env var ${v.name} has no value — connect/configure the source before deploying`,
      );
    }
    env_[v.name] = v.value;
  }

  const orgSlug = payload.orgSlug ?? (await resolveFlyOrgSlug(creds.apiToken));
  const region = payload.region ?? DEFAULT_REGION;
  const appName = flyAppNameFor(deployment.id);

  const existingApp = await getFlyApp(creds.apiToken, appName);
  if (!existingApp) {
    await createFlyApp(creds.apiToken, { appName, orgSlug });
  }

  const machineConfig: FlyMachineConfig = {
    image: VECTOR_IMAGE,
    env: env_,
    files: [
      {
        guest_path: "/etc/vector/vector.yaml",
        raw_value: base64Encode(bundle.vectorYaml),
      },
    ],
    init: { cmd: ["vector", "--config", "/etc/vector/vector.yaml"] },
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
    restart: { policy: "always" },
  };

  const existingMachines = await listFlyMachines(creds.apiToken, appName);
  const target_machine = existingMachines.find((m) => m.name === MACHINE_NAME);

  let machineId: string;
  if (target_machine) {
    const updated = await updateFlyMachine(creds.apiToken, {
      appName,
      machineId: target_machine.id,
      config: machineConfig,
    });
    machineId = updated.id;
  } else {
    const created = await createFlyMachine(creds.apiToken, {
      appName,
      name: MACHINE_NAME,
      region,
      config: machineConfig,
    });
    machineId = created.id;
  }

  await updateDeployment(env.DB, job.userId, deployment.id, {
    status: "running",
    externalId: `fly:${appName}:${machineId}`,
  });

  return {
    appName,
    machineId,
    orgSlug,
    region,
    appUrl: `https://fly.io/apps/${appName}`,
  };
}

/** Stable, DNS-safe Fly app name. Globally unique on Fly, so we
 *  prefix with "logtura-" + the deployment id minus its "dep_" prefix
 *  (random base32, already DNS-safe). */
export function flyAppNameFor(deploymentId: string): string {
  const suffix = deploymentId.replace(/^dep_/, "").toLowerCase();
  // Fly app names: ≤30 chars, [a-z0-9-]. Strip non-conforming and
  // keep enough to stay globally unique while leaving room for the
  // "logtura-" prefix.
  const safe = suffix.replace(/[^a-z0-9-]/g, "").slice(0, 20);
  return `logtura-${safe}`;
}
