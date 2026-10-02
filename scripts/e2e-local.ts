import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { startBrowser } from "../test/e2e/browser";
import { startLocalService } from "../test/e2e/local-workerd";

if (process.platform !== "linux") throw new Error("Local runtime E2E requires Linux Docker host networking");
const injectedFailure = process.env.LOGT_E2E_INJECT_FAILURE;
if (injectedFailure && !["after-create", "after-push", "after-runtime"].includes(injectedFailure)) throw new Error("Unsupported local E2E failure phase");
class InjectedFailure extends Error {}
function injectFailure(phase: string) { if (injectedFailure === phase) throw new InjectedFailure(`Injected local E2E failure: ${phase}`); }
const root = process.cwd(), temporary = mkdtempSync(join(tmpdir(), "logtura-local-e2e-"));
const consumer = join(temporary, "consumer"), artifacts = join(temporary, "packages");
mkdirSync(consumer); mkdirSync(artifacts);
const config = join(consumer, "forwarder config.yaml"), account = join(consumer, "account.json");
const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "", LOGT_AUTH_FILE: account, LOGT_SERVICE_TOKEN: "", LOGT_SERVICE_URL: "", FLY_API_TOKEN: "fixture-fly-token" };
delete environment.LOGT_SERVICE_URL;
delete environment.LOGT_SERVICE_TOKEN;
const children = new Set<ReturnType<typeof spawn>>();
function start(command: string, args: string[], cwd = consumer, env = environment, milliseconds = 120_000) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.once("close", () => children.delete(child));
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, milliseconds);
    child.once("error", () => { clearTimeout(timer); reject(new Error(`Unable to start ${command}`)); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args[0] ?? ""} failed (${code}); ${stderr.replace(/fixture[-\w]*token/gi, "[fixture token]").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 2000)}`)); });
  });
  return { child, result, stdout: () => stdout };
}
async function run(command: string, args: string[], cwd = consumer) { return (await start(command, args, cwd).result).stdout.trim(); }
async function waitFor(check: () => Promise<boolean> | boolean, label: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`${label} timed out`);
}
const runId = randomUUID().replaceAll("-", ""), imageTag = `logtura-local-e2e:${runId}`, container = `logtura-local-e2e-${runId}`, volume = `logtura-local-e2e-checkpoint-${runId}`;
let local: Awaited<ReturnType<typeof startLocalService>> | undefined;
let website: Awaited<ReturnType<typeof startBrowser>> | undefined;
let provider: ReturnType<typeof createServer> | undefined;
let deploymentId: string | undefined, connectionId: string | undefined;
let deployed = false, imageBuilt = false, installationAttempted = false, volumeCreated = false;
let failure: unknown;
let ownedRequest: ((path: string, body?: unknown, method?: string) => Promise<any>) | undefined;
let monitorIds: string[] = [];
let destinationIds: string[] = [];
try {
  const packageNames = readdirSync(join(root, "packages")).filter(name => {
    try { return JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")).name.startsWith("@logtura/"); } catch { return false; }
  });
  for (const name of packageNames) await run("pnpm", ["pack", "--pack-destination", artifacts], join(root, "packages", name));
  const archives = readdirSync(artifacts).filter(name => name.endsWith(".tgz")).map(name => join(artifacts, name));
  assert.equal(archives.length, packageNames.length);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...archives]);
  const core = await import(pathToFileURL(join(consumer, "node_modules/@logtura/core/dist/index.js")).href);
  const bin = join(consumer, "node_modules/.bin/logt");
  local = await startLocalService();
  const service = local;
  const request = async (path: string, body?: unknown, method = "GET") => {
    const headers = new Headers({ cookie: service.cookie, origin: service.url });
    if (body !== undefined && !(body instanceof FormData)) headers.set("content-type", "application/json");
    const response = await fetch(service.url + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), redirect: "manual" });
    assert.equal(response.status, 200, `${method} ${path} must succeed`);
    return response.json() as Promise<any>;
  };
  ownedRequest = request;
  assert.equal((await request("/api/me")).user.id, service.userId);
  website = await startBrowser(service);
  connectionId = await website.createConnection(`e2e-${runId}`, id => { connectionId = id; });
  monitorIds = (await request("/api/monitors")).monitors.map((monitor: any) => monitor.id);
  deploymentId = (await request("/api/deployments", { connectionId, displayName: "Existing fixture forwarder", targetKind: "fly", managed: false, sourceIds: [], heartbeatTarget: "logtura" }, "POST")).deployment.id;
  assert.ok(deploymentId); assert.ok(connectionId);
  await request(`/api/deployments/${deploymentId}`, { externalId: "fly:e2e-forwarder:abc123" }, "PUT");
  console.log("Local workerd: migrated fresh D1, created connection through the real website and deployment through HTTP");
  injectFailure("after-create");

  await website.deployment(deploymentId, "No configuration revision has been recorded for this deployment.");
  const login = start(bin, ["login", "--service", service.url, "--no-browser"]);
  // Attach rejection handling immediately while awaiting the approval code.
  const loginResult = login.result; void loginResult.catch(() => {});
  await waitFor(() => /Approval code: ([A-Z0-9-]+)/.test(login.stdout()), "installed CLI device login");
  const code = login.stdout().match(/Approval code: ([A-Z0-9-]+)/)![1];
  await website.approve(code!);
  await loginResult;
  assert.equal((JSON.parse(await run(bin, ["--json", "whoami"]))).user.id, service.userId);
  await run(bin, ["pull", deploymentId, "--service", service.url, "--output", config]);
  const before = await request(`/api/deployments/${deploymentId}/config/state`);
  const edits = join(consumer, "edits.json");
  writeFileSync(edits, JSON.stringify([{ kind: "connection.update", id: connectionId, patch: { displayName: "CLI-updated account" } }]));
  await run(bin, ["--config", config, "config", "edit", edits]);
  await run(bin, ["--config", config, "push"]);
  let desired = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
  assert.ok(desired.desired.sequence > (before.state?.desired.sequence ?? 0));
  assert.equal(desired.desired.document.connections[0].connection.displayName, "CLI-updated account");
  assert.equal((await request("/api/connections")).connections.find((item: any) => item.id === connectionId).displayName, "CLI-updated account");
  assert.equal(desired.applied, null);
  console.log("Installed CLI: browser-approved login, private pull/edit/push and website API desired revision agree");

  await website.changedConnection(connectionId);
  await website.deployment(deploymentId, "Waiting for forwarder");
  const savedAccount = readFileSync(account, "utf8");
  const denied = start(bin, ["login", "--service", service.url, "--no-browser", "--name", "e2e-denied"]);
  void denied.result.catch(() => {});
  await waitFor(() => /Approval code: ([A-Z0-9-]+)/.test(denied.stdout()), "denied CLI device login");
  await website.deny(denied.stdout().match(/Approval code: ([A-Z0-9-]+)/)![1]!);
  await assert.rejects(denied.result, /access_denied/);
  assert.ok(readFileSync(account, "utf8") === savedAccount, "denied login must preserve the saved account");
  const websiteMonitorId = await website.createMonitor(id => { monitorIds.push(id); });
  const websiteWebhookUrl = `https://webhook.example.invalid/private-e2e-${runId}`;
  const websiteDestinationId = await website.createDestination(websiteWebhookUrl, id => { destinationIds.push(id); });
  const websiteSinkId = await website.addSink(websiteMonitorId);
  await website.enableMetrics(deploymentId);
  const previousSequence = desired.desired.sequence;
  await run(bin, ["pull", deploymentId, "--output", config, "--force"]);
  await run(bin, ["--config", config, "push"]);
  desired = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
  assert.ok(desired.desired.sequence > previousSequence);
  const websiteMonitorEntry = desired.desired.document.monitors.find((item: any) => item.monitor.id === websiteMonitorId);
  const websiteMonitor = websiteMonitorEntry?.monitor;
  assert.equal(websiteMonitor?.connectionId, connectionId);
  assert.deepEqual(websiteMonitor?.filterSteps, [{ kind: "errors" }, { kind: "dedup", window_secs: 120, fields: ["script", "message"] }]);
  assert.equal(websiteMonitorEntry.sinks.length, 1);
  assert.equal(websiteMonitorEntry.sinks[0].sink.id, websiteSinkId);
  assert.equal(websiteMonitorEntry.sinks[0].destination.id, websiteDestinationId);
  assert.equal(websiteMonitorEntry.sinks[0].destination.kind, "webhook");
  assert.deepEqual(websiteMonitorEntry.sinks[0].sink.filterSteps, [{ kind: "dedup", window_secs: 300, fields: ["message"] }]);
  assert.ok(!JSON.stringify(desired).includes(websiteWebhookUrl), "public configuration state must not expose destination payloads");
  assert.ok(!readFileSync(config, "utf8").includes(websiteWebhookUrl), "portable YAML must use secret references");
  assert.ok(readFileSync(join(dirname(config), ".env"), "utf8").includes(websiteWebhookUrl), "installed CLI must retain the private destination payload");
  assert.equal(statSync(join(dirname(config), ".env")).mode & 0o777, 0o600);
  await website.deployment(deploymentId, "Waiting for forwarder");
  console.log("Real browser: approval/denial, signed-out return, CLI-visible website edit and reload continuity passed");
  injectFailure("after-push");
  const imageContext = join(temporary, "image"); mkdirSync(imageContext);
  writeFileSync(join(imageContext, "Dockerfile"), core.renderDockerfile([], { runtimeSupervisor: true, mountVectorYamlAtRuntime: true }));
  for (const file of core.runtimeImageFiles(readFileSync(join(consumer, "node_modules/@logtura/cli/dist/runtime-bin.js")))) {
    const path = join(imageContext, file.name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.content, { mode: file.mode });
  }
  await run("docker", ["build", "--quiet", "--tag", imageTag, imageContext]); imageBuilt = true;
  const dockerImageId = await run("docker", ["image", "inspect", "--format", "{{.Id}}", imageTag]);
  const image = `registry.fixture/forwarder@${dockerImageId}`;
  const installed = join(temporary, "installed"); mkdirSync(installed);
  await run("docker", ["volume", "create", volume]); volumeCreated = true;
  let updates = 0;
  let machine: any = { id: "abc123", instance_id: "original", state: "started", region: "ord", config: { image: "registry.fixture/old:latest", env: {} }, image_ref: { registry: "registry.fixture", repository: "old", digest: `sha256:${"b".repeat(64)}` } };
  provider = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer fixture-fly-token");
      const path = new URL(request.url!, "http://fixture").pathname;
      let result: any;
      if (path.endsWith("/lease")) result = request.method === "DELETE" ? null : { data: { nonce: "fixture-lease" } };
      else if (request.method === "POST" && path.endsWith("/machines/abc123")) {
        let body = ""; for await (const chunk of request) body += chunk;
        const update = JSON.parse(body); assert.equal(update.current_version, machine.instance_id);
        assert.equal(request.headers["fly-machine-lease-nonce"], "fixture-lease");
        assert.equal(update.config.image, image);
        for (const file of update.config.files) {
          assert.ok(file.guest_path.startsWith("/etc/vector/") || file.guest_path.startsWith("/opt/logtura/assets/"));
          const path = join(installed, file.guest_path.slice(1)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(file.raw_value, "base64")); chmodSync(path, file.mode);
        }
        const args = ["run", "--detach", "--name", container, "--network", "host", "--stop-timeout", "35", "--volume", `${join(installed, "etc/vector")}:/etc/vector:ro`, "--volume", `${volume}:/var/lib/logtura`];
        for (const [key, value] of Object.entries(update.config.env)) args.push("--env", `${key}=${value}`);
        args.push(imageTag, ...update.config.init.cmd);
        installationAttempted = true;
        await run("docker", args); deployed = true;
        assert.equal(await run("docker", ["inspect", "--format", "{{.Image}}", container]), dockerImageId);
        updates++;
        machine = { ...machine, instance_id: `updated-${updates}`, config: update.config, image_ref: { registry: "registry.fixture", repository: "forwarder", digest: dockerImageId } };
        result = machine;
      } else if (path.endsWith("/machines")) result = [machine];
      else if (path.endsWith("/volumes")) result = [{ id: "vol_fixture", region: "ord", state: "created", encrypted: true, attached_machine_id: updates ? machine.id : null }];
      else if (path.endsWith("/machines/abc123")) {
        if (deployed) machine.state = await run("docker", ["inspect", "--format", "{{.State.Running}}", container]) === "true" ? "started" : "stopped";
        result = machine;
      } else { assert.equal(path, "/v1/apps/e2e-forwarder"); result = { name: "e2e-forwarder", organization: { slug: "personal" } }; }
      response.writeHead(result === null ? 204 : 200, { "content-type": "application/json" }); response.end(result === null ? undefined : JSON.stringify(result));
    } catch { response.writeHead(503); response.end("fixture operation failed"); }
  });
  await new Promise<void>(resolve => provider!.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const interceptor = join(consumer, "provider-fixture.mjs");
  writeFileSync(interceptor, `const native=fetch;globalThis.fetch=(input,init)=>{const url=String(input);return native(url.startsWith('https://api.machines.dev/')?${JSON.stringify(providerUrl)}+'/'+url.slice('https://api.machines.dev/'.length):input,init)};`);
  const applied = start(bin, ["--config", config, "deploy", "fly", "--image", image, "--volume", "vol_fixture", "--region", "ord", "--wait-seconds", "120"], consumer,
    { ...environment, NODE_OPTIONS: `--import=${pathToFileURL(interceptor)}` }, 180_000);
  await applied.result;
  assert.equal(updates, 1);
  const state = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
  assert.equal(state.stale, false); assert.ok(state.lastReportSequence >= 1);
  assert.equal(state.applied.revision, desired.desired.revision); assert.equal(state.applied.sequence, desired.desired.sequence);
  assert.ok(!("pendingApply" in JSON.parse(await run(bin, ["--config", config, "config", "status"]))));
  assert.ok(readdirSync(consumer).some(name => name.startsWith(".logtura-applied-")));
  await waitFor(async () => {
    const detail = (await request(`/api/deployments/${deploymentId}`)).deployment;
    return Number.isFinite(detail.lastSeenAt) && detail.lastSeenAt > 0 && Number.isFinite(detail.metricsSnapshot?.updatedAt) && Object.keys(detail.metricsSnapshot.byComponent).length > 0;
  }, "actual Vector heartbeat and metrics HTTP delivery");
  await website.applied(deploymentId, desired.desired.sequence, desired.desired.revision);
  await website.revoke();
  await assert.rejects(run(bin, ["whoami"]), /invalid_account_token \(HTTP 401\)/);
  website.assertNoErrors();
  const counterBeforeRestart = (await request(`/api/deployments/${deploymentId}/config/state`)).state.lastReportSequence;
  await run("docker", ["restart", "--time", "35", container]);
  const restartedAt = await run("docker", ["inspect", "--format", "{{.State.StartedAt}}", container]);
  await waitFor(async () => {
    const logs = await run("docker", ["logs", "--since", restartedAt, container]);
    const reported = logs.split("\n").some(line => {
      try { const event = JSON.parse(line); return event.event === "applied_report" && event.accepted === true && event.reportSequence > counterBeforeRestart; } catch { return false; }
    });
    const current = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
    return reported && current.lastReportSequence > counterBeforeRestart && current.activeInstanceId === state.activeInstanceId && !current.stale;
  }, "durable runtime reporting across container restart");
  assert.deepEqual(service.unexpected, []);
  assert.ok(!JSON.stringify(state).includes("fixture-private-provider-token"));
  injectFailure("after-runtime");
  await run("docker", ["stop", "--time", "35", container]);
  assert.equal(await run("docker", ["inspect", "--format", "{{.State.ExitCode}}", container]), "0");
  await run(bin, ["logout"]);
  await request(`/api/deployments/${deploymentId}`, undefined, "DELETE"); deploymentId = undefined;
  for (const id of monitorIds) await request(`/api/monitors/${id}`, undefined, "DELETE");
  monitorIds = [];
  for (const id of destinationIds) await request(`/api/destinations/${id}`, undefined, "DELETE");
  destinationIds = [];
  await request(`/api/connections/${connectionId}`, undefined, "DELETE"); connectionId = undefined;
  console.log("Actual packaged Docker supervisor: loaded issued bytes, reported to real workerd/D1, converged website state and stopped gracefully");
} catch (error) { failure = error; }
finally {
  const cleanupFailures: string[] = [];
  for (const child of children) child.kill("SIGKILL");
  if (installationAttempted) await run("docker", ["rm", "--force", container]).catch(() => cleanupFailures.push("owned container"));
  if (volumeCreated) await run("docker", ["volume", "rm", volume]).catch(() => cleanupFailures.push("owned checkpoint volume"));
  if (imageBuilt) await run("docker", ["image", "rm", imageTag]).catch(() => cleanupFailures.push("owned image tag"));
  if (ownedRequest) {
    if (deploymentId) await ownedRequest(`/api/deployments/${deploymentId}`, undefined, "DELETE").catch(() => cleanupFailures.push("owned deployment"));
    for (const id of monitorIds) await ownedRequest(`/api/monitors/${id}`, undefined, "DELETE").catch(() => cleanupFailures.push("owned monitor"));
    for (const id of destinationIds) await ownedRequest(`/api/destinations/${id}`, undefined, "DELETE").catch(() => cleanupFailures.push("owned destination"));
    if (connectionId) await ownedRequest(`/api/connections/${connectionId}`, undefined, "DELETE").catch(() => cleanupFailures.push("owned connection"));
    for (const kind of ["deployments", "connections", "monitors", "destinations"]) {
      await ownedRequest(`/api/${kind}`).then(body => {
        if (body[kind].length !== 0) cleanupFailures.push(`remaining ${kind}`);
      }).catch(() => cleanupFailures.push(`verify ${kind} cleanup`));
    }
  }
  if (website) await website.close().catch(() => cleanupFailures.push("owned browser"));
  if (provider) await new Promise<void>(resolve => provider!.close(() => resolve()));
  if (local) await local.service.dispose().catch(() => cleanupFailures.push("isolated workerd"));
  try { rmSync(temporary, { recursive: true, force: true }); } catch { cleanupFailures.push("private temporary files"); }
  if (cleanupFailures.length) throw new Error(`Local E2E cleanup failed: ${cleanupFailures.join(", ")}`, { cause: failure });
}
if (failure instanceof InjectedFailure) console.log(`${failure.message}; all owned resources cleaned`);
else if (failure) throw failure;
else if (injectedFailure) throw new Error("Requested E2E failure boundary was not reached");
