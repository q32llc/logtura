import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const load = (name) => import(pathToFileURL(join(root, "packages", name, "dist/index.js")));
const { generateBundle } = await load("core");
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
  const bundle = generateBundle({
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
  });
  assert.ok(!bundle.vectorYaml.includes("/api/heartbeat/"));
  assert.ok(!bundle.vectorYaml.includes("/api/metrics/"));
  writeFileSync(join(temporary, "vector.yaml"), bundle.vectorYaml);
  const env = bundle.envVars.flatMap((variable) => variable.value === null ? [] : ["--env", `${variable.name}=${variable.value}`]);
  docker(["run", "--detach", "--rm", "--name", name, "--add-host=host.docker.internal:host-gateway", "--publish", "127.0.0.1::9000", "--volume", `${temporary}:/etc/vector:ro`, ...env, "timberio/vector:0.55.0-debian", "--config", "/etc/vector/vector.yaml"]);
  const mapping = docker(["port", name, "9000/tcp"]);
  const ingress = `http://${mapping}`;
  await waitFor(async () => { try { await fetch(ingress, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; } }, "Vector readiness");
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
  console.log("Real Vector flow passed: normalization, error filtering, routing, context, and retry delivery without Logtura service");
} finally {
  docker(["rm", "--force", name], true);
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
