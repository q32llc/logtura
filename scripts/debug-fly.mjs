#!/usr/bin/env node
/**
 * Pull a deploy_target's encrypted Fly token, decrypt it, and probe
 * Fly's REST + GraphQL endpoints directly. Faster than "deploy →
 * click → tail" for figuring out what shape of call works.
 *
 * Usage:
 *   node scripts/debug-fly.mjs <deploy_target_id>
 *   node scripts/debug-fly.mjs <deploy_target_id> --probe createApp
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

const args = process.argv.slice(2);
const deployTargetId = args[0];
const probeIdx = args.indexOf("--probe");
const probeName = probeIdx >= 0 ? args[probeIdx + 1] : null;

if (!deployTargetId) {
  console.error("usage: node scripts/debug-fly.mjs <deploy_target_id> [--probe <name>]");
  console.error("probes: graphql_orgs, graphql_viewer, machines_apps, create_app, get_user");
  process.exit(1);
}

const env = parseEnv(readFileSync(resolve(projectRoot, ".env"), "utf8"));
const keyB64 = env.CREDENTIAL_ENCRYPTION_KEY ?? env.TEST_CREDENTIAL_ENCRYPTION_KEY;
if (!keyB64) {
  console.error("Missing CREDENTIAL_ENCRYPTION_KEY in .env");
  process.exit(1);
}

console.log(`Pulling deploy_target ${deployTargetId} from remote D1…`);
const sql = `SELECT kind, external_account_id, hex(credentials_encrypted) AS cred_hex FROM deploy_targets WHERE id='${deployTargetId.replace(/'/g, "''")}'`;
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
  console.error("No deploy_target found");
  process.exit(1);
}

const envelope = new Uint8Array(Buffer.from(row.cred_hex, "hex"));
const iv = envelope.subarray(0, 12);
const ct = envelope.subarray(12);
const rawKey = fromB64Url(keyB64);

console.log(`  kind: ${row.kind}  account_id: ${row.external_account_id}  envelope_bytes: ${envelope.length}`);

const key = await crypto.subtle.importKey(
  "raw",
  rawKey,
  { name: "AES-GCM" },
  false,
  ["decrypt"],
);
const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
const decoded = new TextDecoder().decode(pt);
const creds = JSON.parse(decoded);
const token = creds.apiToken;
if (!token) {
  console.error("Decrypted credentials have no apiToken field");
  process.exit(1);
}

// Fly's auth header rules: macaroons (fm1r_, fm2_) → "FlyV1 ", else "Bearer ".
function flyAuthHeader(t) {
  for (const part of t.split(",")) {
    const prefix = part.split("_")[0];
    if (prefix === "fm1r" || prefix === "fm2") return `FlyV1 ${t}`;
  }
  return `Bearer ${t}`;
}

const authHeader = flyAuthHeader(token);
console.log(`  token_prefix: ${token.slice(0, 12)}…  length: ${token.length}`);
console.log(`  auth_scheme: ${authHeader.split(" ")[0]}`);
console.log("");

async function call(label, method, url, body) {
  const headers = { authorization: authHeader, accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  console.log(`=== ${label} ===`);
  console.log(`  ${method} ${url}`);
  console.log(`  HTTP: ${res.status} ${res.statusText}`);
  console.log(`  body: ${text.slice(0, 600)}`);
  console.log("");
  return { status: res.status, text };
}

async function decodeAndProbe() {
  const { decodeMacaroon, parseFlyTokens, dischargeBundle } =
    await import("../src/deploy-targets/fly-macaroon.ts");
  const raws = parseFlyTokens(token);
  console.log(`=== local: parsed ${raws.length} macaroon(s) from token ===`);
  for (const raw of raws) {
    const m = decodeMacaroon(raw);
    console.log(`  location: ${m.location}`);
    console.log(`  third_party_caveats: ${m.thirdPartyCaveats.length}`);
    for (const tp of m.thirdPartyCaveats) {
      console.log(`    - tp_location: ${tp.location}  ticket_bytes: ${tp.ticket.length}`);
    }
  }
  console.log("\n=== local: round-trip parse/encode ===");
  const { encodeFlyTokens: enc2 } = await import("../src/deploy-targets/fly-macaroon.ts");
  const rt = enc2(raws);
  console.log(`  original token (no scheme) length: ${token.length}`);
  console.log(`  round-tripped length:               ${rt.length}`);
  console.log(`  round-tripped equal to original:    ${rt === token}`);
  console.log(`  comma count in original: ${(token.match(/,/g) || []).length}`);
  console.log(`  prefix occurrences fm2_:  ${(token.match(/fm2_/g) || []).length}, fm1r_: ${(token.match(/fm1r_/g) || []).length}, fo1_: ${(token.match(/fo1_/g) || []).length}`);
  console.log(`  original tail: …${token.slice(-60)}`);
  console.log(`  rt tail:       …${rt.slice(-60)}`);

  console.log("\n=== local: force-fresh discharge (bypass cached) ===");
  const { fetchOneDischargeProbe } = await (async () => {
    // Manually walk: parse, find 3p caveat in raws[0], fetch one fresh
    // discharge, build a bundle of [raws[0], fresh_discharge, fo1_oauth]
    // dropping raws[1] (the existing discharge).
    return { fetchOneDischargeProbe: async () => {
      const m = decodeMacaroon(raws[0]);
      const cav = m.thirdPartyCaveats[0];
      const initUrl = cav.location + "/.well-known/macfly/3p";
      const initRes = await fetch(initUrl, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ticket: Buffer.from(cav.ticket).toString("base64") }),
      });
      const initBody = await initRes.json();
      console.log(`  init status: ${initRes.status}  body: ${JSON.stringify(initBody).slice(0, 200)}`);
      let dischargeStr = initBody.discharge;
      if (!dischargeStr && initBody.poll_url) {
        // poll
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500 * (i + 1)));
          const r = await fetch(initBody.poll_url, { headers: { authorization: authHeader, accept: "application/json" } });
          if (r.status === 202) continue;
          const b = await r.json();
          if (b.discharge) { dischargeStr = b.discharge; break; }
        }
      }
      if (!dischargeStr) throw new Error("no discharge");
      // dischargeStr might or might not have fm2_ prefix
      const stripped = dischargeStr.startsWith("fm2_") ? dischargeStr : `fm2_${dischargeStr}`;
      const fm2Raw = stripped;
      const newToken = `fm2_${Buffer.from(raws[0]).toString("base64")},${fm2Raw}`;
      const newAuth = `FlyV1 ${newToken}`;
      console.log(`  fresh-only header length: ${newAuth.length}`);
      const probeRes = await fetch("https://api.fly.io/graphql", {
        method: "POST",
        headers: { authorization: newAuth, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: `query($admin: Boolean!) { organizations(admin: $admin) { nodes { slug name type } } }`, variables: { admin: false } }),
      });
      console.log(`  fresh-only orgs HTTP: ${probeRes.status}`);
      console.log(`  fresh-only orgs body: ${(await probeRes.text()).slice(0, 400)}`);
    } };
  })();
  await fetchOneDischargeProbe();

  console.log("\n=== local: discharge bundle ===");
  // Inline a debug version that logs decisions.
  const newHeader = await dischargeBundle(authHeader);
  console.log(`  new header length: ${newHeader.length}  (was ${authHeader.length})`);

  // Show what's in the new bundle.
  const newRaws = parseFlyTokens(newHeader);
  console.log(`  new bundle has ${newRaws.length} macaroon(s):`);
  for (const r of newRaws) {
    const m = decodeMacaroon(r);
    console.log(`    - location: ${m.location}  3p_caveats: ${m.thirdPartyCaveats.length}  raw_bytes: ${r.length}`);
  }

  // Compare KIDs and ticket to see who matches who.
  console.log(`  ticket_hex of 3p in raws[0]:`);
  for (const m of newRaws.map((r) => decodeMacaroon(r))) {
    for (const tp of m.thirdPartyCaveats) {
      let h = ""; for (const b of tp.ticket) h += b.toString(16).padStart(2, "0");
      console.log(`    ${h.slice(0,40)}…`);
    }
  }
  console.log(`  KIDs of all macaroons:`);
  for (const r of newRaws) {
    const m = decodeMacaroon(r);
    let h = ""; for (const b of m.nonceKid) h += b.toString(16).padStart(2, "0");
    console.log(`    ${m.location}: ${h.slice(0,40)}…`);
  }

  for (const probe of [
    {
      label: "GraphQL: organizations(admin: false) [discharged]",
      url: "https://api.fly.io/graphql",
      body: {
        query: `query($admin: Boolean!) { organizations(admin: $admin) { nodes { slug name type } } }`,
        variables: { admin: false },
      },
    },
  ]) {
    const res = await fetch(probe.url, {
      method: "POST",
      headers: {
        authorization: newHeader,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(probe.body),
    });
    console.log(`  ${probe.label}: ${res.status}`);
    console.log(`  body: ${(await res.text()).slice(0, 600)}`);
  }

  // REST list-apps probe with discharged token.
  const restRes = await fetch("https://api.machines.dev/v1/apps?org_slug=personal", {
    headers: { authorization: newHeader, accept: "application/json" },
  });
  console.log(`  REST list-apps?org_slug=personal: ${restRes.status}`);
  console.log(`  body: ${(await restRes.text()).slice(0, 400)}`);
}

const probes = {
  decode: decodeAndProbe,
  graphql_viewer: () =>
    call("GraphQL: viewer (User|Macaroon union)", "POST", "https://api.fly.io/graphql", {
      query: `query { viewer { __typename ... on User { id email } ... on Macaroon { email } } }`,
    }),
  graphql_orgs: () =>
    call("GraphQL: organizations(admin: false)", "POST", "https://api.fly.io/graphql", {
      query: `query($admin: Boolean!) { organizations(admin: $admin) { nodes { slug name type } } }`,
      variables: { admin: false },
    }),
  graphql_personal_org: () =>
    call("GraphQL: organization(slug: 'personal')", "POST", "https://api.fly.io/graphql", {
      query: `query { organization(slug: "personal") { id slug name type } }`,
    }),
  machines_apps: () => call("REST: list apps (no org filter)", "GET", "https://api.machines.dev/v1/apps"),
  machines_apps_personal: () =>
    call("REST: list apps?org_slug=personal", "GET", "https://api.machines.dev/v1/apps?org_slug=personal"),
  create_app: () =>
    call("REST: create app", "POST", "https://api.machines.dev/v1/apps", {
      app_name: `logtura-debug-${Date.now().toString(36)}`,
      org_slug: "personal",
    }),
};

if (probeName) {
  const fn = probes[probeName];
  if (!fn) {
    console.error(`unknown probe: ${probeName}\nknown: ${Object.keys(probes).join(", ")}`);
    process.exit(1);
  }
  await fn();
} else {
  // Default: run the read-only probes so we see what the token can see.
  for (const name of ["graphql_viewer", "graphql_orgs", "graphql_personal_org", "machines_apps", "machines_apps_personal"]) {
    await probes[name]();
  }
  console.log("Run with --probe create_app to actually try creating an app.");
}
