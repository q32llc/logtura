#!/usr/bin/env node
/**
 * Live smoke test for the Supabase OAuth → bearer_refresh → analytics
 * chain, run end-to-end through the REAL logtura-http-client binary
 * via the published Docker image.
 *
 * Verifies, in order:
 *   1) SaaS tail-token endpoint accepts a connection-scoped JWT and
 *      returns a fresh access_token + expires_in (bearer_refresh).
 *   2) The Supabase Management API accepts that access_token (listing
 *      projects + functions for the connection's project ref).
 *   3) The published logtura-http-client image, configured with
 *      bearer_refresh and a synthetic SELECT, actually emits one
 *      JSONL row on stdout within `BINARY_TIMEOUT_SECS`.
 *
 * Every upstream call is read-only. Run before declaring an OAuth
 * change shipped. Companion script smoke-supabase-pat.mjs covers the
 * PAT path.
 *
 * Usage:
 *   1. Open https://logtura.erik-f0c.workers.dev/app/connections/<id>
 *      in a logged-in browser and run in the console:
 *      fetch('/api/connections/<id>/debug/tail-token', {method:'POST'})
 *        .then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))
 *   2. Export the values:
 *      export SMOKE_TAIL_TOKEN="<from console>"
 *      export SMOKE_TAIL_TOKEN_URL="<from console>"
 *      export SMOKE_PROJECT_REF="<project ref the connection uses>"
 *      # Optional: bump if you upgraded the image
 *      export SMOKE_IMAGE="ghcr.io/logtura/logtura-http-client:v0.1.3"
 *      export BINARY_TIMEOUT_SECS=20
 *   3. pnpm smoke:supabase_oauth
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAIL_TOKEN = process.env.SMOKE_TAIL_TOKEN;
const TAIL_URL = process.env.SMOKE_TAIL_TOKEN_URL;
const PROJECT_REF = process.env.SMOKE_PROJECT_REF;
const IMAGE =
  process.env.SMOKE_IMAGE ?? "ghcr.io/logtura/logtura-http-client:v0.1.3";
const BINARY_TIMEOUT_SECS = Number(process.env.BINARY_TIMEOUT_SECS ?? 20);

if (!TAIL_TOKEN || !TAIL_URL || !PROJECT_REF) {
  console.error(
    "Set SMOKE_TAIL_TOKEN, SMOKE_TAIL_TOKEN_URL, SMOKE_PROJECT_REF. See script header.",
  );
  process.exit(1);
}

const step = (n, label) => console.log(`[${n}] ${label}`);
const ok = (label) => console.log(`    ✓ ${label}`);
const fail = (label) => {
  console.error(`    ✗ ${label}`);
  process.exit(2);
};

// --- 1. SaaS bearer_refresh ----------------------------------------
step(1, "POST tail-token endpoint");
const tokRes = await fetch(TAIL_URL, {
  method: "POST",
  headers: { authorization: `Bearer ${TAIL_TOKEN}` },
});
if (!tokRes.ok) {
  fail(`HTTP ${tokRes.status}: ${(await tokRes.text()).slice(0, 200)}`);
}
const tokBody = await tokRes.json();
if (typeof tokBody.access_token !== "string") fail("no access_token in response");
if (typeof tokBody.expires_in !== "number") fail("no expires_in in response");
ok(
  `access_token len=${tokBody.access_token.length} prefix=${tokBody.access_token.slice(0, 8)}…`,
);
ok(`expires_in=${tokBody.expires_in}s (${Math.round(tokBody.expires_in / 3600)}h)`);
const ACCESS = tokBody.access_token;

// --- 2. Supabase Management API ------------------------------------
step(2, "GET /v1/projects");
const projRes = await fetch("https://api.supabase.com/v1/projects", {
  headers: { authorization: `Bearer ${ACCESS}`, accept: "application/json" },
});
if (!projRes.ok) fail(`HTTP ${projRes.status}`);
const projects = await projRes.json();
const project = projects.find((p) => p.ref === PROJECT_REF);
if (!project) fail(`project ${PROJECT_REF} not visible to this token`);
ok(`project visible: ${project.name} (${project.ref})`);

step(2, `GET /v1/projects/${PROJECT_REF}/functions`);
const fnRes = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions`,
  { headers: { authorization: `Bearer ${ACCESS}`, accept: "application/json" } },
);
if (!fnRes.ok) fail(`HTTP ${fnRes.status}`);
const fns = await fnRes.json();
ok(`${fns.length} edge function(s) visible`);

// --- 3. Real binary via docker --------------------------------------
step(3, `docker run ${IMAGE} with bearer_refresh + synthetic SELECT`);
const sql =
  "SELECT 'smoke-row' AS id, 1 AS timestamp, 'logtura smoke ok' AS event_message";
const endpoint = `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all?sql=${encodeURIComponent(sql)}`;
const cfgDir = mkdtempSync(join(tmpdir(), "logtura-smoke-"));
const cfgPath = join(cfgDir, "source.toml");
const toml = [
  `endpoint = ${JSON.stringify(endpoint)}`,
  `scrape_interval_secs = 5`,
  ``,
  `[auth]`,
  `strategy = "bearer_refresh"`,
  `token_url = "\${LOGTURA_TAIL_TOKEN_URL}"`,
  ``,
  `[auth.token_headers]`,
  `authorization = "Bearer \${LOGTURA_TAIL_TOKEN}"`,
  ``,
  `[rows]`,
  `json_path = "$.result"`,
  ``,
].join("\n");
writeFileSync(cfgPath, toml);
ok(`wrote config to ${cfgPath}`);

// Hard cap with `timeout`; the binary loops forever otherwise.
const docker = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${cfgPath}:/etc/logtura/source.toml:ro`,
    "-e",
    `LOGTURA_TAIL_TOKEN_URL=${TAIL_URL}`,
    "-e",
    `LOGTURA_TAIL_TOKEN=${TAIL_TOKEN}`,
    IMAGE,
    "--config",
    "/etc/logtura/source.toml",
  ],
  {
    encoding: "utf8",
    timeout: BINARY_TIMEOUT_SECS * 1000,
    killSignal: "SIGKILL",
  },
);

const stdout = docker.stdout ?? "";
const stderrTail = (docker.stderr ?? "").split("\n").slice(-5).join("\n");

// Find a JSONL row matching the synthetic shape.
const matched = stdout
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .find((row) => row && row.id === "smoke-row");

if (!matched) {
  console.error("    binary stderr tail:");
  console.error(stderrTail);
  fail(
    `binary did not emit the synthetic row within ${BINARY_TIMEOUT_SECS}s`,
  );
}
ok(`binary emitted synthetic row: ${JSON.stringify(matched)}`);

console.log(
  "\nALL GREEN — SaaS bearer_refresh + Supabase API + logtura-http-client v-image works end-to-end.",
);
