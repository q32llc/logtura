import { assembleDeploymentBundle } from "../../bundle-assembly";
import { FlyMachinesClient, FlyReplacementPending, flyBundleFiles, matchesFlyConfig } from "@logtura/core";
import { commitConfiguration, readStableConfiguration } from "../../config-version";
import {
  decryptDeployTargetCredentials,
  getDeployTargetById,
} from "../../db";
import {
  createFlyApp,
  flyAuthHeader,
  getFlyApp,
  listFlyMachines,
  resolveFlyOrgSlug,
  startFlyMachine,
  type FlyMachineConfig,
} from "../../deploy-targets/fly-machines";
import { selectManagedForwarder,assertManagedReplacementStandby } from "../../managed-machine-inventory";
import { readManagedInstall,prepareManagedInstall,executeManagedInstall,completeManagedInstall,recordManagedInstallVersion } from "../../managed-installations";
import { bindInstalledManagedRuntime } from "../../managed-issued-installations";
import { readDeploymentConfiguration } from "../../deployment-configuration";
import { completeIssuedManagedDeployment } from "../../managed-runtime-completion";
import { prepareManagedRuntimeForQueue } from "../../managed-runtime-preparation";
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
/** Forwarder image tag we resolve to a concrete digest at deploy
 *  time. Built by .github/workflows/build-forwarder.yml from
 *  containers/forwarder/Dockerfile.generated (itself rendered from
 *  every registered driver's dockerfileDeps — see
 *  scripts/build-forwarder-dockerfile.mjs). We never pass `:latest`
 *  directly to Fly because Fly caches the digest behind the tag and
 *  doesn't re-resolve on update; pinning by digest avoids that
 *  whole class of "machine running stale image" bug. */
const FORWARDER_TAG = "latest";
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
  await ctx.progress({ label: "Queued — starting deploy" });
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
      issuedRuntime: true,
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

  await ctx.progress({ label: "Authenticating with Fly" });
  const flyAuth = await loadDischargedAuth(ctx.env, ctx.job.userId, parent);

  await ctx.progress({ label: "Resolving Fly organization" });
  const orgSlug =
    parent.orgSlug ?? (await resolveOrgSlugWithFallback(ctx, flyAuth));
  const region = parent.region ?? DEFAULT_REGION;

  await ctx.progress({ label: `Ensuring Fly app ${p.appName}` });
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
    kind: p.issuedRuntime?"fly_deploy.ensure_checkpoint":"fly_deploy.create_or_update_machine",
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

  await ctx.progress({ label: "Assembling Vector config" });
  const flyAuth = await loadDischargedAuth(ctx.env, ctx.job.userId, parent);

  const activeInstall=await readManagedInstall(ctx.env,ctx.job.userId,parent.deploymentId,p.installationId);
  if(p.installationId && !activeInstall)throw new Error("Managed retained installation is missing; refuse a new provider write");
  if(activeInstall){
    if(activeInstall.app!==p.appName || activeInstall.region!==p.region || activeInstall.org!==p.orgSlug)throw new Error("Managed installation target changed; retain it for recovery");
    const client=managedClient(flyAuth,ctx.signal),machineId=await executeQueueInstall(ctx,p,activeInstall,client);
    if(machineId===null)return {appName:p.appName,installationId:activeInstall.id,pending:true};
    const expectedVersion=activeInstall.installedConfigurationVersion??activeInstall.configurationVersion;
    const digest=activeInstall.payload.after.image.split("@")[1]!;
    const committed=activeInstall.runtime?{version:await bindInstalledManagedRuntime(ctx.env,ctx.job.userId,parent.deploymentId,activeInstall.id)}:await commitConfiguration(ctx.env.DB,ctx.job.userId,expectedVersion,[
      ctx.env.DB.prepare("UPDATE deployments SET external_id=?,image_digest=?,updated_at=? WHERE id=? AND user_id=?").bind(`fly:${p.appName}:${machineId}`,digest,Date.now(),parent.deploymentId,ctx.job.userId),
      recordManagedInstallVersion(ctx.env.DB,activeInstall.id,ctx.job.userId),
    ]);
    await ctx.enqueueSibling({kind:"fly_deploy.wait_running",payload:{parentPayload:parent,appName:p.appName,machineId,pollDeadline:Date.now()+RUN_TIMEOUT_MS,configurationVersion:committed.version,installationId:activeInstall.id},delaySecs:POLL_DELAY_SECS});
    return {appName:p.appName,machineId,orgSlug:p.orgSlug,region:p.region,installationId:activeInstall.id,recovered:true};
  }

  const snapshot = await readStableConfiguration(ctx.env.DB, ctx.job.userId,
    () => assembleDeploymentBundle(ctx.env, ctx.job.userId, parent.deploymentId));
  const assembled = snapshot.value;
  if (!assembled.credentialIsFresh) {
    throw new Error(
      `connection credential is unusable: ${assembled.credentialStaleReason ?? "stale"}`,
    );
  }
  const { deployment, bundle } = assembled;

  const env_: Record<string, string> = {};
  for (const v of bundle.envVars) {
    if (v.value === null || v.value === "") {
      throw new Error(
        `env var ${v.name} has no value — connect/configure the source before deploying`,
      );
    }
    env_[v.name] = v.value;
  }

  // Resolve :latest → concrete sha256 so Fly pins to an immutable
  // digest. See src/forwarder-image.ts for why.
  await ctx.progress({ label: "Resolving forwarder image digest" });
  const { resolveForwarderDigest, forwarderImageRef } = await import(
    "../../forwarder-image"
  );
  const digest = await resolveForwarderDigest(FORWARDER_TAG);
  const imageRef = forwarderImageRef(digest);
  await ctx.events.record({
    kind: "fly_machine.image_pinned",
    message: `Pinning forwarder to ${digest}`,
    payload: { digest, imageRef },
  });

  const machineConfig: FlyMachineConfig = {
    image: imageRef,
    env: env_,
    files: flyBundleFiles(bundle),
    // NOTE: the timberio/vector base image has ENTRYPOINT ["vector"],
    // so we pass only the args here. Including "vector" again makes
    // the final exec `vector vector --config …` and crash-loops with
    // "unrecognized subcommand 'vector'".
    init: { cmd: ["--config", "/etc/vector/vector.yaml"] },
    // Keep a modest default envelope for Vector plus sidecars. The
    // Cloudflare Worker tail driver now multiplexes selected workers
    // inside one Rust process, but other drivers and transforms still
    // benefit from headroom during bursts.
    guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
    restart: { policy: "always" },
    // TCP probe on Vector's admin API. A crash-looper that flaps
    // through state=started for milliseconds at a time still fails
    // this — the port isn't bound until vector finishes booting its
    // config, and a crashed process closes it within ms. wait_running
    // reads `m.checks` and only considers the machine healthy when
    // this is `passing`. `informational` because there's no LB pool
    // for a single forwarder; we just want Fly to report status.
    checks: {
      vector_api: {
        type: "tcp",
        port: 8686,
        interval: "5s",
        timeout: "2s",
        grace_period: "10s",
        kind: "informational",
      },
    },
  };

  await ctx.progress({ label: "Updating Fly machine" });
  const client=managedClient(flyAuth,ctx.signal);
  const target=await selectManagedForwarder(ctx.env,ctx.job.userId,parent.deploymentId,p.appName,await client.machines(p.appName));
  const install=p.volumeId?await prepareManagedRuntimeForQueue(ctx.env,{userId:ctx.job.userId,payload:p,snapshot,client,machine:target,image:imageRef,defaults:{...machineConfig}}):await prepareManagedInstall(ctx.env,{userId:ctx.job.userId,deploymentId:parent.deploymentId,app:p.appName,org:p.orgSlug,region:p.region,configurationVersion:snapshot.version,config:{...target?.config,...machineConfig},machine:target});
  const machineId=await executeQueueInstall(ctx,p,install,client);
  if(machineId===null)return {appName:p.appName,installationId:install.id,pending:true};
  await ctx.events.record({kind:target?"fly_machine.updated":"fly_machine.created",message:`Installed managed intent ${install.id} on ${p.appName}`,payload:{installationId:install.id,machineId}});

  // We don't issue /start here. the machine update returns before Fly
  // finishes propagating, so an immediate /start hits a 412 race.
  // wait_running below issues /start on each poll tick that sees
  // state=stopped — once Fly's update propagates, the start sticks.

  const committed = install.runtime?{version:await bindInstalledManagedRuntime(ctx.env,ctx.job.userId,deployment.id,install.id)}:await commitConfiguration(ctx.env.DB, ctx.job.userId, snapshot.version, [
    ctx.env.DB.prepare("UPDATE deployments SET external_id=?,image_digest=?,updated_at=? WHERE id=? AND user_id=?")
      .bind(`fly:${p.appName}:${machineId}`, digest, Date.now(), deployment.id, ctx.job.userId),
    recordManagedInstallVersion(ctx.env.DB,install.id,ctx.job.userId),
  ]);

  await ctx.enqueueSibling({
    kind: "fly_deploy.wait_running",
    payload: {
      parentPayload: parent,
      appName: p.appName,
      machineId,
      pollDeadline: Date.now() + RUN_TIMEOUT_MS,
      configurationVersion: committed.version,
      installationId: install.id,
    } as unknown as Record<string, unknown>,
    delaySecs: POLL_DELAY_SECS,
  });
  return { appName: p.appName, machineId, orgSlug: p.orgSlug, region: p.region, installationId:install.id };
}

// --- Step 3: poll machine state, requeue self until running ---------

export async function runFlyWaitRunning(
  ctx: JobHandlerCtx,
): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as unknown as FlyWaitRunningPayload;
  const parent = p.parentPayload;

  const flyAuth = await loadDischargedAuth(ctx.env, ctx.job.userId, parent);

  const machines = p.installationId?await managedClient(flyAuth,ctx.signal).machines(p.appName) as unknown as Awaited<ReturnType<typeof listFlyMachines>>:await listFlyMachines(flyAuth, p.appName);
  const m = machines.find((x) => x.id === p.machineId);
  if (!m) {
    throw new Error(`machine ${p.machineId} not found on ${p.appName}`);
  }

  const install=p.installationId?await readManagedInstall(ctx.env,ctx.job.userId,parent.deploymentId,p.installationId):null;
  if(p.installationId && (!install || install.phase!=="installed" || install.machineId!==p.machineId || install.app!==p.appName || install.installedConfigurationVersion!==p.configurationVersion || !matchesFlyConfig({...m.config},install.payload.after) || (m as unknown as {image_ref?:{digest?:unknown}}).image_ref?.digest!==install.payload.after.image.split("@")[1]))throw new Error("Managed machine differs from its saved installation; retain it for recovery");
  if(install)assertManagedReplacementStandby(install,machines as unknown as import("@logtura/core").FlyMachine[]);
  const checks = m.checks ?? [];
  const checksPassing =
    checks.length > 0 && checks.every((c) => c.status === "passing");
  const checkSummary = checks.length
    ? checks.map((c) => `${c.name}=${c.status}`).join(",")
    : "no-checks-yet";

  // A `restart: always` machine that's crash-looping will flap through
  // `state=started` for milliseconds between exits. The state field
  // alone is therefore not enough to call deploy success. We also
  // require: (1) checks defined and all passing, and (2) no exit event
  // observed in the last 30s. The TCP probe on :8686 only passes once
  // Vector has finished booting its config — a crashed process closes
  // the port, so this catches the crash-loops that bit us before.
  const RECENT_EXIT_WINDOW_MS = 30 * 1000;
  const now = Date.now();
  const recentExit = (m.events ?? []).find(
    (e) => e.type === "exit" && now - e.timestamp < RECENT_EXIT_WINDOW_MS,
  );
  let reportAccepted=true;
  if(install?.runtime){
    const state=await readDeploymentConfiguration(ctx.env.DB,ctx.job.userId,parent.deploymentId),instance=install.runtime.instance;
    if(!state || state.stale || state.activeInstanceId!==instance.instanceId || state.desired.sequence!==instance.sequence || state.desired.revision!==instance.revision)throw new Error("Managed issued instance changed while waiting for its report");
    reportAccepted=state.lastReportSequence>0 && state.applied?.sequence===instance.sequence && state.applied.revision===instance.revision;
  }

  await ctx.progress({
    label: reportAccepted?"Waiting for machine to start":"Waiting for runtime acknowledgement",
    detail: `state=${m.state} checks=${checkSummary}${recentExit ? " recent_exit" : ""}${reportAccepted?"":" report_pending"}`,
  });

  if (m.state === "started" && checksPassing && !recentExit && reportAccepted) {
    if(install?.runtime){await completeIssuedManagedDeployment(ctx.env,install,p.configurationVersion!);}
    else {
      await ctx.env.DB.prepare("UPDATE deployments SET status='running',updated_at=? WHERE id=? AND user_id=?")
        .bind(Date.now(), parent.deploymentId, ctx.job.userId).run();
      // The new bundle is now running on Fly — clear the out-of-date
      // flag the UI uses for the Redeploy CTA. (We don't clear via
      // markUserDeploymentsOutdated's inverse because the user might
      // have changed config OF ANOTHER deployment mid-deploy here;
      // we only clear this specific deployment.)
      if (p.configurationVersion !== undefined) {
        await commitConfiguration(ctx.env.DB, ctx.job.userId, p.configurationVersion, [
          ctx.env.DB.prepare("UPDATE deployments SET bundle_outdated=0,updated_at=? WHERE id=? AND user_id=?")
            .bind(Date.now(), parent.deploymentId, ctx.job.userId),
          ...(install?[completeManagedInstall(ctx.env.DB,install.id,ctx.job.userId)]:[]),
        ]);
      }
    }
    await ctx.events.record({
      kind: "fly_machine.running",
      message: `Machine ${p.machineId} is running (checks: ${checkSummary})`,
    });
    return {
      appName: p.appName,
      machineId: p.machineId,
      machineState: m.state,
      checksPassing,
      orgSlug: parent.orgSlug ?? "personal",
      region: parent.region ?? DEFAULT_REGION,
      appUrl: `https://fly.io/apps/${p.appName}`,
    };
  }

  if (Date.now() >= p.pollDeadline) {
    throw new Error(
      `machine ${p.machineId} did not reach healthy 'started' within ${RUN_TIMEOUT_MS / 1000}s (last state: ${m.state}, checks: ${checkSummary}${reportAccepted?"":", runtime acknowledgement pending"}${recentExit ? `, recent exit at ${new Date(recentExit.timestamp).toISOString()}` : ""})`,
    );
  }

  // If the machine is sitting in `stopped`, nudge it. Fly's update
  // endpoint returns before its restart-after-config-change is ready
  // for /start, so we just keep nudging from here. The call is
  // best-effort — 412 means "not ready yet, try again" and we will.
  let startStatus: number | undefined;
  if (m.state === "stopped") {
    const r = await startFlyMachine(flyAuth, {
      appName: p.appName,
      machineId: p.machineId,
    });
    startStatus = r.status;
  }

  await ctx.enqueueSibling({
    kind: "fly_deploy.wait_running",
    payload: { ...p } as unknown as Record<string, unknown>,
    delaySecs: POLL_DELAY_SECS,
  });
  return { machineState: m.state, startStatus, polling: true };
}

// --- helpers ---------------------------------------------------------

/** Each step independently decrypts + discharges. The discharge HTTP
 *  is a single round-trip (~150ms); much cleaner than ferrying a
 *  discharged token through payloads, and always-fresh sidesteps the
 *  expiry questions that bit us before. */
export async function loadDischargedAuth(
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

export function managedClient(auth:string,signal:AbortSignal):FlyMachinesClient {
 const match=/^(Bearer|FlyV1) (.+)$/.exec(auth);if(!match)throw new Error("Invalid discharged Fly authorization");
 return new FlyMachinesClient({token:match[2]!,authorizationScheme:match[1] as "Bearer"|"FlyV1",signal});
}


async function executeQueueInstall(ctx:JobHandlerCtx,p:FlyCreateOrUpdateMachinePayload,install:import("../../managed-installations").ManagedInstall,client:FlyMachinesClient):Promise<string|null>{
 const deadline=p.installDeadline??Date.now()+RUN_TIMEOUT_MS;
 if(!Number.isSafeInteger(deadline) || deadline<0 || deadline>Date.now()+RUN_TIMEOUT_MS+5_000)throw new Error("Invalid managed installation deadline");
 try{return await executeManagedInstall(ctx.env,install,client,ctx.signal);}
 catch(error){
  if(!(error instanceof FlyReplacementPending))throw error;
  if(Date.now()>=deadline)throw new Error("Managed replacement handoff deadline exceeded; retain installation for recovery");
  await ctx.progress({label:"Waiting for forwarder handoff"});
  await ctx.enqueueSibling({kind:"fly_deploy.create_or_update_machine",payload:{...p,installationId:install.id,installDeadline:deadline},delaySecs:POLL_DELAY_SECS});
  return null;
 }
}
