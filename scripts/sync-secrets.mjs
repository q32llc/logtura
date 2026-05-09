#!/usr/bin/env node
/**
 * Sync the deployed Worker's secrets from the local .env via
 * `wrangler secret bulk`. Run with `pnpm secrets:sync`.
 *
 * Edit ALLOWED below to control which secrets get pushed. Anything not
 * in the allowlist is silently ignored, so .env can stay shared across
 * projects without leaking unrelated creds.
 *
 * Each allowed key looks first for the runtime name (e.g. GITHUB_CLIENT_ID)
 * and falls back to TEST_-prefixed (e.g. TEST_GITHUB_CLIENT_ID), matching
 * relin's convention so a shared .env keeps working.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envPath = resolve(projectRoot, ".env");

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

let envText;
try {
  envText = readFileSync(envPath, "utf8");
} catch (err) {
  console.error(`Failed to read ${envPath}: ${err.message}`);
  process.exit(1);
}

const env = parseEnv(envText);
const payload = {};
const missing = [];
for (const key of ALLOWED) {
  const value = env[key] ?? env[`TEST_${key}`];
  if (!value) {
    missing.push(key);
    continue;
  }
  payload[key] = value;
}

if (Object.keys(payload).length === 0) {
  console.error("Nothing to sync; .env had none of the allowed keys.");
  process.exit(1);
}

console.log(`Syncing ${Object.keys(payload).length} secret(s):`);
for (const k of Object.keys(payload)) console.log(`  - ${k}`);
if (missing.length > 0) {
  console.log(`Missing (skipped): ${missing.join(", ")}`);
}

const result = spawnSync("pnpm", ["wrangler", "secret", "bulk"], {
  input: JSON.stringify(payload),
  encoding: "utf8",
  stdio: ["pipe", "inherit", "inherit"],
  cwd: projectRoot,
  env: process.env,
});
process.exit(result.status ?? 1);
