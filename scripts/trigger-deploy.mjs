#!/usr/bin/env node
/**
 * Trigger a fly_deploy job (the chained-pipeline parent) on the
 * remote worker without using a browser. Mints a session cookie
 * locally with SESSION_SECRET, POSTs to the same endpoint the UI
 * uses, then polls the parent until terminal.
 *
 * Usage:
 *   node scripts/trigger-deploy.mjs <deployment_id> <deploy_target_id> [--user <user_id>] [--app <url>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function toB64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function signCookie(payload, secret) {
  const enc = new TextEncoder();
  const encoded = toB64Url(enc.encode(payload));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(encoded));
  return `${encoded}.${toB64Url(new Uint8Array(sig))}`;
}

const args = process.argv.slice(2);
let deploymentId = null;
let deployTargetId = null;
let userId = null;
let appUrl = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--user") userId = args[++i];
  else if (a === "--app") appUrl = args[++i];
  else if (!deploymentId) deploymentId = a;
  else if (!deployTargetId) deployTargetId = a;
}
if (!deploymentId || !deployTargetId) {
  console.error("usage: node scripts/trigger-deploy.mjs <deployment_id> <deploy_target_id> [--user <user_id>] [--app <url>]");
  process.exit(1);
}

const env = parseEnv(readFileSync(resolve(projectRoot, ".env"), "utf8"));
const sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  console.error("Missing SESSION_SECRET in .env");
  process.exit(1);
}
appUrl = appUrl ?? "https://logtura.erik-f0c.workers.dev";

if (!userId) {
  const sql = `SELECT user_id FROM deployments WHERE id='${deploymentId.replace(/'/g, "''")}'`;
  const r = spawnSync("pnpm", ["wrangler", "d1", "execute", "logtura", "--remote", "--json", "--command", sql], { encoding: "utf8", cwd: projectRoot, env: process.env });
  if (r.status !== 0) { console.error("d1 lookup failed:", r.stderr); process.exit(1); }
  const lines = r.stdout.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("["));
  const json = JSON.parse(lines.slice(start).join("\n"));
  userId = json[0]?.results?.[0]?.user_id;
  if (!userId) { console.error("deployment not found"); process.exit(1); }
}
console.log(`user_id: ${userId}`);

const cookie = await signCookie(userId, sessionSecret);
const headers = { cookie: `logtura_session=${cookie}`, "content-type": "application/json" };

const triggerRes = await fetch(`${appUrl}/api/deployments/${deploymentId}/deploy`, {
  method: "POST",
  headers,
  body: JSON.stringify({ deployTargetId }),
});
const trigger = await triggerRes.json();
console.log(`POST /api/deployments/${deploymentId}/deploy → ${triggerRes.status}`);
console.log(JSON.stringify(trigger, null, 2));

const jobId = trigger.job?.id;
if (!jobId) { console.error("no job id"); process.exit(1); }

console.log(`\nPolling /api/jobs/${jobId} (parent + kid rollup)…`);
let lastStatus = null;
let lastProgress = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const res = await fetch(`${appUrl}/api/jobs/${jobId}`, { headers });
  const data = await res.json();
  const job = data.job;
  const kids = data.kids ?? [];
  if (!job) continue;
  const progLabel = job.progress?.label ?? null;
  if (job.status !== lastStatus || progLabel !== lastProgress) {
    const kidsLine = kids.length ? `  kids: ${kids.map(k => `${k.kind.replace("fly_deploy.", "")}=${k.status}`).join(" ")}` : "";
    console.log(`  ${new Date().toISOString()}  status=${job.status}  progress=${progLabel ?? "-"}${kidsLine}`);
    if (job.error && job.error !== job.error) console.log(`    error: ${job.error}`);
    lastStatus = job.status;
    lastProgress = progLabel;
  }
  if (job.status === "succeeded") {
    console.log(`\nResult: ${JSON.stringify(job.result)}`);
    process.exit(0);
  }
  if (job.status === "failed") {
    console.error(`\nFailed: ${job.error}`);
    process.exit(2);
  }
}
console.error("Timed out");
process.exit(3);
