import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { vercelLogsDriver } from "../packages/driver-vercel-logs/src/index.ts";

const token = process.env.VERCEL_API_TOKEN ?? process.env.VERCEL_API_KEY;
const teamId = process.env.VERCEL_TEAM_ID ?? "";
const projectId = process.env.VERCEL_TEST_PROJECT_ID;
const probeUrl = process.env.VERCEL_TEST_PROBE_URL;
const timeoutMs = Number(process.env.VERCEL_TEST_TIMEOUT_MS ?? 45_000);

assert.ok(token, "VERCEL_API_TOKEN or VERCEL_API_KEY is required");
assert.ok(projectId, "VERCEL_TEST_PROJECT_ID is required");
assert.match(projectId, /^[A-Za-z0-9_-]+$/, "VERCEL_TEST_PROJECT_ID is invalid");
assert.ok(probeUrl, "VERCEL_TEST_PROBE_URL is required");
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 5_000, "VERCEL_TEST_TIMEOUT_MS is invalid");

const apiHeaders = { authorization: `Bearer ${token}`, accept: "application/json" };
const deploymentQuery = new URLSearchParams({ projectId, target: "production", state: "READY", limit: "1" });
if (teamId) deploymentQuery.set("teamId", teamId);
const deploymentResponse = await fetch(`https://api.vercel.com/v6/deployments?${deploymentQuery}`, {
  headers: apiHeaders,
  signal: AbortSignal.timeout(30_000),
});
assert.equal(deploymentResponse.status, 200, `Vercel deployment lookup returned HTTP ${deploymentResponse.status}`);
const deploymentData = await deploymentResponse.json();
const deploymentId = deploymentData.deployments?.[0]?.uid;
assert.match(deploymentId ?? "", /^[A-Za-z0-9_-]+$/, "No READY production deployment found");

const pipeline = vercelLogsDriver.generatePipeline({
  connection: { id: "live", externalAccountId: teamId || null, displayName: "Vercel live test" },
  selection: {
    kind: "list",
    sources: [{
      id: projectId,
      externalId: projectId,
      sourceKind: "vercel_project",
      displayName: "Vercel live fixture",
      metadata: null,
    }],
  },
});
const asset = pipeline.runtimeAssets?.find((candidate) => candidate.path.endsWith(".mjs"));
assert.ok(asset, "Generated Vercel helper asset is missing");
const temporary = mkdtempSync(join(tmpdir(), "logtura-vercel-live-"));
writeFileSync(join(temporary, "logtura-vercel-tail.mjs"), asset.content, { mode: 0o600 });
const projectArg = JSON.stringify([{ id: projectId, name: "Vercel live fixture" }]);
const child = spawn(process.execPath, [join(temporary, "logtura-vercel-tail.mjs"), teamId, projectArg], {
  env: { ...process.env, VERCEL_API_TOKEN: token },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderr = "";
let observedEvent;
let helperError;
let childExitCode;
child.on("exit", (code) => { childExitCode = code; });
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.source === "logtura_vercel_helper") helperError ??= event;
    if (event.projectId === projectId && event.source !== "logtura_vercel_helper") observedEvent ??= event;
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + timeoutMs;
let triggerCount = 0;
try {
  await delay(1_500);
  while (!observedEvent && !helperError && childExitCode === undefined && Date.now() < deadline) {
    const url = new URL(probeUrl);
    url.searchParams.set("logtura_probe", crypto.randomUUID());
    const probeResponse = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    await probeResponse.body?.cancel();
    assert.ok(probeResponse.status >= 200 && probeResponse.status < 600, `Vercel probe returned HTTP ${probeResponse.status}`);
    triggerCount += 1;
    await delay(2_000);
  }

  assert.equal(helperError, undefined, `Generated helper emitted an error: ${helperError?.message ?? "unknown error"}`);
  assert.equal(childExitCode, undefined, `Generated helper container exited early (${childExitCode}): ${stderr.trim().slice(-1_000)}`);
  assert.ok(observedEvent, `No Vercel runtime event arrived within ${timeoutMs}ms`);
  console.log(JSON.stringify({
    ok: true,
    projectId,
    deploymentId,
    probeStatus: "reached",
    triggerCount,
    event: {
      level: observedEvent.level ?? null,
      requestPath: observedEvent.requestPath ?? null,
      responseStatusCode: observedEvent.responseStatusCode ?? null,
      rowIdPresent: Boolean(observedEvent.rowId),
    },
  }, null, 2));
} finally {
  child.kill("SIGTERM");
  rmSync(temporary, { recursive: true, force: true });
}

if (stderr.trim() && !observedEvent) console.error(stderr.trim().slice(-2_000));
