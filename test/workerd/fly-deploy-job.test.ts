import { env, createMessageBatch, createExecutionContext, getQueueResult } from "cloudflare:test";
import { expect, it } from "vitest";
import { createConnection, createDeployment, upsertSources } from "../../src/db";
import { JobDriver } from "../../src/jobs/driver";
import { processQueueBatch } from "../../src/jobs/queue";
import { flyAppNameFor } from "../../src/jobs/handlers/fly-deploy";
import { readConfigurationVersion } from "../../src/config-version";
import type { JobKind, JobRecord } from "../../src/jobs/types";
import { mockFetch, seedDeployTarget, seedUser } from "./_setup";
const digest = `sha256:${"a".repeat(64)}`;
async function fixture() {
  const { userId } = await seedUser();
  const target = await seedDeployTarget({ userId, kind: "fly", displayName: "Fly", externalAccountId: "personal", credentials: { apiToken: "fo1_fixture" } });
  const connection = await createConnection(env.DB, env, { userId, provider: "railway-logs", displayName: "Railway", externalAccountId: "project:production", credentials: { apiToken: "project_token" } });
  await upsertSources(env.DB, connection.id, [{ sourceKind: "railway_service", externalId: "service", displayName: "App", metadata: { environment_id: "production", service_id: "service" } }]);
  const deployment = await createDeployment(env.DB, { userId, connectionId: connection.id, deployTargetId: target.id, targetKind: "fly", displayName: "Managed", managed: true });
  await env.DB.prepare("UPDATE deployments SET bundle_outdated=1 WHERE id=?").bind(deployment.id).run();
  const driver = new JobDriver(env.DB, env.JOBS_QUEUE), parentPayload = { deploymentId: deployment.id, deployTargetId: target.id, orgSlug: "personal", region: "ord" }, appName = flyAppNameFor(deployment.id);
  const read = () => env.DB.prepare("SELECT status,bundle_outdated,external_id,image_digest FROM deployments WHERE id=?").bind(deployment.id).first();
  const enqueue = async (kind: JobKind, payload: Record<string, unknown>) => (await driver.enqueue({ userId, kind, payload })).job;
  return { userId, target, connection, deployment, driver, parentPayload, appName, read, enqueue };
}
async function consume(f: Awaited<ReturnType<typeof fixture>>, job: JobRecord) {
  await env.DB.prepare("UPDATE jobs SET available_at=NULL WHERE id=?").bind(job.id).run();
  const batch = createMessageBatch("logtura-jobs", [{ id: job.id, timestamp: new Date(), attempts: 1, body: { jobId: job.id } }]);
  await processQueueBatch(batch, env);
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.explicitAcks).toEqual([job.id]); expect(result.retryMessages).toEqual([]);
  return (await f.driver.getById(job.id))!;
}
function registry() {
  mockFetch("https://ghcr.io/token", () => Response.json({ token: "registry_fixture" }));
  mockFetch("https://ghcr.io/v2/q32llc/logtura-forwarder/manifests/latest", req => { expect(req.method).toBe("HEAD"); expect(req.headers.get("authorization")).toBe("Bearer registry_fixture"); return new Response(null, { status: 200, headers: { "docker-content-digest": digest } }); });
}
function machine(state = "started", checks: unknown[] = [{ name: "vector_api", status: "passing" }], events: unknown[] = []) { return { id: "machine1", name: "forwarder", state, region: "ord", config: { image: `ghcr.io/q32llc/logtura-forwarder@${digest}` }, checks, events }; }
it("runs the real persisted parent/three-step queue chain with generated Railway assets and a fenced healthy completion", async () => {
  const f = await fixture(); registry(); let installed: Record<string, unknown> | undefined;
  mockFetch("https://api.machines.dev", async req => {
    const path = new URL(req.url).pathname; expect(req.headers.get("authorization")).toBe("FlyV1 fo1_fixture");
    if (path === `/v1/apps/${f.appName}`) return new Response(null, { status: 404 });
    if (path === "/v1/apps") { expect(await req.json()).toEqual({ app_name: f.appName, org_slug: "personal" }); return Response.json({}, { status: 201 }); }
    if (path === `/v1/apps/${f.appName}/machines` && req.method === "GET") return Response.json(installed ? [machine()] : []);
    if (path === `/v1/apps/${f.appName}/machines` && req.method === "POST") { const body = await req.json() as {config:Record<string,unknown>;name:string;region:string}; expect(body).toMatchObject({ name: "forwarder", region: "ord" }); installed = body.config; return Response.json(machine()); }
    throw new Error(`unexpected Fly request ${req.method} ${path}`);
  });
  const parent = await f.enqueue("fly_deploy", f.parentPayload); expect((await consume(f, parent)).status).toBe("succeeded");
  const step1 = (await f.driver.listChildren(parent.id))[0]!; expect(step1.kind).toBe("fly_deploy.discharge_create_app"); expect((await consume(f, step1)).status).toBe("succeeded");
  const step2 = (await f.driver.listChildren(parent.id)).find(job => job.kind === "fly_deploy.create_or_update_machine")!; expect((await consume(f, step2)).status).toBe("succeeded");
  expect(installed).toMatchObject({ image: `ghcr.io/q32llc/logtura-forwarder@${digest}`, env: { RAILWAY_API_TOKEN: "project_token", LOGTURA_HEARTBEAT_TOKEN: f.deployment.heartbeat_token }, init: { cmd: ["--config", "/etc/vector/vector.yaml"] }, restart: { policy: "always" }, checks: { vector_api: { port: 8686 } } });
  const files = installed!.files as Array<{guest_path:string;raw_value:string;mode:number}>;
  expect(files.find(file => file.guest_path === "/etc/vector/vector.yaml")!.mode).toBe(0o400);
  const asset = files.find(file => file.guest_path.includes("/railway-logs/"))!; expect(asset.mode).toBe(0o755); expect(atob(asset.raw_value)).toContain("WebSocket");
  const wait = (await f.driver.listChildren(parent.id)).find(job => job.kind === "fly_deploy.wait_running")!;
  expect(wait.payload.configurationVersion).toBe(await readConfigurationVersion(env.DB, f.userId)); expect((await consume(f, wait)).status).toBe("succeeded");
  expect(await f.read()).toMatchObject({ status: "running", bundle_outdated: 0, external_id: `fly:${f.appName}:machine1`, image_digest: digest });
  const events = await env.DB.prepare("SELECT kind FROM ops_events WHERE deployment_id=?").bind(f.deployment.id).all<{kind:string}>(); expect(events.results.map(e => e.kind)).toContain("fly_machine.running");
});
it("updates a named existing machine instead of creating another", async () => {
  const f = await fixture(); registry(); let updated = false;
  mockFetch("https://api.machines.dev", async req => { const path = new URL(req.url).pathname; if (path.endsWith("/machines") && req.method === "GET") return Response.json([machine()]); if (path.endsWith("/machines/machine1") && req.method === "POST") { expect(await req.json()).toHaveProperty("config.files"); updated = true; return Response.json(machine()); } throw new Error("unexpected provider write"); });
  const job = await f.enqueue("fly_deploy.create_or_update_machine", { parentPayload: f.parentPayload, appName: f.appName, orgSlug: "personal", region: "ord" }); expect((await consume(f, job)).status).toBe("succeeded"); expect(updated).toBe(true);
});
it("fails an in-flight installation changed by a website edit instead of recording the stale bundle as current", async () => {
  const f = await fixture(); registry();
  mockFetch("https://api.machines.dev", async req => { if (req.method === "GET") return Response.json([]); await env.DB.prepare("UPDATE connections SET display_name='Edited' WHERE id=?").bind(f.connection.id).run(); return Response.json(machine()); });
  const job = await f.enqueue("fly_deploy.create_or_update_machine", { parentPayload: f.parentPayload, appName: f.appName, orgSlug: "personal", region: "ord" }); const result = await consume(f, job); expect(result.status).toBe("failed"); expect(result.lastError).toContain("Configuration changed"); expect(await f.read()).toMatchObject({ bundle_outdated: 1, external_id: null }); expect(await f.driver.listChildren(job.id)).toEqual([]);
});
it("keeps the outdated marker when a website edit occurs while waiting for health", async () => {
  const f = await fixture(), version = await readConfigurationVersion(env.DB, f.userId); await env.DB.prepare("UPDATE connections SET display_name='Edited' WHERE id=?").bind(f.connection.id).run(); mockFetch("https://api.machines.dev", () => Response.json([machine()]));
  const job = await f.enqueue("fly_deploy.wait_running", { parentPayload: f.parentPayload, appName: f.appName, machineId: "machine1", pollDeadline: Date.now() + 1000, configurationVersion: version }); expect((await consume(f, job)).status).toBe("failed"); expect(await f.read()).toMatchObject({ status: "running", bundle_outdated: 1 });
});
it("lets a pre-fence queued poll report machine health without clearing an unverifiable outdated marker", async () => {
  const f = await fixture(); mockFetch("https://api.machines.dev", () => Response.json([machine()])); const job = await f.enqueue("fly_deploy.wait_running", { parentPayload: f.parentPayload, appName: f.appName, machineId: "machine1", pollDeadline: Date.now() + 1000 }); expect((await consume(f, job)).status).toBe("succeeded"); expect(await f.read()).toMatchObject({ status: "running", bundle_outdated: 1 });
});
it.each([["started", [], []], ["started", [{name:"vector_api",status:"critical"}], []], ["started", [{name:"vector_api",status:"passing"}], [{type:"exit",timestamp:Date.now()}]], ["starting", [{name:"vector_api",status:"passing"}], []]])("keeps polling unhealthy machine %s with checks %j and events %j", async (state, checks, events) => {
  const f = await fixture(); mockFetch("https://api.machines.dev", () => Response.json([machine(state as string, checks as unknown[], events as unknown[])])); const job = await f.enqueue("fly_deploy.wait_running", { parentPayload: f.parentPayload, appName: f.appName, machineId: "machine1", pollDeadline: Date.now() + 60_000 }); const result = await consume(f, job); expect(result.status).toBe("succeeded"); expect(result.result).toMatchObject({ polling: true }); const next = (await f.driver.listChildren(job.id))[0]!; expect(next.payload).toEqual(job.payload); expect(next.availableAt).toBeGreaterThan(Date.now()); expect(await f.read()).toMatchObject({ status: "pending", bundle_outdated: 1 });
});
it("nudges a stopped machine and tolerates Fly's transient start precondition response", async () => {
  const f = await fixture(); let starts = 0; mockFetch("https://api.machines.dev", req => { if (req.method === "GET") return Response.json([machine("stopped")]); expect(new URL(req.url).pathname).toContain("/start"); starts++; return new Response("not ready", { status: 412 }); }); const job = await f.enqueue("fly_deploy.wait_running", { parentPayload: f.parentPayload, appName: f.appName, machineId: "machine1", pollDeadline: Date.now() + 60_000 }); expect((await consume(f, job)).result).toMatchObject({ polling: true, startStatus: 412 }); expect(starts).toBe(1);
});
it.each([[], [machine("started", [], [{type:"exit",timestamp:Date.now()}])]])("fails a missing or deadline-expired unhealthy machine", async inventory => {
  const f = await fixture(); mockFetch("https://api.machines.dev", () => Response.json(inventory)); const job = await f.enqueue("fly_deploy.wait_running", { parentPayload: f.parentPayload, appName: f.appName, machineId: "machine1", pollDeadline: Date.now() - 1 }); const result = await consume(f, job); expect(result.status).toBe("failed"); expect(await f.driver.listChildren(job.id)).toEqual([]);
});
it("refuses missing deploy identifiers and unowned, wrong-kind or credentialless targets", async () => {
  const f = await fixture(); const missing = await f.enqueue("fly_deploy", {}); expect((await consume(f, missing)).lastError).toContain("missing ids");
  for (const variant of ["missing", "wrong-kind", "empty-token"]) {
    let id = "unowned";
    if (variant !== "missing") id = (await seedDeployTarget({ userId: f.userId, kind: variant === "wrong-kind" ? "other" : "fly", displayName: "Bad", externalAccountId: null, credentials: {} })).id;
    const job = await f.enqueue("fly_deploy.discharge_create_app", { parentPayload: { ...f.parentPayload, deployTargetId: id }, appName: f.appName }); expect((await consume(f, job)).status).toBe("failed"); expect(await f.driver.listChildren(job.id)).toEqual([]);
  }
});
it("reuses the app and resolves the organization when no explicit slug was supplied", async () => {
  const f = await fixture(); mockFetch("https://api.fly.io/graphql", () => Response.json({ data: { organizations: { nodes: [{slug:"team"},{slug:"personal"}] } } })); mockFetch("https://api.machines.dev", () => Response.json({ name: f.appName, organization: {slug:"personal"} })); const job = await f.enqueue("fly_deploy.discharge_create_app", { parentPayload: { deploymentId: f.deployment.id, deployTargetId: f.target.id }, appName: f.appName }); const result = await consume(f, job); expect(result.result).toMatchObject({ orgSlug: "personal", region: "iad" });
});
it("records an organization fallback warning before continuing the chain", async () => {
  const f = await fixture(); mockFetch("https://api.fly.io/graphql", () => Response.json({ data: { organizations: { nodes: [] } } })); mockFetch("https://api.machines.dev", () => Response.json({name:f.appName})); const job = await f.enqueue("fly_deploy.discharge_create_app", { parentPayload: { deploymentId: f.deployment.id, deployTargetId: f.target.id }, appName: f.appName }); expect((await consume(f, job)).status).toBe("succeeded"); expect((await env.DB.prepare("SELECT kind FROM ops_events WHERE job_id=? AND kind='fly_org_slug_fallback'").bind(job.id).all()).results).toHaveLength(1);
});
it("rejects stale source credentials before image resolution or machine mutation", async () => {
  const f = await fixture(); const { encryptSecret } = await import("../../src/crypto"); const encrypted = await encryptSecret(JSON.stringify({ apiToken: "old" }), env.CREDENTIAL_ENCRYPTION_KEY); await env.DB.prepare("UPDATE connections SET provider='cloudflare-worker-tail',credentials_encrypted=? WHERE id=?").bind(encrypted, f.connection.id).run(); mockFetch("https://api.cloudflare.com", () => Response.json({ success: true, result: { status: "disabled" } })); const job = await f.enqueue("fly_deploy.create_or_update_machine", { parentPayload: f.parentPayload, appName: f.appName, orgSlug: "personal", region: "ord" }); const result = await consume(f, job); expect(result.status).toBe("failed"); expect(result.lastError).toContain("credential is unusable");
});
it("keeps stable DNS-safe managed app identities", () => { expect(flyAppNameFor("dep_Ab_C!123")).toBe("logtura-abc123"); expect(flyAppNameFor(`dep_${"x".repeat(50)}`)).toHaveLength(28); });
it.each([{}, {apiToken:""}])("rejects missing or empty generated runtime credentials before contacting Fly", async credentials => {
  const f = await fixture(), {encryptSecret} = await import("../../src/crypto"), encrypted = await encryptSecret(JSON.stringify(credentials), env.CREDENTIAL_ENCRYPTION_KEY); await env.DB.prepare("UPDATE connections SET credentials_encrypted=? WHERE id=?").bind(encrypted,f.connection.id).run();
  const job = await f.enqueue("fly_deploy.create_or_update_machine", {parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"}); const result = await consume(f,job); expect(result.status).toBe("failed"); expect(result.lastError).toContain("env var RAILWAY_API_TOKEN has no value");
});
it("accepts healthy checks after an old exit and preserves default organization/region results", async () => {
  const f = await fixture(); mockFetch("https://api.machines.dev", () => Response.json([machine("started",[{name:"vector_api",status:"passing"}],[{type:"exit",timestamp:Date.now()-31_000}])])); const job = await f.enqueue("fly_deploy.wait_running", {parentPayload:{deploymentId:f.deployment.id,deployTargetId:f.target.id},appName:f.appName,machineId:"machine1",pollDeadline:Date.now()+1000,configurationVersion:await readConfigurationVersion(env.DB,f.userId)}); const result = await consume(f,job); expect(result.result).toMatchObject({orgSlug:"personal",region:"iad",checksPassing:true});
});
