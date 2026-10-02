import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync,execFile } from "node:child_process";

const root = process.cwd();
const load = (name) => import(pathToFileURL(join(root, "packages", name, "dist/index.js")));
const { compileForwarderRuntime, exportDeploymentManifest, createSecretVersioner, hashConfigDocument,
  verifyLoadedForwarder, DeploymentReportingClient, GENERATOR_VERSION, VECTOR_VERSION } = await load("core");
const { runForwarderReporting } = await import(pathToFileURL(join(root, "packages/cli/dist/main.js")));
const { customVectorProvider } = await load("custom-vector");
const { webhookDriver } = await load("destination-webhook");
const temporary = mkdtempSync(join(tmpdir(), "logt-vector-flow-"));
const name = `logt-e2e-${crypto.randomUUID()}`, supervisedName = `${name}-owned`;
const deliveries = [];
let attempts = 0, appliedCounter = 0, expectedInstance;
const appliedReports = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.url === "/api/applied/dep_fixture") {
    try {
      const report = JSON.parse(body);
      assert.equal(request.headers.authorization, "Bearer fixture-report-token");
      assert.equal(report.instanceId, expectedInstance.instanceId);
      assert.equal(report.sequence, expectedInstance.sequence);
      assert.equal(report.revision, expectedInstance.revision);
      appliedReports.push(report.reportSequence);
      const accepted = report.reportSequence > appliedCounter;
      if (accepted) appliedCounter = report.reportSequence;
      // The fixture accepted the first report but loses its acknowledgment.
      if (appliedReports.length === 1) { response.destroy(); return; }
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({accepted}));
    } catch { response.writeHead(400); response.end("invalid applied report"); }
    return;
  }
  attempts++;
  if (attempts === 1) { response.writeHead(503); response.end("retry fixture"); return; }
  try {
    const events = body.trim().startsWith("[") ? JSON.parse(body) : body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    deliveries.push(...events);
    response.writeHead(200); response.end("ok");
  } catch { response.writeHead(400); response.end("invalid JSON"); }
});
await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
const receiverPort = server.address().port;
function docker(args, acceptFailure = false) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  if (!acceptFailure && result.status !== 0) throw new Error(`Docker failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function waitFor(check, label, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out\n${docker(["logs", name], true)}`);
}
try {
  const input = {
    providers: [customVectorProvider], destinations: [webhookDriver],
    connections: [{ connection: { id: "con_fixture", provider: "custom-vector", displayName: "Fixture", externalAccountId: null }, selectedSources: [{
      id: "src_fixture", externalId: "normalize", displayName: "Fixture ingress", sourceKind: "custom_vector", metadata: { customVector: {
        feed: "normalize", fragment: {
          sources: { ingress: { type: "http_server", address: "0.0.0.0:9000", decoding: { codec: "json" } } },
          transforms: { normalize: { type: "remap", inputs: ["ingress"], source: '.message = string(.message) ?? "unknown"\n.level = string(.level) ?? "info"\n.error = .level == "error"' } },
        },
      } },
    }] }],
    monitors: [{ monitor: { id: "mon_fixture", connectionId: null, displayName: "Errors", filterSteps: [{ kind: "errors" }], enabled: true }, sinks: [{
      sink: { id: "sink_fixture", filterSteps: [] }, destination: { id: "dest_fixture", kind: "webhook", displayName: "Fixture webhook" },
      destinationConfig: { url: `http://host.docker.internal:${receiverPort}/events` },
    }] }],
  };
  const exported = await exportDeploymentManifest(input, await createSecretVersioner(crypto.randomUUID()));
  const {bundle, artifact} = await compileForwarderRuntime({service: `http://127.0.0.1:${receiverPort}`,
    deploymentId: "dep_fixture", document: exported.document,
    instance: {requestId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
      configurationVersion: 0, sequence: 1, revision: await hashConfigDocument(exported.document)},
    env: exported.secretValues, providers: input.providers, destinations: input.destinations});
  expectedInstance = artifact.instance;
  assert.ok(!bundle.vectorYaml.includes("/api/heartbeat/"));
  assert.ok(!bundle.vectorYaml.includes("/api/metrics/"));
  writeFileSync(join(temporary, "vector.yaml"), bundle.vectorYaml);
  const env = bundle.envVars.flatMap((variable) => variable.value === null ? [] : ["--env", `${variable.name}=${variable.value}`]);
  docker(["run", "--detach", "--rm", "--name", name, "--add-host=host.docker.internal:host-gateway", "--publish", "127.0.0.1::9000", "--publish", "127.0.0.1::8686", "--volume", `${temporary}:/etc/vector:ro`, ...env, `timberio/vector:${VECTOR_VERSION}-debian`, "--config", "/etc/vector/vector.yaml"]);
  const mapping = docker(["port", name, "9000/tcp"]);
  const ingress = `http://${mapping}`;
  await waitFor(async () => { try { await fetch(ingress, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; } }, "Vector readiness");
  const api = `http://${docker(["port", name, "8686/tcp"])}`;
  await waitFor(async () => { try { return (await fetch(`${api}/health`, {signal: AbortSignal.timeout(500)})).status === 200; } catch { return false; } }, "Vector API readiness");
  // Read back from this container's read-only config mount and launched environment.
  // Startup has no config-watch option; observations belong to this owned runtime.
  const loadedYaml = spawnSync("docker", ["exec", name, "cat", "/etc/vector/vector.yaml"], {encoding: "utf8", timeout: 5000});
  assert.equal(loadedYaml.status, 0);
  const runtimeVersion = docker(["exec", name, "vector", "--version"]).match(/^vector (\d+\.\d+\.\d+)/)?.[1];
  assert.equal(runtimeVersion, VECTOR_VERSION);
  const container = JSON.parse(docker(["inspect", name]))[0];
  assert.equal(container.State.Running, true);
  assert.ok(container.Mounts.some(mount => mount.Destination === "/etc/vector" && mount.RW === false));
  const environment = Object.fromEntries(container.Config.Env.map(value => {const index = value.indexOf("=");return [value.slice(0, index), value.slice(index + 1)];}));
  const observed = {files: {"vector.yaml": loadedYaml.stdout}, environment,
    generatorVersion: GENERATOR_VERSION, vectorVersion: runtimeVersion, ready: true};
  await verifyLoadedForwarder(artifact, observed);
  await assert.rejects(verifyLoadedForwarder(artifact, {...observed, files: {"vector.yaml": loadedYaml.stdout + "\n# changed\n"}}));
  const boundName = Object.keys(artifact.environment)[0];
  assert.ok(boundName);
  await assert.rejects(verifyLoadedForwarder(artifact, {...observed, environment: {...environment, [boundName]: "changed"}}));
  const reporting = new DeploymentReportingClient({url: artifact.service, token: "fixture-report-token", fetch});
  const stopReporting = new AbortController(), results = [], checkpoint = join(temporary, "report-checkpoint.json");
  await runForwarderReporting({checkpoint, artifact, signal: stopReporting.signal,
    intervalMs: 10, retryMs: 20, maxRetryMs: 100,
    observe: async () => {
      const current = JSON.parse(docker(["inspect", name]))[0];
      const file = spawnSync("docker", ["exec", name, "cat", "/etc/vector/vector.yaml"], {encoding: "utf8", timeout: 5000});
      assert.equal(file.status, 0);
      return {...observed, files: {"vector.yaml": file.stdout},
        environment: Object.fromEntries(current.Config.Env.map(value => {const index = value.indexOf("=");return [value.slice(0,index),value.slice(index+1)];})),
        ready: current.State.Running && (await fetch(`${api}/health`, {signal: AbortSignal.timeout(1000)})).status === 200};
    },
    report: value => reporting.reportApplied(artifact.deploymentId, value),
    onResult: result => {results.push(result);if(result.accepted)stopReporting.abort();},
  });
  assert.deepEqual(appliedReports, [1,1,2]);
  assert.deepEqual(results, [{reportSequence:1,accepted:false},{reportSequence:2,accepted:true}]);
  assert.equal(appliedCounter, 2);
  assert.equal(statSync(checkpoint).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(checkpoint,"utf8")).pending, null);
  assert.equal(JSON.parse(readFileSync(checkpoint,"utf8")).lastReportSequence, 2);
  const response = await fetch(ingress, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([
    { message: "keep-error-one", level: "error" }, { message: "drop-info", level: "info" }, { message: "keep-error-two", level: "error" },
  ]), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  await waitFor(() => deliveries.filter((event) => event.message?.startsWith("keep-error-")).length >= 2, "Webhook retry delivery");
  assert.ok(attempts >= 2, "sink must retry after a 503");
  assert.ok(!deliveries.some((event) => event.message === "drop-info"), "info event must not pass the error monitor");
  for (const event of deliveries) {
    assert.equal(event.logtura_connection_id, "con_fixture");
    assert.equal(event.logtura_provider, "custom-vector");
    assert.equal(event.error, true);
  }
  // Run the actual installed supervisor as PID 1 with its own Vector child.
  // Node is mounted from the Linux CI/runtime installation; runtime-bin bundles
  // its package dependencies so this fixture needs no network package install.
  const portProbe=createServer();await new Promise(resolve=>portProbe.listen(0,"127.0.0.1",resolve));
  const ownedPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  const supervisedInput={...input,connections:structuredClone(input.connections)};
  supervisedInput.connections[0].selectedSources[0].metadata.customVector.fragment.sources.ingress.address=`0.0.0.0:${ownedPort}`;
  const supervisedExport=await exportDeploymentManifest(supervisedInput,await createSecretVersioner(crypto.randomUUID()));
  const supervised = await compileForwarderRuntime({service: artifact.service,
    deploymentId: artifact.deploymentId, document: supervisedExport.document,
    instance: {...artifact.instance,revision:await hashConfigDocument(supervisedExport.document),instanceId:crypto.randomUUID(),requestId:crypto.randomUUID()},
    env: supervisedExport.secretValues, providers: input.providers, destinations: input.destinations});
  writeFileSync(join(temporary,"vector.yaml"),supervised.bundle.vectorYaml);
  expectedInstance = supervised.artifact.instance;appliedCounter = 0;appliedReports.length = 0;
  writeFileSync(join(temporary,"logtura-runtime.json"),JSON.stringify(supervised.artifact),{mode:0o600});
  // Keep the optional SDK's HTTP fixture on loopback inside this container.
  // Docker's daemon host can differ from the caller's host (e.g. Docker Desktop).
  writeFileSync(join(temporary,"proxy-run.mjs"),`import {createServer,request} from 'node:http';
    const proxy=createServer((req,res)=>{const upstream=request('http://host.docker.internal:${receiverPort}'+req.url,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>res.destroy());req.pipe(upstream);});
    await new Promise(resolve=>proxy.listen(${receiverPort},'127.0.0.1',resolve));
    await import('/opt/logtura/runtime-bin.mjs');
    proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));`,{mode:0o600});
  docker(["run","--detach","--name",supervisedName,"--add-host=host.docker.internal:host-gateway",
    "--entrypoint","/usr/local/bin/node","--publish",`127.0.0.1::${ownedPort}`,
    "--volume",`${process.execPath}:/usr/local/bin/node:ro`,
    "--volume",`${join(root,"packages/cli/dist/runtime-bin.js")}:/opt/logtura/runtime-bin.mjs:ro`,
    "--volume",`${temporary}:/etc/vector:ro`,"--tmpfs","/var/lib/logtura:rw,mode=0700",
    ...env,"--env","LOGTURA_HEARTBEAT_TOKEN=fixture-report-token","--env","VECTOR_CONFIG_DIR=/unrelated",
    `timberio/vector:${VECTOR_VERSION}-debian`,"/etc/vector/proxy-run.mjs",
    "--artifact","/etc/vector/logtura-runtime.json","--interval-ms","20","--retry-ms","20"]);
  const supervisedIngress = `http://${docker(["port",supervisedName,`${ownedPort}/tcp`])}`;
  const supervisedDeadline = Date.now()+30_000;
  while(appliedCounter<2 && Date.now()<supervisedDeadline){
    const state = JSON.parse(docker(["inspect",supervisedName]))[0].State;
    if(!state.Running)throw new Error(`Owned supervisor stopped: ${docker(["logs",supervisedName],true)}`);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(appliedCounter>=2,`Owned supervisor reporting timed out: ${docker(["logs",supervisedName],true)}`);
  assert.deepEqual(appliedReports.slice(0,3),[1,1,2]);
  const supervisedEvent = await fetch(supervisedIngress,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({message:"keep-error-owned-process",level:"error"}),signal:AbortSignal.timeout(5000)});
  assert.equal(supervisedEvent.status,200);
  await waitFor(()=>deliveries.some(event=>event.message==="keep-error-owned-process"),"Owned Vector delivery");
  // Keep the fixture HTTP server responsive while the runtime drains its last
  // report; a synchronous docker stop would block that server and force a kill.
  await new Promise((resolve,reject)=>execFile("docker",["stop","--time","35",supervisedName],{timeout:40_000},error=>error?reject(error):resolve()));
  const finalLogs=spawnSync("docker",["logs",supervisedName],{encoding:"utf8",timeout:5000});
  assert.equal(JSON.parse(docker(["inspect",supervisedName]))[0].State.ExitCode,0,finalLogs.stdout+finalLogs.stderr);
  const supervisedLogs=docker(["logs",supervisedName],true);
  assert.ok(supervisedLogs.includes('"event":"applied_report"'));
  assert.ok(!supervisedLogs.includes(supervised.artifact.privateKey));
  console.log("Real Vector flow passed: normalization, error filtering, routing, context, retry delivery, issued runtime integrity, and durable HTTP report recovery, and owned PID-1 process supervision without Logtura service");
} finally {
  docker(["rm", "--force", supervisedName], true);
  docker(["rm", "--force", name], true);
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
