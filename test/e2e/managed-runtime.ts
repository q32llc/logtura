import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {decryptSecret} from "../../src/crypto";
import { DeploymentReportingClient,validateFlyReplacementState } from "@logtura/core";
import type { startLocalService } from "./local-workerd";
import type { startBrowser } from "./browser";
// Keep the Node E2E contract independent of Workers-only UI type imports.
interface DeploymentDetail {
  managed: boolean; status: string; externalId: string | null;
  lastSeenAt: number | null;
  metricsSnapshot: { byComponent: Record<string, unknown> } | null;
}

type Service = Awaited<ReturnType<typeof startLocalService>>;
type Website = Awaited<ReturnType<typeof startBrowser>>;
type Run = (command: string, args: string[], cwd?: string) => Promise<string>;
type RequestApi = (path: string, body?: unknown, method?: string) => Promise<any>;

/** Real website -> native queue -> public provider plan -> actual packaged
 * supervisor/Vector -> actual runtime report -> real workerd/D1 -> website.
 * The Fly/registry transport is an owned fixture; no live Fly resource is touched. */
export async function managedRuntimeJourney(options: {
  service: Service; website: Website; request: RequestApi; run: Run;
  connectionId: string; temporary: string; runId: string; afterApplied?: () => void; afterReapplied?: () => void; legacy?: boolean;
  editAndPush: (deploymentId: string) => Promise<void>;
  image: { tag: string; dockerId: string; platformDigest: string; platformManifest: string; indexDigest: string; index: string };
}) {
  const { service, website, request, run, image } = options;
  const container = `logtura-managed-e2e-${options.runId}`;
  const legacyContainer=`${container}-legacy`,legacyId=`legacy_${options.runId.slice(0,14)}`;
  const volumeName = `logtura-managed-e2e-volume-${options.runId}`;
  const volumeId = `vol_${options.runId}`;
  const machineId = options.runId.slice(0, 14);
  const installed = join(options.temporary, `managed-installed-${options.runId}`);
  mkdirSync(installed);
  let deploymentId: string | undefined, targetId: string | undefined, appName: string | undefined;
  let appCreated = false, volume: any, machine: any,legacyMachine:any;
  let appCreates = 0, volumeCreates = 0, machineCreates = 0, machineUpdates = 0, registryReads = 0;
  let legacyLease:string|undefined,oldStops=0,candidateStarts=0;
  let lease: string | undefined, leaseCreates = 0, leaseReleases = 0;
  let providerFailure: string | undefined, failure: unknown;
  async function waitFor(check: () => Promise<boolean>, label: string, timeout = 120_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (providerFailure) throw new Error(providerFailure);
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${label} timed out`);
  }
  async function actualMachine() {
    const running = await run("docker", ["inspect", "--format", "{{.State.Running}}", container]) === "true";
    let ready = false;
    if (running) {
      try {
        // Probe the same readiness endpoint as the packaged supervisor,
        // rather than assuming a GraphQL response from the admin port.
        const response = await fetch("http://127.0.0.1:8686/health", { redirect: "manual", signal: AbortSignal.timeout(2000) });
        ready = response.status === 200;
      } catch { /* The actual Vector admin port is still starting. */ }
    }
    return { ...machine, state: running ? "started" : "stopped", checks: [{ name: "vector_api", status: ready ? "passing" : "critical" }] };
  }
  async function actualLegacy(){
    const running=await run("docker",["inspect","--format","{{.State.Running}}",legacyContainer])==="true";
    return {...legacyMachine,state:running?"started":"stopped",checks:[{name:"vector_api",status:running?"passing":"critical"}]};
  }
  async function installMachine(config: any,launch=true,name=machine?.name??"forwarder") {
    // Replace the stopped machine's complete file snapshot, including read-only
    // descriptor files and assets removed by the new configuration.
    rmSync(installed, {recursive: true, force: true}); mkdirSync(installed);
    assert.equal(config.image, `ghcr.io/q32llc/logtura-forwarder@${image.platformDigest}`);
    assert.deepEqual(config.init.entrypoint, ["/opt/logtura/runtime/entrypoint.sh"]);
    assert.deepEqual(config.mounts, [{ path: "/var/lib/logtura", volume: volumeId }]);
    assert.deepEqual(config.stop_config, { signal: "SIGTERM", timeout: "35s" });
    for (const file of config.files) {
      assert.ok(file.guest_path.startsWith("/etc/vector/") || file.guest_path.startsWith("/opt/logtura/assets/"));
      assert.ok(!file.guest_path.split("/").some((part: string) => part === ".." || part === "."));
      const target = join(installed, file.guest_path.slice(1));
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(file.raw_value, "base64")); chmodSync(target, file.mode);
    }
    const args = [launch?"run":"create",...(launch?["--detach"]:[]), "--name", container, "--network", "host", "--stop-timeout", "35", "--volume", `${join(installed, "etc/vector")}:/etc/vector:ro`, "--volume", `${volumeName}:/var/lib/logtura`];
    if (config.files.some((file: any) => file.guest_path.startsWith("/opt/logtura/assets/"))) args.push("--volume", `${join(installed, "opt/logtura/assets")}:/opt/logtura/assets:ro`);
    for (const [name, value] of Object.entries(config.env)) args.push("--env", `${name}=${value}`);
    args.push(image.tag, ...config.init.cmd);
    await run("docker", args);
    assert.equal(await run("docker", ["inspect", "--format", "{{.Image}}", container]), image.dockerId);
    machine = { id: machineId, name, instance_id: `managed-version-${machineUpdates + 1}`, region: volume.region, config, image_ref: { registry: "ghcr.io", repository: "q32llc/logtura-forwarder", digest: image.platformDigest } };
  }
  service.setProviderFixture(async providerRequest => {
    const url = new URL(providerRequest.url), path = url.pathname;
    try {
      if (url.origin === "https://ghcr.io") {
        if (path === "/token") return Response.json({ token: "fixture-managed-registry-token" });
        assert.equal(providerRequest.headers.get("authorization"), "Bearer fixture-managed-registry-token");
        const prefix = "/v2/q32llc/logtura-forwarder/manifests/";
        assert.ok(path.startsWith(prefix));
        const reference = path.slice(prefix.length);
        if (providerRequest.method === "HEAD") {
          assert.equal(reference, "latest");
          return new Response(null, { headers: { "docker-content-digest": image.indexDigest } });
        }
        const bytes = reference === image.indexDigest ? image.index : reference === image.platformDigest ? image.platformManifest : null;
        assert.ok(bytes); registryReads++;
        return new Response(bytes, { headers: { "content-type": "application/json", "docker-content-digest": reference } });
      }
      if (url.origin === "https://api.fly.io") {
        if (path === "/api/v1/cli_sessions" && providerRequest.method === "POST") {
          assert.equal(providerRequest.headers.get("authorization"), null);
          return Response.json({ id: "fixture-fly-session", auth_url: "https://fly.io/authorize/fixture-fly-session" });
        }
        if (path === "/api/v1/cli_sessions/fixture-fly-session") {
          assert.equal(providerRequest.headers.get("authorization"), null);
          return Response.json({ access_token: "fo1_fixture-managed-fly-token", user_email: "managed@example.invalid" });
        }
        assert.equal(path, "/graphql");
        assert.ok(providerRequest.headers.get("authorization")?.endsWith("fo1_fixture-managed-fly-token"));
        const body = await providerRequest.json() as any;
        assert.match(body.query, /organizations\(admin:/);
        return Response.json({ data: { organizations: { nodes: [{ slug: "personal" }] } } });
      }
      if (url.origin !== "https://api.machines.dev") return undefined;
      assert.ok(providerRequest.headers.get("authorization")?.endsWith("fo1_fixture-managed-fly-token"));
      if (path === "/v1/apps" && providerRequest.method === "POST") {
        const body = await providerRequest.json() as any;
        assert.equal(body.org_slug, "personal"); assert.equal(body.app_name, appName);
        assert.equal(appCreated, false); appCreated = true; appCreates++;
        return Response.json({ name: appName }, { status: 201 });
      }
      const match = /^\/v1\/apps\/(logtura-[a-z0-9-]+)(\/.*)?$/.exec(path);
      assert.ok(match);
      appName ??= match[1]; assert.equal(match[1], appName);
      const suffix = match[2] ?? "";
      if (!suffix) return appCreated ? Response.json({ name: appName, organization: { slug: "personal" } }) : new Response(null, { status: 404 });
      if (suffix === "/volumes") {
        if (providerRequest.method === "GET") return Response.json(volume ? [{ ...volume, attached_machine_id: machine ? machineId : null }] : []);
        assert.equal(providerRequest.method, "POST"); assert.equal(volume, undefined);
        const body = await providerRequest.json() as any;
        assert.equal(body.encrypted, true); assert.equal(body.machines_only, true);
        assert.deepEqual(body.compute, { cpu_kind: "shared", cpus: 2, memory_mb: 4096 });
        await run("docker", ["volume", "create", volumeName]); volumeCreates++;
        volume = { id: volumeId, name: body.name, region: body.region, size_gb: body.size_gb, encrypted: true, state: "created", attached_machine_id: null };
        return Response.json(volume);
      }
      if (suffix === "/machines") {
        if (providerRequest.method === "GET") return Response.json([...(legacyMachine?[await actualLegacy()]:[]),...(machine?[await actualMachine()]:[])]);
        assert.equal(providerRequest.method, "POST"); assert.equal(machine, undefined); assert.ok(volume);
        const body = await providerRequest.json() as any;
        if(options.legacy){assert.match(body.name,/^forwarder-[a-f0-9-]{36}$/);assert.equal(body.skip_launch,true);assert.equal((await actualLegacy()).state,"started");}
        else assert.equal(body.name,"forwarder");
        assert.equal(body.region,volume.region);
        await installMachine(body.config,body.skip_launch!==true,body.name); machineCreates++;
        return Response.json(await actualMachine());
      }
      if(legacyMachine && suffix===`/machines/${legacyId}/lease`){
        if(providerRequest.method==="POST"){assert.equal(legacyLease,undefined);legacyLease="fixture-legacy-lease";leaseCreates++;return Response.json({data:{nonce:legacyLease}});}
        assert.equal(providerRequest.method,"DELETE");assert.equal(providerRequest.headers.get("fly-machine-lease-nonce"),legacyLease);legacyLease=undefined;leaseReleases++;return new Response(null,{status:204});
      }
      if(legacyMachine && suffix===`/machines/${legacyId}/stop`){
        assert.ok(legacyLease);assert.equal(providerRequest.headers.get("fly-machine-lease-nonce"),legacyLease);assert.deepEqual(await providerRequest.json(),{signal:"SIGTERM",timeout:"35s"});
        await run("docker",["stop","--time","35",legacyContainer]);assert.equal(await run("docker",["inspect","--format","{{.State.ExitCode}}",legacyContainer]),"0");oldStops++;return new Response(null,{status:204});
      }
      if(legacyMachine && suffix===`/machines/${legacyId}`){assert.equal(providerRequest.method,"GET");return Response.json(await actualLegacy());}
      if(suffix===`/machines/${machineId}/start`){
        assert.ok(lease);assert.equal(providerRequest.headers.get("fly-machine-lease-nonce"),lease);assert.equal((await actualLegacy()).state,"stopped");await run("docker",["start",container]);candidateStarts++;return new Response(null,{status:204});
      }
      if (suffix === `/machines/${machineId}/lease`) {
        assert.ok(machine);
        if (providerRequest.method === "POST") {
          assert.equal(lease, undefined); const body = await providerRequest.json() as any; assert.equal(body.ttl, 120);
          lease = "fixture-managed-lease"; leaseCreates++; return Response.json({data: {nonce: lease}});
        }
        assert.equal(providerRequest.method, "DELETE"); assert.ok(lease);
        assert.equal(providerRequest.headers.get("fly-machine-lease-nonce"), lease);
        lease = undefined; leaseReleases++; return new Response(null, {status: 204});
      }
      if (suffix === `/machines/${machineId}`) {
        assert.ok(machine);
        if (providerRequest.method === "GET") return Response.json(await actualMachine());
        assert.equal(providerRequest.method, "POST"); assert.ok(lease);
        assert.equal(providerRequest.headers.get("fly-machine-lease-nonce"), lease);
        const body = await providerRequest.json() as any; assert.equal(body.current_version, machine.instance_id);
        // Model a real version-fenced provider update: stop before changing
        // mounted inputs, retain the same checkpoint volume, then start new bytes.
        await run("docker", ["stop", "--time", "35", container]);
        assert.equal(await run("docker", ["inspect", "--format", "{{.State.ExitCode}}", container]), "0");
        await run("docker", ["rm", container]); machineUpdates++;
        await installMachine(body.config); return Response.json(await actualMachine());
      }
      throw new Error("Unsupported managed fixture request");
    } catch (error) {
      providerFailure = `Managed provider fixture failed: ${providerRequest.method} ${url.origin}${path} (${error instanceof Error ? error.name : "error"})`;
      return new Response("managed_fixture_failure", { status: 503 });
    }
  });
  try {
    deploymentId = await website.createDeployment(options.connectionId, id => { deploymentId = id; }, { managed: true, name: "Website-managed fixture forwarder" });
    await website.enableMetrics(deploymentId, "No configuration revision has been recorded for this deployment.");
    if(options.legacy){
      const legacyDirectory=join(options.temporary,`legacy-vector-${options.runId}`);mkdirSync(legacyDirectory);
      const yaml='api:\n  enabled: true\n  address: 0.0.0.0:8686\nsources:\n  legacy_pulse:\n    type: demo_logs\n    format: json\n    interval: 1\nsinks:\n  legacy_output:\n    type: blackhole\n    inputs: [legacy_pulse]\n';
      writeFileSync(join(legacyDirectory,"vector.yaml"),yaml,{mode:0o400});
      await run("docker",["run","--detach","--name",legacyContainer,"--network","host","--volume",`${legacyDirectory}:/etc/vector:ro`,"--env","PRIVATE_OLD=fixture-old-private",image.tag,"--config","/etc/vector/vector.yaml"]);
      await waitFor(async()=>{try{return(await fetch("http://127.0.0.1:8686/health",{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},"actual legacy Vector readiness");
      legacyMachine={id:legacyId,name:"forwarder",instance_id:"legacy-version-1",region:"iad",config:{image:`ghcr.io/q32llc/logtura-forwarder@${image.platformDigest}`,env:{PRIVATE_OLD:"fixture-old-private"},files:[{guest_path:"/etc/vector/vector.yaml",raw_value:Buffer.from(yaml).toString("base64"),mode:0o400}],init:{cmd:["--config","/etc/vector/vector.yaml"]},guest:{cpu_kind:"shared",cpus:2,memory_mb:4096},restart:{policy:"always"}},image_ref:{registry:"ghcr.io",repository:"q32llc/logtura-forwarder",digest:image.platformDigest}};
      appCreated=true;
    }
    const parent = await website.connectAndDeployManaged(deploymentId, id => { targetId = id; });
    await waitFor(async () => {
      const { job } = await request(`/api/jobs/${parent}`);
      if (job.status === "failed") throw new Error(`Managed queue failed: ${job.error}`);
      return job.status === "succeeded";
    }, "website-managed queue completion");
    assert.equal(appCreates, options.legacy?0:1); assert.equal(volumeCreates, 1); assert.equal(machineCreates, 1); assert.equal(registryReads, 2);
    const { state } = await request(`/api/deployments/${deploymentId}/config/state`);
    const artifact = JSON.parse(readFileSync(join(installed, "etc/vector/logtura-runtime.json"), "utf8"));
    assert.equal(state.stale, false); assert.ok(state.lastReportSequence >= 1);
    assert.equal(state.activeInstanceId, artifact.instance.instanceId);
    assert.equal(state.applied.sequence, artifact.instance.sequence); assert.equal(state.applied.revision, artifact.instance.revision);
    const db = await service.service.getD1Database("DB");
    assert.equal(await db.prepare("SELECT phase FROM managed_installations WHERE deployment_id=?").bind(deploymentId).first("phase"), "completed");
    assert.equal(await db.prepare("SELECT volume_id FROM managed_checkpoints WHERE deployment_id=?").bind(deploymentId).first("volume_id"), volumeId);
    const { deployment }: { deployment: DeploymentDetail } = await request(`/api/deployments/${deploymentId}`);
    assert.equal(deployment.managed, true); assert.equal(deployment.status, "running");
    assert.equal(deployment.externalId, `fly:${appName}:${machineId}`);
    assert.equal(await db.prepare("SELECT image_digest FROM deployments WHERE id=?").bind(deploymentId).first("image_digest"), image.platformDigest);
    const { kids } = await request(`/api/jobs/${parent}`);
    assert.ok(kids.some((job: any) => job.kind === "fly_deploy.ensure_checkpoint"));
    assert.ok(!JSON.stringify(kids).includes("fo1_fixture-managed-fly-token"));
    await waitFor(async () => {
      const detail: DeploymentDetail = (await request(`/api/deployments/${deploymentId}`)).deployment;
      return Number.isFinite(detail.lastSeenAt) && detail.lastSeenAt! > 0 && Object.keys(detail.metricsSnapshot?.byComponent ?? {}).length > 0;
    }, "managed actual heartbeat and metrics delivery");
    await website.applied(deploymentId, state.desired.sequence, state.desired.revision);
    await website.metrics(deploymentId); website.assertNoErrors();
    options.afterApplied?.();
    const beforeRestart = (await request(`/api/deployments/${deploymentId}/config/state`)).state.lastReportSequence;
    await run("docker", ["restart", "--time", "35", container]);
    const restartedAt = await run("docker", ["inspect", "--format", "{{.State.StartedAt}}", container]);
    await waitFor(async () => {
      const logs = await run("docker", ["logs", "--since", restartedAt, container]);
      const reported = logs.split("\n").some(line => {
        try { const event = JSON.parse(line); return event.event === "applied_report" && event.accepted === true && event.reportSequence > beforeRestart; } catch { return false; }
      });
      const current = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
      return reported && current.lastReportSequence > beforeRestart && current.activeInstanceId === artifact.instance.instanceId && !current.stale;
    }, "managed durable report checkpoint after restart");
    const previousCheckpoint = await run("docker", ["exec", container, "cat", `/var/lib/logtura/reports/${artifact.instance.instanceId}.json`]);
    await options.editAndPush(deploymentId);
    const pending = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
    assert.ok(pending.desired.sequence > state.desired.sequence);
    assert.notEqual(pending.desired.revision, state.desired.revision);
    assert.equal(pending.applied.sequence, state.applied.sequence);
    assert.equal(pending.activeInstanceId, artifact.instance.instanceId);
    await website.deployment(deploymentId, "Update pending");
    const updateParent = await website.redeployManaged(deploymentId); assert.notEqual(updateParent, parent);
    await waitFor(async () => {
      const {job} = await request(`/api/jobs/${updateParent}`);
      if (job.status === "failed") throw new Error(`Managed reapply failed: ${job.error}`);
      return job.status === "succeeded";
    }, "CLI-edited website-managed reapply");
    const reapplied = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
    const updatedArtifact = JSON.parse(readFileSync(join(installed, "etc/vector/logtura-runtime.json"), "utf8"));
    assert.equal(reapplied.stale, false); assert.ok(reapplied.lastReportSequence > 0);
    assert.equal(reapplied.desired.sequence, pending.desired.sequence);
    assert.equal(reapplied.applied.sequence, pending.desired.sequence);
    assert.equal(reapplied.applied.revision, pending.desired.revision);
    assert.notEqual(reapplied.activeInstanceId, artifact.instance.instanceId);
    assert.equal(reapplied.activeInstanceId, updatedArtifact.instance.instanceId);
    assert.deepEqual(updatedArtifact.document, reapplied.desired.document);
    assert.equal(appCreates, options.legacy?0:1); assert.equal(volumeCreates, 1); assert.equal(machineCreates, 1);
    assert.equal(machineUpdates, 1); assert.equal(leaseCreates, options.legacy?3:1); assert.equal(leaseReleases, options.legacy?3:1); assert.equal(lease, undefined);assert.equal(legacyLease,undefined);
    assert.equal(await db.prepare("SELECT COUNT(*) FROM managed_installations WHERE deployment_id=? AND phase='completed'").bind(deploymentId).first("COUNT(*)"), 2);
    assert.equal(await db.prepare("SELECT volume_id FROM managed_checkpoints WHERE deployment_id=?").bind(deploymentId).first("volume_id"), volumeId);
    // The old runtime's checkpoint survives in the same actual volume, but its
    // later reports can no longer acknowledge the newly installed instance.
    const retained = JSON.parse(await run("docker", ["exec", container, "cat", `/var/lib/logtura/reports/${artifact.instance.instanceId}.json`]));
    assert.equal(retained.instanceId, JSON.parse(previousCheckpoint).instanceId);
    assert.ok(retained.lastReportSequence >= JSON.parse(previousCheckpoint).lastReportSequence);
    const reporter = new DeploymentReportingClient({url: service.url, token: machine.config.env.LOGTURA_HEARTBEAT_TOKEN, fetch});
    assert.equal(await reporter.reportApplied(deploymentId, {instanceId: artifact.instance.instanceId, sequence: artifact.instance.sequence, revision: artifact.instance.revision, reportSequence: Number.MAX_SAFE_INTEGER}), false);
    const afterOldReport = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
    assert.equal(afterOldReport.activeInstanceId, updatedArtifact.instance.instanceId);
    assert.ok(afterOldReport.lastReportSequence >= reapplied.lastReportSequence);
    assert.ok(afterOldReport.lastReportSequence < Number.MAX_SAFE_INTEGER);
    assert.equal(afterOldReport.applied.revision, pending.desired.revision);
    await website.applied(deploymentId, reapplied.desired.sequence, reapplied.desired.revision);
    options.afterReapplied?.();
    assert.ok(targetId); assert.deepEqual(service.unexpected, []);
    if(options.legacy){
      assert.equal(oldStops,1);assert.equal(candidateStarts,1);assert.equal((await actualLegacy()).state,"stopped");
      const row=await db.prepare("SELECT id,phase,replacement_phase,machine_id,payload_encrypted FROM managed_installations WHERE deployment_id=? AND replacement_phase='installed'").bind(deploymentId).first<{id:string;phase:string;replacement_phase:"installed";machine_id:string;payload_encrypted:ArrayBuffer|number[]}>();assert.ok(row);
      const runtimeEnv=await service.service.getBindings() as {CREDENTIAL_ENCRYPTION_KEY:string};
      const bytes=Array.isArray(row.payload_encrypted)?Uint8Array.from(row.payload_encrypted):new Uint8Array(row.payload_encrypted);
      const payload=JSON.parse(await decryptSecret(bytes,runtimeEnv.CREDENTIAL_ENCRYPTION_KEY));assert.equal(row.phase,"completed");assert.equal(payload.schemaVersion,3);assert.deepEqual(payload.before.config,legacyMachine.config);assert.deepEqual(payload.rollback,legacyMachine.config);
      validateFlyReplacementState({plan:{schemaVersion:1,id:row.id,app:appName!,org:"personal",name:payload.name,before:payload.before,after:payload.after,rollback:payload.rollback,volume:volumeId},phase:row.replacement_phase,machineId:row.machine_id});
      assert.equal(await run("docker",["exec",container,"printenv","PRIVATE_OLD"]),"fixture-old-private");
      console.log("Actual mountless legacy Vector → stopped checkpoint candidate → leased handoff → accepted report and website convergence → installed CLI edit and same-machine update passed; exact old config retained");
    }
    await run("docker", ["stop", "--time", "35", container]);
    assert.equal(await run("docker", ["inspect", "--format", "{{.State.ExitCode}}", container]), "0");
    console.log("Website-managed native queue: one app/checkpoint/machine, actual packaged Vector acknowledgement, website convergence, durable restart and CLI-edited leased reapply passed");
  } catch (error) { failure = error; }
  finally {
    const errors: string[] = [];
    // Inspect actual daemon state, including resources created before a lost
    // response. These unique run-owned names can never select another fixture.
    for(const ownedContainer of [container,legacyContainer])try {
      const names=await run("docker",["ps","--all","--format","{{.Names}}"]);
      if(names.split("\n").includes(ownedContainer))await run("docker",["rm","--force",ownedContainer]);
      assert.ok(!(await run("docker",["ps","--all","--format","{{.Names}}"])).split("\n").includes(ownedContainer));
    }catch{errors.push("managed owned container");}
    try {
      const names = await run("docker", ["volume", "ls", "--format", "{{.Name}}"]);
      if (names.split("\n").includes(volumeName)) await run("docker", ["volume", "rm", volumeName]);
      assert.ok(!(await run("docker", ["volume", "ls", "--format", "{{.Name}}"])).split("\n").includes(volumeName));
    } catch { errors.push("managed owned volume"); }
    if (deploymentId) await request(`/api/deployments/${deploymentId}`, undefined, "DELETE").catch(() => errors.push("managed owned deployment"));
    service.setProviderFixture(undefined);
    // The authorization fixture's target is in disposable, non-persisted D1;
    // service disposal removes it. A disconnect API remains separate work.
    if (errors.length) throw new Error(`Managed E2E cleanup failed: ${errors.join(", ")}`, { cause: failure });
  }
  if (failure) throw failure;
}
