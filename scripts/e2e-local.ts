import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { startBrowser } from "../test/e2e/browser";
import { startLocalService } from "../test/e2e/local-workerd";
import { managedRuntimeJourney } from "../test/e2e/managed-runtime";
import { localHttpFetch } from "../test/e2e/local-http.mjs";

if (process.platform !== "linux") throw new Error("Local runtime E2E requires Linux Docker host networking");
const injectedFailure = process.env.LOGT_E2E_INJECT_FAILURE;
if (injectedFailure && !["after-create", "after-push", "after-runtime", "after-managed-runtime", "after-managed-update", "after-legacy-runtime", "after-legacy-update", "after-legacy-rollback", "after-legacy-cleanup", "after-legacy-redeployment"].includes(injectedFailure)) throw new Error("Unsupported local E2E failure phase");
class InjectedFailure extends Error {}
function injectFailure(phase: string) { if (injectedFailure === phase) throw new InjectedFailure(`Injected local E2E failure: ${phase}`); }
const root = process.cwd(), temporary = mkdtempSync(join(tmpdir(), "logtura-local-e2e-"));
const consumer = join(temporary, "consumer"), artifacts = join(temporary, "packages");
mkdirSync(consumer); mkdirSync(artifacts);
const config = join(consumer, "forwarder config.yaml"), account = join(consumer, "account.json");
const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "", LOGT_AUTH_FILE: account, LOGT_SERVICE_TOKEN: "", LOGT_SERVICE_URL: "", LOGT_REGISTRY_TOKEN: "", FLY_API_TOKEN: "fixture-fly-token" };
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
const legacyContainer=`${container}-linked-legacy`;
let legacyInstalled=false;
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
  const yaml = createRequire(join(consumer, "package.json"))("yaml") as {parse(text: string): unknown};
  const bin = join(consumer, "node_modules/.bin/logt");
  const documentation = readFileSync(join(root, "src/web/docs/open-source.mdx"), "utf8");
  const example = documentation.match(/```yaml\n([\s\S]*?)\n```/)?.[1];
  assert.ok(example, "public documentation must contain the standalone YAML example");
  const documentationConfig = join(consumer, "documentation.yaml"), documentationBundle = join(consumer, "documentation bundle");
  writeFileSync(documentationConfig, example, { mode: 0o600 });
  const documentationEnvironment = { ...environment, CLOUDFLARE_ACCOUNT_ID: "fixture-documentation-account", CLOUDFLARE_API_TOKEN: "fixture-documentation-token", SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/fixture/documentation/webhook" };
  await start(bin, ["-c", documentationConfig, "env", "--check"], consumer, documentationEnvironment).result;
  assert.match((await start(bin, ["-c", documentationConfig, "validate"], consumer, documentationEnvironment).result).stdout, /ok: 1 source/);
  await start(bin, ["-c", documentationConfig, "bundle", "-o", documentationBundle], consumer, documentationEnvironment).result;
  assert.ok(readFileSync(join(documentationBundle, "vector.yaml"), "utf8").includes("api-worker"));
  assert.equal(statSync(join(documentationBundle, ".env")).mode & 0o777, 0o600);
  local = await startLocalService();
  const service = local;
  const request = async (path: string, body?: unknown, method = "GET") => {
    const headers = new Headers({ cookie: service.cookie, origin: service.url });
    if (body !== undefined && !(body instanceof FormData)) headers.set("content-type", "application/json");
    const response = await localHttpFetch(service.url + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), redirect: "manual" });
    assert.equal(response.status, 200, `${method} ${path} must succeed`);
    return response.json() as Promise<any>;
  };
  ownedRequest = request;
  assert.equal((await request("/api/me")).user.id, service.userId);
  website = await startBrowser(service);
  connectionId = await website.createConnection(`e2e-${runId}`, id => { connectionId = id; });
  monitorIds = (await request("/api/monitors")).monitors.map((monitor: any) => monitor.id);
  deploymentId = await website.createDeployment(connectionId, id => { deploymentId = id; });
  assert.ok(deploymentId); assert.ok(connectionId);
  // Bind the disposable existing-machine fixture and keep provider streams off
  // for this configuration/runtime journey. Event delivery has separate cases.
  await request(`/api/deployments/${deploymentId}`, { externalId: "fly:e2e-forwarder:abc123", sourceIds: [] }, "PUT");
  console.log("Local workerd: migrated fresh D1, created connection and deployment through the real website");
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
  writeFileSync(edits, JSON.stringify([{ kind: "connection.update", id: connectionId, patch: { displayName: "CLI-updated account" }, discoverSources: true }]));
  await run(bin, ["--config", config, "config", "edit", edits]);
  await run(bin, ["--config", config, "push"]);
  let desired = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
  assert.ok(desired.desired.sequence > (before.state?.desired.sequence ?? 0));
  assert.equal(desired.desired.document.connections[0].connection.displayName, "CLI-updated account");
  assert.equal(desired.desired.document.connections[0].discoverSources, true);
  assert.equal((await request("/api/connections")).connections.find((item: any) => item.id === connectionId).displayName, "CLI-updated account");
  assert.equal(desired.applied, null);
  const previousCredentialVersion = desired.desired.document.connections[0].credentials.version;
  console.log("Installed CLI: browser-approved login, private pull/edit/push and website API desired revision agree");

  await website.changedConnection(connectionId);
  const resumeDiscovery = service.holdDiscovery();
  let rediscoveryId: string;
  try { rediscoveryId = await website.rediscover(connectionId, resumeDiscovery); }
  finally { resumeDiscovery(); }
  assert.equal((await request(`/api/jobs/${rediscoveryId}`)).job.status, "succeeded");
  const rotatedProviderToken = service.rotateProviderFixtureCredential();
  await website.reconnect(connectionId, rotatedProviderToken);
  assert.ok(service.rotatedVerificationCount() > 0, "provider must verify the replacement credential");
  assert.equal((await request(`/api/deployments/${deploymentId}`)).deployment.id, deploymentId);
  await website.deployment(deploymentId, "Configuration changed");
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
  assert.equal(desired.desired.document.connections[0].discoverSources, true, "website metrics edits must preserve CLI discovery mode");
  assert.deepEqual(desired.desired.document.connections[0].selectedSources, [], "the provider fixture has no streams to deliver");
  assert.notEqual(desired.desired.document.connections[0].credentials.version, previousCredentialVersion);
  assert.ok(readFileSync(join(dirname(config), ".env"), "utf8").includes(rotatedProviderToken), "CLI pull must capture the replacement provider credential");
  assert.ok(!JSON.stringify(desired).includes(rotatedProviderToken), "public state must not disclose the replacement credential");
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
  const digest = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const platformManifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: dockerImageId, size: 12 }, layers: [] });
  const platformDigest = digest(platformManifest), platformImage = `registry.fixture/forwarder@${platformDigest}`;
  const imageIndex = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: platformDigest, size: Buffer.byteLength(platformManifest), platform: { os: "linux", architecture: "amd64" } }] });
  const indexDigest = digest(imageIndex), image = `registry.fixture/forwarder@${indexDigest}`;
  assert.notEqual(platformDigest, dockerImageId); assert.notEqual(indexDigest, platformDigest);
  let registryReads = 0;
  const installed = join(temporary, "installed"); mkdirSync(installed);
  await run("docker", ["volume", "create", volume]); volumeCreated = true;
  let updates = 0, creates = 0, legacyDeliveries=0, cleanupDeletes=0, candidateDeleted=false, legacyDeleted=false;
  let retained: any = null;
  let machine: any = { id: "abc123", instance_id: "original", state: "started", region: "ord", config: { image: "registry.fixture/forwarder:legacy-fixture", env: {PRIVATE_OLD:"fixture-linked-legacy"} }, image_ref: { registry: "registry.fixture", repository: "forwarder", digest: platformDigest } };
  provider = createServer(async (request, response) => {
    try {
      const path = new URL(request.url!, "http://fixture").pathname;
      if(path==="/legacy-output"){assert.equal(request.method,"POST");for await(const chunk of request){void chunk;}legacyDeliveries++;response.writeHead(204);response.end();return;}
      if (path.startsWith("/registry/")) {
        assert.equal(request.headers.authorization, undefined);
        const registryPath = path.slice("/registry".length);
        const bytes = registryPath === `/v2/forwarder/manifests/${indexDigest}` ? imageIndex : registryPath === `/v2/forwarder/manifests/${platformDigest}` ? platformManifest : null;
        assert.ok(bytes, "registry request must identify an owned immutable manifest"); registryReads++;
        response.writeHead(200, { "content-type": "application/json" }); response.end(bytes); return;
      }
      assert.equal(request.headers.authorization, "Bearer fixture-fly-token");
      let result: any;
      const target = path.includes("/machines/abc123") && retained ? retained : machine;
      if (path.endsWith("/lease")) result = request.method === "DELETE" ? null : { data: { nonce: "fixture-lease" } };
      else if(request.method==="DELETE" && /\/machines\/(abc123|def456|fed987)$/.test(path)){
        assert.equal(new URL(request.url!,"http://fixture").search,"");assert.equal(request.headers["fly-machine-lease-nonce"],"fixture-lease");
        const journal=JSON.parse(readFileSync(join(dirname(config),".logtura-cleanup.json"),"utf8"));assert.equal(journal.state.phase,"deleting");assert.equal(journal.state.plan.retired.id,target.id);
        assert.equal((await ownedRequest!(`/api/deployments/${deploymentId}/config/fly-cleanups/${journal.request.requestId}`)).status,"prepared");
        assert.equal(target.state,"stopped");const survivor=target===machine?retained:machine;assert.equal(survivor.state,"started");
        if(target===machine){assert.equal(await run("docker",["inspect","--format","{{.State.Running}}",container]),"false");assert.equal(await run("docker",["inspect","--format","{{.State.Running}}",legacyContainer]),"true");await run("docker",["rm",container]);deployed=false;candidateDeleted=true;}
        else{assert.equal(await run("docker",["inspect","--format","{{.State.Running}}",legacyContainer]),"false");assert.equal(await run("docker",["inspect","--format","{{.State.Running}}",container]),"true");await run("docker",["rm",legacyContainer]);legacyInstalled=false;legacyDeleted=true;}
        cleanupDeletes++;result=null;
      }
      else if (request.method === "POST" && path.endsWith("/stop")) {
        if(target.id==="abc123" && legacyInstalled)await run("docker",["stop","--time","35",legacyContainer]);
        else if (target === machine && deployed) await run("docker", ["stop", "--time", "35", container]);
        target.state = "stopped"; result = null;
      } else if (request.method === "POST" && path.endsWith("/start")) {
        assert.ok(deployed);
        if(target.id==="abc123"){
          assert.equal(machine.state,"stopped");await run("docker",["start",legacyContainer]);target.state="started";
        }else{
          assert.equal(target,machine);assert.ok(!retained || retained.state === "stopped", "standby must stop before the candidate starts");
          await run("docker", ["start", container]); machine.state = "started";
        }result = null;
      } else if (request.method === "POST" && (path.endsWith("/machines") || /\/machines\/(abc123|def456|fed987)$/.test(path))) {
        let body = ""; for await (const chunk of request) body += chunk;
        const update = JSON.parse(body), creating = path.endsWith("/machines");
        if (!creating && !target.config.mounts?.length && update.config.mounts?.length) {
          response.writeHead(400); response.end("A new volume requires a new machine"); return;
        }
        if(!creating && target===retained && target.id==="abc123" && update.skip_launch===undefined){
          assert.equal(target.state,"stopped");assert.equal(machine.state,"stopped");assert.equal(update.current_version,target.instance_id);assert.equal(request.headers["fly-machine-lease-nonce"],"fixture-lease");assert.deepEqual(update.config,legacyRollbackBaseline);
          await run("docker",["rm",legacyContainer]);await run("docker",["create","--name",legacyContainer,"--network","host","--stop-timeout","35","--volume",`${legacyDirectory}:/etc/vector:ro`,"--env","PRIVATE_OLD=fixture-linked-legacy",imageTag,...update.config.init.cmd]);
          assert.equal(await run("docker",["inspect","--format","{{.Image}}",legacyContainer]),dockerImageId);target.config=structuredClone(update.config);target.instance_id="restored-original";response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify(target));return;
        }
        assert.equal(update.skip_launch, true);
        if (creating) {
          const original=creates===0?machine:retained;assert.equal(original.id,"abc123");assert.equal(original.state,"started");if(creates>0){assert.ok(candidateDeleted);assert.equal(deployed,false);}
          retained=structuredClone(original);creates++;candidateDeleted=false;
        } else {
          assert.equal(target, machine); assert.equal(update.current_version, machine.instance_id);
          assert.equal(machine.state, "stopped"); assert.equal(request.headers["fly-machine-lease-nonce"], "fixture-lease");
          assert.deepEqual(update.config.mounts, machine.config.mounts);
          await run("docker", ["rm", container]);
        }
        assert.equal(update.config.image, platformImage);
        for (const file of update.config.files) {
          assert.ok(file.guest_path.startsWith("/etc/vector/") || file.guest_path.startsWith("/opt/logtura/assets/"));
          const path = join(installed, file.guest_path.slice(1)); mkdirSync(dirname(path), { recursive: true }); rmSync(path, {force:true}); writeFileSync(path, Buffer.from(file.raw_value, "base64")); chmodSync(path, file.mode);
        }
        const args = ["create", "--name", container, "--network", "host", "--stop-timeout", "35", "--volume", `${join(installed, "etc/vector")}:/etc/vector:ro`, "--volume", `${volume}:/var/lib/logtura`];
        for (const [key, value] of Object.entries(update.config.env)) args.push("--env", `${key}=${value}`);
        args.push(imageTag, ...update.config.init.cmd);
        installationAttempted = true;
        await run("docker", args); deployed = true;
        assert.equal(await run("docker", ["inspect", "--format", "{{.Image}}", container]), dockerImageId);
        updates++;
        machine = { id: creating ? creates===1?"def456":"fed987" : machine.id, name: creating ? update.name : machine.name, region: "ord", state: creating ? "created" : "stopped", instance_id: `updated-${updates}`, config: update.config, image_ref: { registry: "registry.fixture", repository: "forwarder", digest: platformDigest } };
        // Fly decorates readback mounts; later installed-CLI updates retain those
        // fields in their private plan, so rollback must validate that real shape.
        machine.config.mounts=machine.config.mounts.map((mount:any)=>({...mount,name:"fixture_checkpoint",encrypted:true,size_gb:1}));
        result = machine;
      } else if (path.endsWith("/machines")) result = retained ? [...(legacyDeleted?[]:[retained]),...(candidateDeleted?[]:[machine])] : [machine];
      else if (path.endsWith("/volumes")) result = [{ id: "vol_fixture", region: "ord", state: "created", encrypted: true, attached_machine_id: deployed ? machine.id : null }];
      else if (/\/machines\/(abc123|def456|fed987)$/.test(path)) {
        if(target.id==="abc123" && legacyInstalled)target.state=await run("docker",["inspect","--format","{{.State.Running}}",legacyContainer])==="true"?"started":"stopped";
        else if (target === machine && deployed) machine.state = await run("docker", ["inspect", "--format", "{{.State.Running}}", container]) === "true" ? "started" : "stopped";
        result = target;
      } else { assert.equal(path, "/v1/apps/e2e-forwarder"); result = { name: "e2e-forwarder", organization: { slug: "personal" } }; }
      response.writeHead(result === null ? 204 : 200, { "content-type": "application/json" }); response.end(result === null ? undefined : JSON.stringify(result));
    } catch (error) { console.error("Local provider fixture failed", request.method, new URL(request.url!, "http://fixture").pathname, error instanceof Error ? error.stack?.split("\n").slice(1,4).join("\n") : "unknown"); response.writeHead(503); response.end("fixture operation failed"); }
  });
  await new Promise<void>(resolve => provider!.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const legacyDirectory=join(temporary,"linked-legacy");mkdirSync(legacyDirectory);
  const legacyYaml=`api:
  enabled: true
  address: 0.0.0.0:8686
sources:
  legacy_pulse:
    type: demo_logs
    format: json
    interval: 0.2
sinks:
  legacy_output:
    type: http
    inputs: [legacy_pulse]
    uri: ${providerUrl}/legacy-output
    encoding:
      codec: json
    batch:
      timeout_secs: 0.2
`;
  writeFileSync(join(legacyDirectory,"vector.yaml"),legacyYaml,{mode:0o400});
  machine.config={...machine.config,files:[{guest_path:"/etc/vector/vector.yaml",raw_value:Buffer.from(legacyYaml).toString("base64"),mode:0o400}],init:{cmd:["--config","/etc/vector/vector.yaml"]}};
  const legacyBaseline=structuredClone(machine.config),legacyRollbackBaseline=core.flyRollbackConfig(machine);
  legacyInstalled=true;await run("docker",["run","--detach","--name",legacyContainer,"--network","host","--stop-timeout","35","--volume",`${legacyDirectory}:/etc/vector:ro`,"--env","PRIVATE_OLD=fixture-linked-legacy",imageTag,"--config","/etc/vector/vector.yaml"]);
  await waitFor(()=>legacyDeliveries>0,"actual original legacy Vector delivery");
  const interceptor = join(consumer, "provider-fixture.mjs");
  writeFileSync(interceptor, `const native=fetch;globalThis.fetch=(input,init)=>{const url=String(input);return native(url.startsWith('https://api.machines.dev/')?${JSON.stringify(providerUrl)}+'/'+url.slice('https://api.machines.dev/'.length):url.startsWith('https://registry.fixture/')?${JSON.stringify(providerUrl)}+'/registry/'+url.slice('https://registry.fixture/'.length):input,init)};`);
  const applied = start(bin, ["--config", config, "deploy", "fly", "--image", image, "--volume", "vol_fixture", "--region", "ord", "--wait-seconds", "120"], consumer,
    { ...environment, NODE_OPTIONS: `--import=${pathToFileURL(interceptor)}` }, 180_000);
  await applied.result;
  assert.equal(updates, 1); assert.equal(creates, 1);
  assert.equal(retained.id, "abc123"); assert.equal(retained.state, "stopped");
  assert.deepEqual(retained.config,legacyBaseline);
  assert.equal(machine.id, "def456");
  const projected = JSON.parse(readFileSync(`${config}.logtura-link.json`, "utf8"));
  assert.equal(projected.target.fly.machineId, "def456");
  assert.equal(registryReads, 2, "installed CLI verifies both OCI index and platform manifest");
  assert.equal(machine.config.image, platformImage);
  let state = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
  assert.equal(state.stale, false); assert.ok(state.lastReportSequence >= 1);
  assert.equal(state.applied.revision, desired.desired.revision); assert.equal(state.applied.sequence, desired.desired.sequence);
  assert.ok(!("pendingApply" in JSON.parse(await run(bin, ["--config", config, "config", "status"]))));
  assert.ok(readdirSync(consumer).some(name => name.startsWith(".logtura-applied-")));
  await waitFor(async () => {
    const detail = (await request(`/api/deployments/${deploymentId}`)).deployment;
    return Number.isFinite(detail.lastSeenAt) && detail.lastSeenAt > 0 && Number.isFinite(detail.metricsSnapshot?.updatedAt) && Object.keys(detail.metricsSnapshot.byComponent).length > 0;
  }, "actual Vector heartbeat and metrics HTTP delivery");
  await website.applied(deploymentId, desired.desired.sequence, desired.desired.revision);
  await website.metrics(deploymentId);
  // The next installed CLI apply must recognize the retained standby, update
  // the mounted candidate, and keep the graph clock and physical target stable.
  const firstInstance = state.activeInstanceId, firstVersion = projected.configurationVersion;
  await start(bin, ["--config", config, "deploy", "fly", "--image", image, "--volume", "vol_fixture", "--region", "ord", "--wait-seconds", "120"], consumer,
    { ...environment, NODE_OPTIONS: `--import=${pathToFileURL(interceptor)}` }, 180_000).result;
  assert.equal(creates, 1); assert.equal(updates, 2); assert.equal(registryReads, 4);
  assert.equal(retained.state, "stopped"); assert.equal(machine.id, "def456");
  assert.equal(JSON.parse(readFileSync(`${config}.logtura-link.json`, "utf8")).configurationVersion, firstVersion);
  state = (await request(`/api/deployments/${deploymentId}/config/state`)).state;
  assert.notEqual(state.activeInstanceId, firstInstance); assert.equal(state.stale, false);
  assert.equal(state.applied.revision, desired.desired.revision); assert.equal(state.applied.sequence, desired.desired.sequence);
  await website.applied(deploymentId, desired.desired.sequence, desired.desired.revision);

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
  const beforeRestoreDeliveries=legacyDeliveries;
  const rolled=JSON.parse((await start(bin,["--config",config,"deploy","fly","--rollback","--wait-seconds","120","--json"],consumer,{...environment,NODE_OPTIONS:`--import=${pathToFileURL(interceptor)}`},180_000).result).stdout);
  await waitFor(()=>legacyDeliveries>beforeRestoreDeliveries,"actual restored legacy Vector delivery");
  assert.equal(retained.state,"started");assert.equal(machine.state,"stopped");assert.deepEqual(retained.config,legacyRollbackBaseline);
  const rolledBack=(await request(`/api/deployments/${deploymentId}/config/state`)).state;
  assert.equal(rolledBack.activeInstanceId,null);assert.equal(rolledBack.applied,null);assert.equal(rolledBack.stale,false);
  assert.equal(JSON.parse(readFileSync(`${config}.logtura-link.json`,"utf8")).target.fly.machineId,"abc123");
  await website.deployment(deploymentId,"Applied revision: not reported");
  const rollbackStatus=JSON.parse(await run(bin,["--config",config,"config","status"]));assert.ok(!rollbackStatus.pendingRollback);assert.ok(!rollbackStatus.pendingReplacement);
  const beforeCleanupDeliveries=legacyDeliveries;
  const cleanup=JSON.parse((await start(bin,["--config",config,"deploy","fly","--cleanup","--rollback-id",rolled.rollbackId,"--json"],consumer,{...environment,NODE_OPTIONS:`--import=${pathToFileURL(interceptor)}`},180_000).result).stdout);
  assert.equal(cleanup.deletedMachineId,"def456");assert.equal(cleanup.machineId,"abc123");assert.equal(cleanup.volume,"vol_fixture");assert.equal(cleanupDeletes,1);assert.ok(candidateDeleted);assert.equal(retained.state,"started");assert.deepEqual(retained.config,legacyRollbackBaseline);
  await waitFor(()=>legacyDeliveries>beforeCleanupDeliveries,"legacy delivery survives actual candidate cleanup");assert.equal(await run("docker",["volume","inspect",volume,"--format","{{.Name}}"]),volume);
  const cleanupState=(await request(`/api/deployments/${deploymentId}/config/state`)).state;assert.equal(cleanupState.activeInstanceId,null);assert.equal(cleanupState.applied,null);assert.ok(!JSON.parse(await run(bin,["--config",config,"config","status"])).pendingCleanup);
  const beforeFreshMetrics=Number((await request(`/api/deployments/${deploymentId}`)).deployment.metricsSnapshot?.updatedAt??0);
  await start(bin,["--config",config,"deploy","fly","--image",image,"--volume","vol_fixture","--region","ord","--wait-seconds","120"],consumer,{...environment,NODE_OPTIONS:`--import=${pathToFileURL(interceptor)}`},180_000).result;
  assert.equal(creates,2);assert.equal(machine.id,"fed987");assert.equal(machine.state,"started");assert.equal(retained.state,"stopped");assert.equal(registryReads,6);
  const restoredState=(await request(`/api/deployments/${deploymentId}/config/state`)).state;assert.equal(restoredState.stale,false);assert.equal(restoredState.applied.sequence,restoredState.desired.sequence);assert.equal(restoredState.applied.revision,restoredState.desired.revision);assert.notEqual(restoredState.activeInstanceId,state.activeInstanceId);await website.applied(deploymentId,restoredState.desired.sequence,restoredState.desired.revision);
  await waitFor(async()=>Number((await request(`/api/deployments/${deploymentId}`)).deployment.metricsSnapshot?.updatedAt)>beforeFreshMetrics,"fresh actual Vector metrics delivery");
  const finalCleanup=JSON.parse((await start(bin,["--config",config,"deploy","fly","--cleanup","--json"],consumer,{...environment,NODE_OPTIONS:`--import=${pathToFileURL(interceptor)}`},180_000).result).stdout);
  assert.equal(finalCleanup.deletedMachineId,"abc123");assert.equal(finalCleanup.machineId,"fed987");assert.equal(cleanupDeletes,2);assert.ok(legacyDeleted);assert.equal(machine.state,"started");assert.equal(await run("docker",["volume","inspect",volume,"--format","{{.Name}}"]),volume);
  assert.equal((await request(`/api/deployments/${deploymentId}/config/state`)).state.activeInstanceId,restoredState.activeInstanceId);await website.applied(deploymentId,restoredState.desired.sequence,restoredState.desired.revision);
  await website.revoke();await assert.rejects(run(bin,["whoami"]),/invalid_account_token \(HTTP 401\)/);website.assertNoErrors();
  console.log("Installed CLI: actual legacy delivery, replacement/update/restart, immutable legacy restoration, both cleanup modes, retained checkpoint and fresh accepted Vector/report delivery passed");
  injectFailure("after-runtime");
  await run("docker", ["stop", "--time", "35", container]);
  assert.equal(await run("docker", ["inspect", "--format", "{{.State.ExitCode}}", container]), "0");
  for(const legacy of [false,true])await managedRuntimeJourney({ service, website, request, run, connectionId, temporary, runId:legacy?`l${runId}`:runId,legacy,
    afterApplied: () => injectFailure(legacy?"after-legacy-runtime":"after-managed-runtime"),
    afterReapplied: () => injectFailure(legacy?"after-legacy-update":"after-managed-update"),
    afterRolledBack:()=>injectFailure("after-legacy-rollback"),
    afterCleaned:()=>injectFailure("after-legacy-cleanup"),
    afterRedeployed:()=>injectFailure("after-legacy-redeployment"),
    editAndPush: async managedId => {
      const login = start(bin, ["login", "--service", service.url, "--no-browser", "--name", "managed-update"]);
      const result = login.result; void result.catch(() => {});
      await waitFor(() => /Approval code: ([A-Z0-9-]+)/.test(login.stdout()), "managed update CLI login");
      await website!.approve(login.stdout().match(/Approval code: ([A-Z0-9-]+)/)![1]!); await result;
      const managedDirectory = join(consumer, `managed update ${managedId}`); mkdirSync(managedDirectory);
      const managedConfig = join(managedDirectory, "forwarder.yaml");
      await run(bin, ["pull", managedId, "--output", managedConfig]);
      const manifest = core.normalizeDeploymentManifest(yaml.parse(readFileSync(managedConfig, "utf8")));
      const monitor = manifest.monitors.find((entry: any) => ["Website alert","CLI-updated managed alert"].includes(entry.monitor.displayName)); assert.ok(monitor);
      const edits = join(consumer, "managed-edits.json");
      const displayName=legacy?"CLI-updated legacy managed alert":"CLI-updated managed alert",windowSeconds=legacy?60:45;
      writeFileSync(edits, JSON.stringify([{kind: "monitor.update", id: monitor.monitor.id, patch: {displayName, filterSteps: [{kind: "errors"}, {kind: "dedup", window_secs: windowSeconds, fields: ["message"]}]}}]));
      await run(bin, ["--config", managedConfig, "config", "edit", edits]);
      await run(bin, ["--config", managedConfig, "push"]);
      const saved = (await request(`/api/deployments/${managedId}/config/state`)).state;
      const changed = saved.desired.document.monitors.find((entry: any) => entry.monitor.id === monitor.monitor.id);
      assert.equal(changed.monitor.displayName, displayName);
      assert.deepEqual(changed.monitor.filterSteps, [{kind: "errors"}, {kind: "dedup", window_secs: windowSeconds, fields: ["message"]}]);
      await website!.cliUpdatedMonitor(displayName,windowSeconds);
    },
    image: { tag: imageTag, dockerId: dockerImageId, platformDigest, platformManifest, indexDigest, index: imageIndex } });
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
  if(legacyInstalled)await run("docker",["rm","--force",legacyContainer]).catch(()=>cleanupFailures.push("owned linked legacy container"));
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
