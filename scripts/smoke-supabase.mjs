#!/usr/bin/env node
/**
 * Live smoke test for the Supabase OAuth → bearer_refresh → analytics
 * chain. Verifies, in order:
 *   1) the SaaS tail-token endpoint accepts a connection-scoped JWT
 *      and returns a fresh access_token + expires_in
 *   2) the access_token works against the real Supabase Management
 *      API (lists projects + functions for the connection's project)
 *   3) (optional) end-to-end through logtura-http-client, if the
 *      binary is on PATH
 *
 * The script never touches D1 or writes anything anywhere. Every
 * upstream call is read-only. Run this before declaring an OAuth-
 * path change shipped.
 *
 * Usage:
 *   1. Open https://logtura.erik-f0c.workers.dev/app/connections/<id>
 *      in a logged-in browser and run in the console:
 *      fetch('/api/connections/<id>/debug/tail-token', {method:'POST'})
 *        .then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))
 *   2. Export the values:
 *      export SMOKE_TAIL_TOKEN="<from console>"
 *      export SMOKE_TAIL_TOKEN_URL="<from console>"
 *      export SMOKE_PROJECT_REF="<the connection's project ref>"
 *   3. node scripts/smoke-supabase.mjs
 */
const TAIL_TOKEN = process.env.SMOKE_TAIL_TOKEN;
const TAIL_URL = process.env.SMOKE_TAIL_TOKEN_URL;
const PROJECT_REF = process.env.SMOKE_PROJECT_REF;

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
step(2, "GET /v1/projects (Management API)");
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

// --- 3. Analytics shape sanity -------------------------------------
step(3, "GET /v1/projects/<ref>/analytics/endpoints/logs.all (synthetic row)");
const sql =
  "SELECT 'smoke-row' AS id, 1 AS timestamp, 'logtura smoke ok' AS event_message";
const anaRes = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all?sql=${encodeURIComponent(sql)}`,
  { headers: { authorization: `Bearer ${ACCESS}`, accept: "application/json" } },
);
if (!anaRes.ok) fail(`HTTP ${anaRes.status}: ${(await anaRes.text()).slice(0, 200)}`);
const ana = await anaRes.json();
if (!Array.isArray(ana.result)) {
  fail(
    `analytics response missing top-level result[]; got: ${JSON.stringify(ana).slice(0, 200)}`,
  );
}
if (ana.result.length === 0) fail("expected 1 synthetic row, got 0");
if (ana.result[0].event_message !== "logtura smoke ok")
  fail(`synthetic row didn't round-trip: ${JSON.stringify(ana.result[0])}`);
ok(`analytics envelope is single-nest { result: [...] }`);
ok(`synthetic row round-tripped`);

console.log("\nALL GREEN — bearer_refresh + Supabase analytics chain is live.");
