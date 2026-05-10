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
  flyAuthHeader,
  getFlyApp,
  listFlyMachines,
  resolveFlyOrgSlug,
  updateFlyMachine,
  type FlyMachineConfig,
} from "../../deploy-targets/fly-machines";
import { dischargeBundle } from "../../deploy-targets/fly-macaroon";
import type { Env } from "../../env";
import type { JobHandlerCtx } from "../queue";
import type {
  FlyCreateOrUpdateMachinePayload,
  FlyDeployPayload,
  FlyDischargeCreateAppPayload,
  FlyWaitRunningPayload,
} from "../types";

const DEFAULT_REGION = "iad";
const VECTOR_IMAGE = "timberio/vector:latest-debian";
const MACHINE_NAME = "forwarder";
/** How long the wait_running chain may run before giving up. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** Delay between wait_running re-queues. */
const POLL_DELAY_SECS = 5;

// --- Step 0: parent ---------------------------------------------------
//
// The parent does no work. Its only job is to spawn the first step kid;
// status flows up through aggregateStatus(parent, kids) on read. Having
// a parent row anyway gives the UI a single id to poll and a clear
// place to attach lock_key for re-click coalescing.

export async function runFlyDeploy(ctx: JobHandlerCtx): Promise<null> {
  const payload = ctx.job.payload as unknown as FlyDeployPayload;
  if (!payload.deploymentId || !payload.deployTargetId) {
    throw new Error("fly_deploy payload missing ids");
  }
  await ctx.events.record({
    kind: "fly_deploy.started",
    message: `Starting Fly deploy for ${payload.deploymentId}`,
    payload: { deployTargetId: payload.deployTargetId },
  });
  await ctx.enqueueSibling({
    kind: "fly_deploy.discharge_create_app",
    payload: {
      parentPayload: payload,
      appName: flyAppNameFor(payload.deploymentId),
    } as unknown as Record<string, unknown>,
  });
  return null;
}

// --- Step 1: discharge + resolve org + create-or-reuse app -----------

export async function runFlyDischargeCreateApp(
  ctx: JobHandlerCtx,
): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as unknown as FlyDischargeCreateAppPayload;
  const parent = p.parentPayload;

  const flyAuth = await loadDischargedAuth(ctx.env, ctx.job.userId, parent);

  const orgSlug =
    parent.orgSlug ?? (await resolveOrgSlugWithFallback(ctx, flyAuth));
  const region = parent.region ?? DEFAULT_REGION;

  const existing = await getFlyApp(flyAuth, p.appName);
  if (!existing) {
    await createFlyApp(flyAuth, { appName: p.appName, orgSlug });
    await ctx.events.record({
      kind: "fly_app.created",
      message: `Created Fly app ${p.appName} in ${orgSlug}`,
    });
  } else {
    await ctx.events.record({
      kind: "fly_app.reused",
      message: `Reusing existing Fly app ${p.appName}`,
    });
  }

  // Spawn next step BEFORE returning, per the spawn-before-markDone
  // discipline. processOne will call complete(succeeded) after we
  // return; if we returned before spawning, the rollup view could
  // briefly see "all-kids-terminal" with no next step queued.
  await ctx.enqueueSibling({
    kind: "fly_deploy.create_or_update_machine",
    payload: {
      parentPayload: parent,
      appName: p.appName,
      orgSlug,
      region,
    } as unknown as Record<string, unknown>,
  });
  return { appName: p.appName, orgSlug, region };
}

// --- Step 2: assemble bundle + create-or-update machine --------------

export async function runFlyCreateOrUpdateMachine(
  ctx: JobHandlerCtx,
): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as unknown as FlyCreateOrUpdateMachinePayload;
  const parent = p.parentPayload;

  const flyAuth = await loadDischargedAuth(ctx.env, ctx.job.userId, parent);

  const assembled = await assembleDeploymentBundle(
    ctx.env,
    ctx.job.userId,
    parent.deploymentId,
  );
  if (!assembled.credentialIsFresh) {
    throw new Error(
      `connection credential is unusable: ${assembled.credentialStaleReason ?? "stale"}`,
    );
  }
  const { deployment, bundle } = assembled;

  const env_: Record<string, string> = {};
  for (const v of bundle.envVars) {
    if (v.value === null) {
      throw new Error(
        `env var ${v.name} has no value — connect/configure the source before deploying`,
      );
    }
    env_[v.name] = v.value;
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

  const existing = await listFlyMachines(flyAuth, p.appName);
  const target = existing.find((m) => m.name === MACHINE_NAME);
  let machineId: string;
  if (target) {
    const updated = await updateFlyMachine(flyAuth, {
      appName: p.appName,
      machineId: target.id,
      config: machineConfig,
    });
    machineId = updated.id;
    await ctx.events.record({
      kind: "fly_machine.updated",
      message: `Updated machine ${machineId} on ${p.appName}`,
    });
  } else {
    const created = await createFlyMachine(flyAuth, {
      appName: p.appName,
      name: MACHINE_NAME,
      region: p.region,
      config: machineConfig,
    });
    machineId = created.id;
    await ctx.events.record({
      kind: "fly_machine.created",
      message: `Created machine ${machineId} on ${p.appName}`,
    });
  }

  await updateDeployment(ctx.env.DB, ctx.job.userId, deployment.id, {
    externalId: `fly:${p.appName}:${machineId}`,
  });

  await ctx.enqueueSibling({
    kind: "fly_deploy.wait_running",
    payload: {
      parentPayload: parent,
      appName: p.appName,
      machineId,
      pollDeadline: Date.now() + RUN_TIMEOUT_MS,
    } as unknown as Record<string, unknown>,
    delaySecs: POLL_DELAY_SECS,
  });
  return { appName: p.appName, machineId, orgSlug: p.orgSlug, region: p.region };
}

// --- Step 3: poll machine state, requeue self until running ---------

export async function runFlyWaitRunning(
  ctx: JobHandlerCtx,
): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as unknown as FlyWaitRunningPayload;
  const parent = p.parentPayload;

  const flyAuth = await loadDischargedAuth(ctx.env, ctx.job.userId, parent);

  const machines = await listFlyMachines(flyAuth, p.appName);
  const m = machines.find((x) => x.id === p.machineId);
  if (!m) {
    throw new Error(`machine ${p.machineId} not found on ${p.appName}`);
  }

  if (m.state === "started") {
    await updateDeployment(ctx.env.DB, ctx.job.userId, parent.deploymentId, {
      status: "running",
    });
    await ctx.events.record({
      kind: "fly_machine.running",
      message: `Machine ${p.machineId} is running`,
    });
    return {
      appName: p.appName,
      machineId: p.machineId,
      machineState: m.state,
      orgSlug: parent.orgSlug ?? "personal",
      region: parent.region ?? DEFAULT_REGION,
      appUrl: `https://fly.io/apps/${p.appName}`,
    };
  }

  if (Date.now() >= p.pollDeadline) {
    throw new Error(
      `machine ${p.machineId} did not reach 'started' within ${RUN_TIMEOUT_MS / 1000}s (last state: ${m.state})`,
    );
  }

  await ctx.enqueueSibling({
    kind: "fly_deploy.wait_running",
    payload: { ...p } as unknown as Record<string, unknown>,
    delaySecs: POLL_DELAY_SECS,
  });
  return { machineState: m.state, polling: true };
}

// --- helpers ---------------------------------------------------------

/** Each step independently decrypts + discharges. The discharge HTTP
 *  is a single round-trip (~150ms); much cleaner than ferrying a
 *  discharged token through payloads, and always-fresh sidesteps the
 *  expiry questions that bit us before. */
async function loadDischargedAuth(
  env: Env,
  userId: string,
  parent: FlyDeployPayload,
): Promise<string> {
  const target = await getDeployTargetById(env.DB, userId, parent.deployTargetId);
  if (!target) throw new Error("deploy_target not found");
  if (target.kind !== "fly") {
    throw new Error(`expected fly target, got ${target.kind}`);
  }
  const creds = await decryptDeployTargetCredentials<{ apiToken: string }>(
    env,
    target,
  );
  if (!creds.apiToken) throw new Error("fly token missing from deploy_target");
  return dischargeBundle(flyAuthHeader(creds.apiToken));
}

async function resolveOrgSlugWithFallback(
  ctx: JobHandlerCtx,
  authHeader: string,
): Promise<string> {
  try {
    return await resolveFlyOrgSlug(authHeader);
  } catch (err) {
    const message = err instanceof Error ? err.message : "resolve failed";
    await ctx.events.record({
      kind: "fly_org_slug_fallback",
      severity: "warn",
      message: "Falling back to 'personal' org for Fly deploy",
      payload: { reason: message },
    });
    return "personal";
  }
}

/** Stable, DNS-safe Fly app name. Globally unique on Fly, prefixed
 *  with "logtura-" + the deployment id minus its "dep_" prefix. */
export function flyAppNameFor(deploymentId: string): string {
  const suffix = deploymentId.replace(/^dep_/, "").toLowerCase();
  const safe = suffix.replace(/[^a-z0-9-]/g, "").slice(0, 20);
  return `logtura-${safe}`;
}
