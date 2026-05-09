#!/usr/bin/env node
/**
 * Trigger a discovery job on the deployed worker for an existing
 * connection, then poll the job to terminal status. Mints a session
 * cookie locally using SESSION_SECRET from .env (same key the worker
 * uses to verify cookies), so it works end-to-end without needing a
 * browser.
 *
 * Usage:
 *   node scripts/trigger-discovery.mjs <connection_id> [--user <user_id>] [--app <url>]
 *
 * If --user is omitted we look it up from the connection row.
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function toB64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function signCookie(payload, secret) {
  const enc = new TextEncoder();
  const encoded = toB64Url(enc.encode(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(encoded));
  return `${encoded}.${toB64Url(new Uint8Array(sig))}`;
}

const args = process.argv.slice(2);
let connectionId = null;
let userId = null;
let appUrl = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--user") userId = args[++i];
  else if (a === "--app") appUrl = args[++i];
  else if (!connectionId) connectionId = a;
}
if (!connectionId) {
  console.error(
    "usage: node scripts/trigger-discovery.mjs <connection_id> [--user <user_id>] [--app <url>]",
  );
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
  const sql = `SELECT user_id FROM connections WHERE id='${connectionId.replace(/'/g, "''")}'`;
  const r = spawnSync(
    "pnpm",
    ["wrangler", "d1", "execute", "logtura", "--remote", "--json", "--command", sql],
    { encoding: "utf8", cwd: projectRoot, env: process.env },
  );
  if (r.status !== 0) {
    console.error("d1 lookup failed:", r.stderr);
    process.exit(1);
  }
  const lines = r.stdout.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("["));
  const json = JSON.parse(lines.slice(start).join("\n"));
  userId = json[0]?.results?.[0]?.user_id;
  if (!userId) {
    console.error("connection not found");
    process.exit(1);
  }
}

console.log(`user_id: ${userId}`);
const cookie = await signCookie(userId, sessionSecret);

const triggerRes = await fetch(`${appUrl}/api/connections/${connectionId}/discover`, {
  method: "POST",
  headers: {
    cookie: `logtura_session=${cookie}`,
    "content-type": "application/json",
  },
});
const trigger = await triggerRes.json();
console.log(`POST /api/connections/${connectionId}/discover → ${triggerRes.status}`);
console.log(JSON.stringify(trigger, null, 2));

const jobId = trigger.job?.id;
if (!jobId) {
  console.error("no job id in response");
  process.exit(1);
}

console.log(`\nPolling /api/jobs/${jobId}…`);
let last = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const res = await fetch(`${appUrl}/api/jobs/${jobId}`, {
    headers: { cookie: `logtura_session=${cookie}` },
  });
  const data = await res.json();
  const job = data.job;
  if (!job) {
    console.log(`  ${i + 1}: no job in response`);
    continue;
  }
  if (job.status !== last) {
    console.log(
      `  ${new Date().toISOString()}  status=${job.status}  attempt=${job.attemptCount}/${job.maxAttempts}  error=${job.error ?? ""}`,
    );
    last = job.status;
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
console.error("Timed out waiting for terminal status");
process.exit(3);
