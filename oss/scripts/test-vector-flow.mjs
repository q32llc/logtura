import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const load = (name) => import(pathToFileURL(join(root, "packages", name, "dist/index.js")));
const { compileForwarderRuntime, exportDeploymentManifest, createSecretVersioner, hashConfigDocument,
  verifyLoadedForwarder, GENERATOR_VERSION, VECTOR_VERSION } = await load("core");
const { customVectorProvider } = await load("custom-vector");
const { webhookDriver } = await load("destination-webhook");
const temporary = mkdtempSync(join(tmpdir(), "logt-vector-flow-"));
const name = `logt-e2e-${crypto.randomUUID()}`;
const deliveries = [];
let attempts = 0;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
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
  const {bundle, artifact} = await compileForwarderRuntime({service: "https://runtime-fixture.test",
    deploymentId: "dep_fixture", document: exported.document,
    instance: {requestId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
      configurationVersion: 0, sequence: 1, revision: await hashConfigDocument(exported.document)},
    env: exported.secretValues, providers: input.providers, destinations: input.destinations});
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
  console.log("Real Vector flow passed: normalization, error filtering, routing, context, retry delivery, and issued runtime integrity without Logtura service");
} finally {
  docker(["rm", "--force", name], true);
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
