#!/usr/bin/env node
/**
 * One-off debug script: pull a connection's encrypted credentials,
 * decrypt them, and run the discovery API calls directly so we can
 * see what Cloudflare actually returns. Not meant for production use.
 *
 * Usage:
 *   node scripts/debug-discovery.mjs <connection_id>
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

function fromB64Url(value) {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

const connectionId = process.argv[2];
if (!connectionId) {
  console.error("usage: node scripts/debug-discovery.mjs <connection_id>");
  process.exit(1);
}

const env = parseEnv(readFileSync(resolve(projectRoot, ".env"), "utf8"));
const keyB64 =
  env.CREDENTIAL_ENCRYPTION_KEY ?? env.TEST_CREDENTIAL_ENCRYPTION_KEY;
if (!keyB64) {
  console.error("Missing CREDENTIAL_ENCRYPTION_KEY in .env");
  process.exit(1);
}

console.log(`Pulling connection ${connectionId} from remote D1…`);
const sql = `SELECT external_account_id, hex(credentials_encrypted) AS cred_hex FROM connections WHERE id='${connectionId.replace(/'/g, "''")}'`;
const r = spawnSync(
  "pnpm",
  ["wrangler", "d1", "execute", "logtura", "--remote", "--json", "--command", sql],
  { encoding: "utf8", cwd: projectRoot, env: process.env },
);
if (r.status !== 0) {
  console.error("wrangler d1 execute failed:", r.stderr);
  process.exit(1);
}
const lines = r.stdout.split("\n");
const start = lines.findIndex((l) => l.trim().startsWith("["));
const json = JSON.parse(lines.slice(start).join("\n"));
const row = json[0]?.results?.[0];
if (!row) {
  console.error("No connection found");
  process.exit(1);
}

const accountId = row.external_account_id;
const envelope = new Uint8Array(Buffer.from(row.cred_hex, "hex"));
const iv = envelope.subarray(0, 12);
const ct = envelope.subarray(12);
const rawKey = fromB64Url(keyB64);

console.log(
  `  account_id: ${accountId}`,
  `  envelope_bytes: ${envelope.length}`,
);

const key = await crypto.subtle.importKey(
  "raw",
  rawKey,
  { name: "AES-GCM" },
  false,
  ["decrypt"],
);
const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
const decoded = new TextDecoder().decode(pt);
console.log(`  decrypted_json: ${decoded.replace(/cfat_[A-Za-z0-9_-]+/g, (m) => `${m.slice(0, 9)}…(${m.length} chars)`)}`);

let creds;
try {
  creds = JSON.parse(decoded);
} catch (err) {
  console.error("Decrypted credentials are not valid JSON:", err);
  process.exit(1);
}
const apiToken = creds.apiToken;
if (!apiToken) {
  console.error("Decrypted credentials have no apiToken field");
  process.exit(1);
}
console.log(`  apiToken_prefix: ${apiToken.slice(0, 9)}…  length: ${apiToken.length}`);

async function cfCall(label, path) {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  console.log(`\n=== ${label} ===`);
  console.log(`  URL: ${url}`);
  console.log(`  HTTP: ${res.status} ${res.statusText}`);
  if (json) {
    console.log(`  success: ${json.success}`);
    if (json.errors?.length) {
      for (const e of json.errors) console.log(`  error: code=${e.code} message=${e.message}`);
    }
    if (json.success && Array.isArray(json.result)) {
      console.log(`  result_count: ${json.result.length}`);
    }
  } else {
    console.log(`  raw: ${text.slice(0, 300)}`);
  }
}

await cfCall("verify token", "/user/tokens/verify");
await cfCall("list accounts", "/accounts?per_page=50");
await cfCall("list workers", `/accounts/${accountId}/workers/scripts`);
await cfCall("list ai gateways", `/accounts/${accountId}/ai-gateway/gateways`);
