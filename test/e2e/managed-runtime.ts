import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  connectionId: string; temporary: string; runId: string; afterApplied?: () => void;
  image: { tag: string; dockerId: string; platformDigest: string; platformManifest: string; indexDigest: string; index: string };
}) {
  const { service, website, request, run, image } = options;
  const container = `logtura-managed-e2e-${options.runId}`;
  const volumeName = `logtura-managed-e2e-volume-${options.runId}`;
  const volumeId = `vol_${options.runId}`;
  const machineId = options.runId.slice(0, 14);
  const installed = join(options.temporary, "managed-installed");
  mkdirSync(installed);
  let deploymentId: string | undefined, targetId: string | undefined, appName: string | undefined;
  let appCreated = false, volume: any, machine: any;
  let appCreates = 0, volumeCreates = 0, machineCreates = 0, registryReads = 0;
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
        if (providerRequest.method === "GET") return Response.json(machine ? [await actualMachine()] : []);
        assert.equal(providerRequest.method, "POST"); assert.equal(machine, undefined); assert.ok(volume);
        const body = await providerRequest.json() as any;
        assert.equal(body.name, "forwarder"); assert.equal(body.region, volume.region);
        const config = body.config;
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
        const args = ["run", "--detach", "--name", container, "--network", "host", "--stop-timeout", "35", "--volume", `${join(installed, "etc/vector")}:/etc/vector:ro`, "--volume", `${volumeName}:/var/lib/logtura`];
        if (config.files.some((file: any) => file.guest_path.startsWith("/opt/logtura/assets/"))) args.push("--volume", `${join(installed, "opt/logtura/assets")}:/opt/logtura/assets:ro`);
        for (const [name, value] of Object.entries(config.env)) args.push("--env", `${name}=${value}`);
        args.push(image.tag, ...config.init.cmd);
        await run("docker", args); machineCreates++;
        assert.equal(await run("docker", ["inspect", "--format", "{{.Image}}", container]), image.dockerId);
        machine = { id: machineId, name: "forwarder", instance_id: "managed-version-1", region: body.region, config, image_ref: { registry: "ghcr.io", repository: "q32llc/logtura-forwarder", digest: image.platformDigest } };
        return Response.json(await actualMachine());
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
    const parent = await website.connectAndDeployManaged(deploymentId, id => { targetId = id; });
    await waitFor(async () => {
      const { job } = await request(`/api/jobs/${parent}`);
      if (job.status === "failed") throw new Error(`Managed queue failed: ${job.error}`);
      return job.status === "succeeded";
    }, "website-managed queue completion");
    assert.equal(appCreates, 1); assert.equal(volumeCreates, 1); assert.equal(machineCreates, 1); assert.equal(registryReads, 2);
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
    await run("docker", ["stop", "--time", "35", container]);
    assert.equal(await run("docker", ["inspect", "--format", "{{.State.ExitCode}}", container]), "0");
    assert.ok(targetId); assert.deepEqual(service.unexpected, []);
    console.log("Website-managed native queue: one app/checkpoint/machine, actual packaged Vector acknowledgement, website convergence and durable restart passed");
  } catch (error) { failure = error; }
  finally {
    const errors: string[] = [];
    // Inspect actual daemon state, including resources created before a lost
    // response. These unique run-owned names can never select another fixture.
    try {
      const names = await run("docker", ["ps", "--all", "--format", "{{.Names}}"]);
      if (names.split("\n").includes(container)) await run("docker", ["rm", "--force", container]);
      assert.ok(!(await run("docker", ["ps", "--all", "--format", "{{.Names}}"])).split("\n").includes(container));
    } catch { errors.push("managed owned container"); }
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
