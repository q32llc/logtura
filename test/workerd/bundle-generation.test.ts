import { hashCliSecret } from "../../src/cli-auth";
import { generateBundle as generatePublicBundle, parseDeploymentManifest, hashConfigDocument, type DeploymentConfigExport } from "@logtura/core";
import { listProviders } from "../../src/providers";
import { listDestinationDrivers } from "../../src/destinations";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encryptSecret, newId, signCookie } from "../../src/crypto";
import { mockFetch, seedUser } from "./_setup";

/** End-to-end bundle generation: seed a deep fixture (user →
 *  connection → sources → monitor with rollup → sink → slack
 *  destination → deployment), GET the bundle, assert it has the
 *  pieces the UI expects. Hits a large surface — `generator.ts`,
 *  every selected provider/destination driver, bundle assembly,
 *  manifest construction — so a regression in any of them lights up
 *  here. */

interface SeededDeployment {
  userId: string;
  sessionCookie: string;
  connectionId: string;
  deploymentId: string;
}

async function seedFullDeployment(): Promise<SeededDeployment> {
  const { userId, sessionCookie } = await seedUser();
  const now = Date.now();
  const connectionId = newId("con");
  const sourceA = newId("src");
  const sourceB = newId("src");
  const destinationId = newId("dst");
  const monitorId = newId("mon");
  const sinkId = newId("snk");
  const deploymentId = newId("dep");

  const credsCt = await encryptSecret(
    JSON.stringify({ apiToken: "cf_test_token" }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO connections
     (id, user_id, provider, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
     VALUES (?, ?, 'cloudflare-worker-tail', 'CF', 'acct_xyz', ?, ?, ?)`,
  )
    .bind(connectionId, userId, credsCt, now, now)
    .run();

  // Two workers — exercises the consolidated cf_worker_norm path
  // (per-kind normalize fans in N inputs, not N copies of identical
  // VRL). Without two sources we wouldn't see the consolidation.
  for (const [id, externalId] of [
    [sourceA, "worker-one"],
    [sourceB, "worker-two"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO log_sources
       (id, connection_id, source_kind, external_id, display_name, discovered_at)
       VALUES (?, ?, 'cf_worker', ?, ?, ?)`,
    )
      .bind(id, connectionId, externalId, externalId, now)
      .run();
  }

  // Slack destination — the encrypted config holds the webhook URL.
  // We never actually POST to it in this test (the bundle endpoint
  // doesn't send anything; it just renders config), so the URL just
  // needs to round-trip through encryption.
  const destCt = await encryptSecret(
    JSON.stringify({
      webhookUrl: "https://hooks.slack.com/services/T00/B00/XXX",
      teamName: "test-team",
      channel: "alerts",
    }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO destinations
     (id, user_id, kind, display_name, config_encrypted, created_at, updated_at)
     VALUES (?, ?, 'slack', 'alerts', ?, ?, ?)`,
  )
    .bind(destinationId, userId, destCt, now, now)
    .run();

  // Monitor: errors + rollup. The rollup_fmt VRL was the regression
  // surface we shipped twice — covering it via generated yaml here
  // means a future `string(int)` slip would fail before deploy.
  const filterSteps = [
    { kind: "errors" },
    { kind: "rollup", window_secs: 30, group_by: ["script"], max_samples: 5 },
  ];
  await env.DB.prepare(
    `INSERT INTO monitors
     (id, user_id, connection_id, display_name, filter_steps_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      monitorId,
      userId,
      connectionId,
      "errors-rollup",
      JSON.stringify(filterSteps),
      now,
      now,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO sinks
     (id, monitor_id, destination_id, filter_steps_json, created_at)
     VALUES (?, ?, ?, '[]', ?)`,
  )
    .bind(sinkId, monitorId, destinationId, now)
    .run();

  // Deployment row. source_selection_json = NULL exercises the
  // back-compat path: bundle assembly falls back to "all sources
  // from deployment.connection_id" when no explicit selection is
  // recorded. The connection set is then derived from those rows.
  await env.DB.prepare(
    `INSERT INTO deployments
     (id, user_id, connection_id, display_name, target_kind, managed,
      source_selection_json, monitor_selection_json,
      heartbeat_target, metrics_target, status,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', 0, NULL, NULL, 'none', 'none', 'pending', ?, ?)`,
  )
    .bind(deploymentId, userId, connectionId, "test-deploy", now, now)
    .run();

  return { userId, sessionCookie, connectionId, deploymentId };
}

describe("GET /api/deployments/:id/bundle", () => {
  it("assembles a valid bundle: vector.yaml + envVars + componentManifest", async () => {
    const seed = await seedFullDeployment();

    // bundle assembly runs Cloudflare's checkCredentialFreshness,
    // which calls /user/tokens/verify. Return a healthy "active"
    // status — that's the only Cloudflare call the bundle path makes
    // (discovery is a separate job).
    mockFetch("https://api.cloudflare.com", async () =>
      Response.json({
        success: true,
        result: { id: "tok_abc", status: "active" },
      }),
    );

    const res = await SELF.fetch(
      `http://localhost/api/deployments/${seed.deploymentId}/bundle`,
      { headers: { cookie: seed.sessionCookie } },
    );
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as {
      target: { id: string; displayName: string };
      files: Array<{ name: string; content: string }>;
      envVars: Array<{ name: string; value: string | null }>;
      selectedCount: number;
      monitorSummary: string;
      componentManifest: Array<{
        id: string;
        role: string;
        category: string;
        label: string;
        links?: { parentId?: string };
      }>;
    };

    // Target hints — the Other driver was selected by deployment.target_kind.
    expect(bundle.target.id).toBe("other");
    expect(bundle.selectedCount).toBe(2);
    expect(bundle.monitorSummary).toMatch(/1 monitor.*1 sink/);

    // vector.yaml is in the file list and looks like vector config.
    const vectorYaml = bundle.files.find((f) => f.name === "vector.yaml");
    expect(vectorYaml).toBeDefined();
    expect(vectorYaml!.content).toContain("sources:");
    expect(vectorYaml!.content).toContain("transforms:");
    expect(vectorYaml!.content).toContain("sinks:");

    // The consolidated normalize transform: multiple workers give
    // one transport normalize per connection; per-worker metric
    // filters branch after it.
    expect(vectorYaml!.content).toMatch(/cf_worker_con_[A-Za-z0-9_-]+_norm:/);

    // The rollup_fmt VRL is what tripped E103 twice in prod. Make
    // sure it's actually being emitted and uses to_string (not
    // string) on the int → string conversions.
    expect(vectorYaml!.content).toContain("rollup_fmt");
    expect(vectorYaml!.content).toContain("to_string(n)");

    // EnvVars include the Cloudflare API token + account id at
    // minimum. The token value is auto-populated from the stored
    // connection cred.
    const tokenEnv = bundle.envVars.find((v) => v.name === "CLOUDFLARE_API_TOKEN");
    expect(tokenEnv?.value).toBe("cf_test_token");

    // Component manifest: one multiplexed CF parent source plus
    // per-worker child sources, one primary sink, some plumbing rows.
    // UI groups by category/role and links child rows by parentId.
    const sources = bundle.componentManifest.filter((c) => c.role === "source");
    expect(sources.length).toBe(3);
    expect(sources.every((s) => s.category === "primary")).toBe(true);
    expect(sources.some((s) => s.links?.parentId)).toBe(true);
    const sinks = bundle.componentManifest.filter((c) => c.role === "sink");
    expect(sinks.length).toBe(1);
    expect(sinks[0]!.label).toMatch(/Slack.*alerts/);
    expect(
      bundle.componentManifest.some((c) => c.role === "normalize"),
    ).toBe(true);
  });

  it("returns 404 for a deployment that doesn't exist", async () => {
    const { sessionCookie } = await seedUser();
    const res = await SELF.fetch(
      "http://localhost/api/deployments/dep_nope/bundle",
      { headers: { cookie: sessionCookie } },
    );
    expect(res.status).toBe(404);
  });
});


describe("install archive delivery", () => {
  it("serves the public core archive from authenticated and signed downloads", async () => {
    const seed = await seedFullDeployment();
    mockFetch("https://api.cloudflare.com", () => Response.json({success: true, result: {status: "active"}}));
    const headers = {cookie: seed.sessionCookie};
    const direct = await SELF.fetch(`http://localhost/api/deployments/${seed.deploymentId}/install-bundle.tgz`, {headers});
    expect(direct.status).toBe(200);
    expect(direct.headers.get("cache-control")).toBe("no-store");
    expect(direct.headers.get("content-type")).toBe("application/gzip");
    const bytes = new Uint8Array(await direct.arrayBuffer());
    const archive = new Uint8Array(await new Response(new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const files = new Map<string, {text: string; mode: number}>();
    const decoder = new TextDecoder();
    for (let offset = 0; archive[offset];) {
      const field = (start: number, end: number) => decoder.decode(archive.slice(offset+start,offset+end)).replace(/\0.*$/s, "");
      const name = field(0,100); const size = parseInt(field(124,136),8); const mode = parseInt(field(100,108),8);
      files.set(name.split("/").slice(1).join("/"), {text: decoder.decode(archive.slice(offset+512,offset+512+size)), mode});
      offset += 512 + Math.ceil(size/512)*512;
    }
    expect(files.get(".env")?.mode).toBe(0o600);
    expect(files.get(".env")?.text).toContain("cf_test_token");
    expect(files.get("install.sh")?.mode).toBe(0o755);
    expect(files.get("install.sh")?.text).toContain("-e CLOUDFLARE_API_TOKEN");
    expect(JSON.parse(files.get("manifest.json")!.text)).toEqual(expect.any(Array));
    expect(files.get("vector.yaml")?.text).toContain("worker-one");
    const signedResponse = await SELF.fetch(`http://localhost/api/deployments/${seed.deploymentId}/install-bundle/sign`, {method: "POST", headers});
    expect(signedResponse.status).toBe(200);
    const signed = await signedResponse.json() as {url: string};
    const download = await SELF.fetch(signed.url);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  });

  it("denies other accounts, missing sessions, tampering and expired links", async () => {
    const seed = await seedFullDeployment(); const other = await seedUser();
    const base = `http://localhost/api/deployments/${seed.deploymentId}`;
    expect((await SELF.fetch(`${base}/install-bundle.tgz`, {redirect: "manual"})).status).toBe(303);
    for (const [suffix, method] of [["install-bundle.tgz", "GET"], ["install-bundle/sign", "POST"]]) {
      expect((await SELF.fetch(`${base}/${suffix}`, {method, headers:{cookie: other.sessionCookie}})).status).toBe(404);
    }
    expect((await SELF.fetch("http://localhost/api/install-bundle/tampered/file.tgz")).status).toBe(401);
    const expired = await signCookie(JSON.stringify({d: seed.deploymentId,u: seed.userId,exp: Date.now()-1000}), env.SESSION_SECRET);
    expect((await SELF.fetch(`http://localhost/api/install-bundle/${encodeURIComponent(expired)}/file.tgz`)).status).toBe(410);
    const bad = await signCookie("not-json",env.SESSION_SECRET);
    expect((await SELF.fetch(`http://localhost/api/install-bundle/${encodeURIComponent(bad)}/file.tgz`)).status).toBe(401);
  });
});


describe("portable deployment export",()=>{
  it("exports the full owned graph, keeps secrets opt-in and renders the identical bundle locally",async()=>{
    const seed=await seedFullDeployment();mockFetch("https://api.cloudflare.com",()=>Response.json({success:true,result:{status:"active"}}));
    const url=`http://localhost/api/deployments/${seed.deploymentId}/config`,headers={cookie:seed.sessionCookie};
    const publicResponse=await SELF.fetch(url,{headers});expect(publicResponse.status).toBe(200);expect(publicResponse.headers.get("cache-control")).toBe("no-store");
    const publicConfig=await publicResponse.json() as DeploymentConfigExport;expect(publicConfig.configurationVersion).toBeTypeOf("number");expect(publicConfig).not.toHaveProperty("secretValues");expect(JSON.stringify(publicConfig)).not.toContain("cf_test_token");expect(JSON.stringify(publicConfig)).not.toContain("hooks.slack.com");
    const response=await SELF.fetch(url+"?includeSecrets=1",{headers});expect(response.status).toBe(200);const exported=await response.json() as DeploymentConfigExport;
    expect(exported.document).toEqual(publicConfig.document);expect(exported.revision).toBe(publicConfig.revision);expect(await hashConfigDocument(exported.document)).toBe(exported.revision);
    const accountToken=`lt_cli_${"A".repeat(43)}`;
    await env.DB.prepare("INSERT INTO cli_account_tokens (id,user_id,token_hash,device_hash,label,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").bind(newId("cli"),seed.userId,await hashCliSecret(accountToken),newId("device"),"Export test",Date.now(),Date.now()+60_000).run();
    const accountResponse=await SELF.fetch(url+"?includeSecrets=1",{headers:{authorization:`Bearer ${accountToken}`}});expect(accountResponse.status).toBe(200);expect(await accountResponse.json()).toEqual(exported);
    const parsed=parseDeploymentManifest(exported.document,{env:exported.secretValues,providers:listProviders(),destinations:listDestinationDrivers()});expect(parsed.missingEnv).toEqual([]);
    expect(parsed.input.connections[0]!.connection.id).toBe(seed.connectionId);expect(parsed.input.connections[0]!.selectedSources).toHaveLength(2);expect(parsed.input.connections[0]!.credentials!.apiToken).toBe("cf_test_token");
    const rendered=generatePublicBundle(parsed.input);const bundled=await (await SELF.fetch(`http://localhost/api/deployments/${seed.deploymentId}/bundle`,{headers})).json() as {files:Array<{name:string;content:string}>;envVars:unknown[];componentManifest:unknown[]};
    expect(rendered.vectorYaml).toBe(bundled.files.find(f=>f.name==="vector.yaml")!.content);expect(rendered.envVars.map(({name,value})=>({name,value}))).toEqual((bundled.envVars as Array<{name:string;value:string|null}>).map(({name,value})=>({name,value})));expect(rendered.componentManifest).toEqual(bundled.componentManifest);
  });
  it("hides cross-account and nonexistent deployments, and rejects reporting tokens as account credentials",async()=>{
    const seed=await seedFullDeployment(),other=await seedUser();
    for(const id of [seed.deploymentId,"dep_missing"]){const response=await SELF.fetch(`http://localhost/api/deployments/${id}/config?includeSecrets=1`,{headers:{cookie:other.sessionCookie}});expect(response.status).toBe(404);expect(await response.json()).toEqual({error:"not_found"});}
    const response=await SELF.fetch(`http://localhost/api/deployments/${seed.deploymentId}/config?includeSecrets=1`,{headers:{authorization:"Bearer heartbeat-token"},redirect:"manual"});expect(response.status).toBe(401);
  });
  it("returns a retryable conflict rather than an incoherent export during repeated website edits",async()=>{
    const seed=await seedFullDeployment();let checks=0;
    mockFetch("https://api.cloudflare.com",async()=>{checks++;await env.DB.prepare("UPDATE monitors SET enabled=1-enabled WHERE user_id=?").bind(seed.userId).run();return Response.json({success:true,result:{status:"active"}});});
    const response=await SELF.fetch(`http://localhost/api/deployments/${seed.deploymentId}/config?includeSecrets=1`,{headers:{cookie:seed.sessionCookie}});
    expect(response.status).toBe(409);expect(response.headers.get("cache-control")).toBe("no-store");expect(checks).toBe(3);const body=await response.json() as any;expect(body.error).toBe("configuration_changed");expect(body.configurationVersion).toBeTypeOf("number");expect(body).not.toHaveProperty("secretValues");expect(body).not.toHaveProperty("document");
  });
  it.each(["deployments","users"])("handles %s deletion during export without exposing the stale graph",async table=>{
    const seed=await seedFullDeployment();mockFetch("https://api.cloudflare.com",async()=>{await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(table==="users"?seed.userId:seed.deploymentId).run();return Response.json({success:true,result:{status:"active"}});});
    const response=await SELF.fetch(`http://localhost/api/deployments/${seed.deploymentId}/config?includeSecrets=1`,{headers:{cookie:seed.sessionCookie}});expect(response.status).toBe(404);expect(await response.json()).toEqual({error:"not_found"});
  });

});
