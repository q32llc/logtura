import { env, createMessageBatch, createExecutionContext, getQueueResult } from "cloudflare:test";
import { expect, it } from "vitest";
import { createConnection, createDeployment, upsertSources } from "../../src/db";
import { JobDriver } from "../../src/jobs/driver";
import worker from "../../src/index";
import { flyAppNameFor } from "../../src/jobs/handlers/fly-deploy";
import { readConfigurationVersion } from "../../src/config-version";
import type { JobKind, JobRecord } from "../../src/jobs/types";
import { mockFetch, seedDeployTarget, seedUser } from "./_setup";
import {readManagedInstall} from "../../src/managed-installations";
import {acceptManagedRuntimeReport} from "./_managed-runtime-report";
import type {FlyMachineConfig} from "@logtura/core";
const imageManifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: `sha256:${"b".repeat(64)}` }, layers: [] });
const digest = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(imageManifest)))].map(byte => byte.toString(16).padStart(2,"0")).join("")}`;
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
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.explicitAcks).toEqual([job.id]); expect(result.retryMessages).toEqual([]);
  return (await f.driver.getById(job.id))!;
}
const imageIndex = JSON.stringify({schemaVersion:2,mediaType:"application/vnd.oci.image.index.v1+json",manifests:[{digest,size:new TextEncoder().encode(imageManifest).byteLength,mediaType:"application/vnd.oci.image.manifest.v1+json",platform:{os:"linux",architecture:"amd64"}}]});
const indexDigest = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(imageIndex)))].map(byte=>byte.toString(16).padStart(2,"0")).join("")}`;
function registry(index = false) {
  mockFetch("https://ghcr.io/token", () => Response.json({ token: "registry_fixture" }));
  mockFetch("https://ghcr.io/v2/q32llc/logtura-forwarder/manifests/", req => {
    expect(req.headers.get("authorization")).toBe("Bearer registry_fixture");
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "docker-content-digest": index ? indexDigest : digest } });
    if (index && new URL(req.url).pathname.endsWith(indexDigest)) return new Response(imageIndex, { headers: { "docker-content-digest": indexDigest } });
    expect(new URL(req.url).pathname.endsWith(digest)).toBe(true);
    return new Response(imageManifest, { headers: { "docker-content-digest": digest } });
  });
}
function machine(state = "started", checks: unknown[] = [{ name: "vector_api", status: "passing" }], events: unknown[] = []) { return { id: "machine1", name: "forwarder", state, region: "ord", instance_id:"version1", image_ref:{registry:"ghcr.io",repository:"q32llc/logtura-forwarder",digest}, config: { image: `ghcr.io/q32llc/logtura-forwarder@${digest}` }, checks, events }; }
it("runs the persisted parent/checkpoint/issued-runtime queue chain and requires an accepted report for healthy completion", async () => {
  const f = await fixture(); registry(); let installed: Record<string, unknown> | undefined,appCreated=false,volume:Record<string,unknown>|undefined,volumeCreates=0,machineCreates=0;
  mockFetch("https://api.machines.dev", async req => {
    const path = new URL(req.url).pathname; expect(req.headers.get("authorization")).toBe("FlyV1 fo1_fixture");
    if (path === `/v1/apps/${f.appName}`) return appCreated?Response.json({name:f.appName,organization:{slug:"personal"}}):new Response(null, { status: 404 });
    if (path === "/v1/apps") { expect(await req.json()).toEqual({ app_name: f.appName, org_slug: "personal" }); appCreated=true;return Response.json({}, { status: 201 }); }
    if(path===`/v1/apps/${f.appName}/volumes`){
      if(req.method==="GET")return Response.json(volume?[volume]:[]);
      volumeCreates++;const body=await req.json() as {name:string};expect(body).toMatchObject({region:"ord",size_gb:1,encrypted:true,machines_only:true,require_unique_zone:true,compute:{cpu_kind:"shared",cpus:2,memory_mb:4096}});
      expect(await env.DB.prepare("SELECT phase FROM managed_checkpoints WHERE deployment_id=?").bind(f.deployment.id).first("phase")).toBe("dispatched");
      volume={id:"vol_checkpoint",name:body.name,region:"ord",size_gb:1,encrypted:true,state:"created",attached_machine_id:null};return Response.json(volume);
    }
    if (path === `/v1/apps/${f.appName}/machines` && req.method === "GET") return Response.json(installed ? [{...machine(),config:installed}] : []);
    if (path === `/v1/apps/${f.appName}/machines` && req.method === "POST") { machineCreates++;const body = await req.json() as {config:Record<string,unknown>;name:string;region:string}; expect(body).toMatchObject({ name: "forwarder", region: "ord" }); installed = body.config; return Response.json({...machine(),config:installed}); }
    throw new Error(`unexpected Fly request ${req.method} ${path}`);
  });
  const parent = await f.enqueue("fly_deploy", f.parentPayload); expect((await consume(f, parent)).status).toBe("succeeded");
  const step1 = (await f.driver.listChildren(parent.id))[0]!; expect(step1.kind).toBe("fly_deploy.discharge_create_app"); expect((await consume(f, step1)).status).toBe("succeeded");
  const checkpoint=(await f.driver.listChildren(parent.id)).find(job=>job.kind==="fly_deploy.ensure_checkpoint")!;expect((await consume(f,checkpoint)).status).toBe("succeeded");
  const step2 = (await f.driver.listChildren(parent.id)).find(job => job.kind === "fly_deploy.create_or_update_machine")!; expect((await consume(f, step2)).status).toBe("succeeded");
  expect(installed).toMatchObject({ image: `ghcr.io/q32llc/logtura-forwarder@${digest}`, env: { RAILWAY_API_TOKEN: "project_token", LOGTURA_HEARTBEAT_TOKEN: f.deployment.heartbeat_token }, init: {entrypoint:["/opt/logtura/runtime/entrypoint.sh"],cmd: ["--config", "/etc/vector/vector.yaml"] },stop_config:{signal:"SIGTERM",timeout:"35s"},mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}], restart: { policy: "always" }, checks: { vector_api: { port: 8686 } } });
  const files = installed!.files as Array<{guest_path:string;raw_value:string;mode:number}>;
  expect(files.find(file => file.guest_path === "/etc/vector/vector.yaml")!.mode).toBe(0o400);
  const asset = files.find(file => file.guest_path.includes("/railway-logs/"))!; expect(asset.mode).toBe(0o755); expect(atob(asset.raw_value)).toContain("WebSocket");
  const wait = (await f.driver.listChildren(parent.id)).find(job => job.kind === "fly_deploy.wait_running")!;
  expect(wait.payload.configurationVersion).toBe(await readConfigurationVersion(env.DB, f.userId)); expect((await consume(f, wait)).result).toMatchObject({polling:true});
  const install=(await readManagedInstall(env,f.userId,f.deployment.id))!;expect(install.phase).toBe("installed");expect(install.payload.schemaVersion).toBe(2);expect(await f.read()).toMatchObject({bundle_outdated:1});
  expect(await acceptManagedRuntimeReport(install.runtime!,installed as FlyMachineConfig,f.deployment.heartbeat_token)).toEqual({accepted:true,reportSequence:1});
  const acceptedWait=(await f.driver.listChildren(parent.id)).find(job=>job.kind==="fly_deploy.wait_running" && job.status==="queued")!;expect((await consume(f,acceptedWait)).status).toBe("succeeded");
  expect((await readManagedInstall(env,f.userId,f.deployment.id,install.id))!.phase).toBe("completed");expect(volumeCreates).toBe(1);expect(machineCreates).toBe(1);
  const publicJobs=await env.DB.prepare("SELECT payload_json,result_json,last_error FROM jobs WHERE user_id=?").bind(f.userId).all();
  expect(JSON.stringify(publicJobs)).not.toMatch(/project_token|fo1_fixture|registry_fixture/);expect(JSON.stringify(publicJobs)).not.toContain(f.deployment.heartbeat_token);
  expect(await f.read()).toMatchObject({ status: "running", bundle_outdated: 0, external_id: `fly:${f.appName}:machine1`, image_digest: digest });
  const events = await env.DB.prepare("SELECT kind FROM ops_events WHERE deployment_id=?").bind(f.deployment.id).all<{kind:string}>(); expect(events.results.map(e => e.kind)).toContain("fly_machine.running");
});
it("updates a named existing machine instead of creating another", async () => {
  const f = await fixture(); registry(); let updated = false,current=machine();
  mockFetch("https://api.machines.dev", async req => { const path = new URL(req.url).pathname;
    if(path===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});
    if(path.endsWith("/lease"))return req.method==="DELETE"?new Response(null,{status:204}):Response.json({data:{nonce:"private-lease"}});
    if (path.endsWith("/machines") && req.method === "GET") return Response.json([current]);
    if(path.endsWith("/machines/machine1") && req.method==="GET")return Response.json(current);
    if (path.endsWith("/machines/machine1") && req.method === "POST") { const body=await req.json() as {config:typeof current.config;current_version:string};expect(body).toHaveProperty("config.files");expect(body.current_version).toBe("version1");expect(req.headers.get("fly-machine-lease-nonce")).toBe("private-lease");current={...current,config:body.config,instance_id:"version2"}; updated = true; return Response.json(current); } throw new Error("unexpected provider write"); });
  const job = await f.enqueue("fly_deploy.create_or_update_machine", { parentPayload: f.parentPayload, appName: f.appName, orgSlug: "personal", region: "ord" }); expect((await consume(f, job)).status).toBe("succeeded"); expect(updated).toBe(true);
});
it("fails an in-flight installation changed by a website edit instead of recording the stale bundle as current", async () => {
  const f = await fixture(); registry();
  mockFetch("https://api.machines.dev", async req => { if(new URL(req.url).pathname===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});if (req.method === "GET") return Response.json([]); const body=await req.json() as {config:ReturnType<typeof machine>["config"]};await env.DB.prepare("UPDATE connections SET display_name='Edited' WHERE id=?").bind(f.connection.id).run(); return Response.json({...machine(),config:body.config}); });
  const job = await f.enqueue("fly_deploy.create_or_update_machine", { parentPayload: f.parentPayload, appName: f.appName, orgSlug: "personal", region: "ord" }); const result = await consume(f, job); expect(result.status).toBe("failed"); expect(result.lastError).toContain("configuration changed"); expect(await f.read()).toMatchObject({ bundle_outdated: 1, external_id: null }); expect(await f.driver.listChildren(job.id)).toEqual([]);
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
it.each([{inventory:[]}, {inventory:[machine("started", [], [{type:"exit",timestamp:Date.now()}])]}])("fails a missing or deadline-expired unhealthy machine", async ({inventory}) => {
  const f = await fixture(); mockFetch("https://api.machines.dev", () => Response.json(inventory)); const job = await f.enqueue("fly_deploy.wait_running", { parentPayload: f.parentPayload, appName: f.appName, machineId: "machine1", pollDeadline: Date.now() - 1 }); const result = await consume(f, job); expect(result.status).toBe("failed");expect(result.lastError).toContain(inventory.length?"did not reach healthy":"not found"); expect(await f.driver.listChildren(job.id)).toEqual([]);
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

it("pins the managed provider request to the verified platform child of an OCI index",async()=>{
 const f=await fixture();registry(true);mockFetch("https://api.machines.dev",async req=>{if(new URL(req.url).pathname===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});if(req.method==="GET")return Response.json([]);const body=await req.json() as {config:{image:string}};expect(body.config.image).toBe(`ghcr.io/q32llc/logtura-forwarder@${digest}`);expect(body.config.image).not.toContain(indexDigest);return Response.json({...machine(),config:body.config});});const job=await f.enqueue("fly_deploy.create_or_update_machine",{parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"});expect((await consume(f,job)).status).toBe("succeeded");expect(await f.read()).toMatchObject({image_digest:digest});
});
it("recovers a lost managed create response from the encrypted intent without re-resolving images or issuing another machine",async()=>{
 const f=await fixture();registry();let installed:ReturnType<typeof machine>|null=null,creates=0,lose=true;
 mockFetch("https://api.machines.dev",async req=>{if(new URL(req.url).pathname===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});if(req.method==="GET")return Response.json(installed?[installed]:[]);const body=await req.json() as {config:ReturnType<typeof machine>["config"]};creates++;installed={...machine(),config:body.config};if(lose)throw new TypeError("managed create acknowledgement lost");return Response.json(installed);});
 const payload={parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"},first=await f.enqueue("fly_deploy.create_or_update_machine",payload);expect((await consume(f,first)).status).toBe("failed");
 const {readManagedInstall}=await import("../../src/managed-installations"),saved=(await readManagedInstall(env,f.userId,f.deployment.id))!;expect(saved.phase).toBe("dispatched");lose=false;
 mockFetch("https://ghcr.io",()=>{throw new Error("registry must not be contacted during recovery");});
 const second=await f.enqueue("fly_deploy.create_or_update_machine",payload),recovered=await consume(f,second);expect(recovered.status,recovered.lastError??"").toBe("succeeded");expect(recovered.result).toMatchObject({recovered:true,installationId:saved.id});expect(creates).toBe(1);
 const wait=(await f.driver.listChildren(second.id))[0]!;expect((await consume(f,wait)).status).toBe("succeeded");expect((await readManagedInstall(env,f.userId,f.deployment.id,saved.id))!.phase).toBe("completed");
 const publicRows=await env.DB.prepare("SELECT payload_json,result_json,last_error FROM jobs WHERE user_id=?").bind(f.userId).all();expect(JSON.stringify(publicRows)).not.toMatch(/project_token|fo1_fixture|registry_fixture/);
});
it("recovers after committing provider identity but failing to enqueue the health poll",async()=>{
 const f=await fixture();registry();let installed:ReturnType<typeof machine>|null=null,creates=0;
 mockFetch("https://api.machines.dev",async req=>{if(new URL(req.url).pathname===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});if(req.method==="GET")return Response.json(installed?[installed]:[]);const body=await req.json() as {config:ReturnType<typeof machine>["config"]};creates++;installed={...machine(),config:body.config};return Response.json(installed);});
 await env.DB.exec("CREATE TRIGGER fail_managed_poll BEFORE INSERT ON jobs WHEN NEW.kind='fly_deploy.wait_running' BEGIN SELECT RAISE(ABORT,'injected_poll_publication_failure'); END");
 const payload={parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"},first=await f.enqueue("fly_deploy.create_or_update_machine",payload);expect((await consume(f,first)).status).toBe("failed");expect(await f.read()).toMatchObject({external_id:`fly:${f.appName}:machine1`});
 await env.DB.exec("DROP TRIGGER fail_managed_poll");const second=await f.enqueue("fly_deploy.create_or_update_machine",payload),result=await consume(f,second);expect(result.status,result.lastError??"").toBe("succeeded");expect(creates).toBe(1);const wait=(await f.driver.listChildren(second.id))[0]!;expect((await consume(f,wait)).status).toBe("succeeded");
});
it("refuses a healthy managed machine with changed files or a different reported image digest",async()=>{
 const f=await fixture();registry();let installed:ReturnType<typeof machine>|null=null;
 mockFetch("https://api.machines.dev",async req=>{if(new URL(req.url).pathname===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});if(req.method==="GET")return Response.json(installed?[installed]:[]);const body=await req.json() as {config:ReturnType<typeof machine>["config"]};installed={...machine(),config:body.config};return Response.json(installed);});
 const step=await f.enqueue("fly_deploy.create_or_update_machine",{parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"});expect((await consume(f,step)).status).toBe("succeeded");const wait=(await f.driver.listChildren(step.id))[0]!;
 const intended=structuredClone(installed!);installed!.config={image:intended.config.image};expect((await consume(f,wait)).lastError).toContain("differs from its saved installation");expect(await f.read()).toMatchObject({bundle_outdated:1});
 installed={...intended,image_ref:{...intended.image_ref,digest:`sha256:${"c".repeat(64)}`}};const wrongImage=await f.enqueue("fly_deploy.wait_running",wait.payload);expect((await consume(f,wrongImage)).lastError).toContain("differs from its saved installation");
});

it("refuses a changed recovery target and unowned or multi-machine inventories",async()=>{
 const f=await fixture();registry();const {prepareManagedInstall}=await import("../../src/managed-installations");await prepareManagedInstall(env,{userId:f.userId,deploymentId:f.deployment.id,app:f.appName,org:"personal",region:"ord",configurationVersion:await readConfigurationVersion(env.DB,f.userId),config:{image:`ghcr.io/q32llc/logtura-forwarder@${digest}`},machine:null});
 for(const change of [{appName:"other"},{region:"iad"},{orgSlug:"other"}]){const job=await f.enqueue("fly_deploy.create_or_update_machine",{parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord",...change});expect((await consume(f,job)).lastError).toContain("target changed");}
 const other=await fixture();registry();for(const inventory of [[machine(),{...machine(),id:"other"}],[{...machine(),name:"unowned"}]]){mockFetch("https://api.machines.dev",()=>Response.json(inventory));const job=await other.enqueue("fly_deploy.create_or_update_machine",{parentPayload:other.parentPayload,appName:other.appName,orgSlug:"personal",region:"ord"});expect((await consume(other,job)).lastError).toContain("one owned forwarder");}
});

it("reuses an existing mounted checkpoint and preserves unrelated provider configuration in the issued update",async()=>{
 const f=await fixture();registry();let updates=0;
 let current:ReturnType<typeof machine> & {config:FlyMachineConfig}={...machine(),config:{
  image:`ghcr.io/q32llc/logtura-forwarder@${digest}`,env:{UNRELATED:"keep"},
  files:[{guest_path:"/etc/unrelated",raw_value:btoa("keep"),mode:0o400}],
  mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}],guest:{cpu_kind:"shared",cpus:2,memory_mb:4096},checks:{unrelated:{port:1234}}
 }};
 mockFetch("https://api.machines.dev",async req=>{
  const path=new URL(req.url).pathname;
  if(path===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});
  if(path.endsWith("/volumes")){expect(req.method).toBe("GET");return Response.json([{id:"vol_checkpoint",region:"ord",encrypted:true,state:"created",attached_machine_id:"machine1"}]);}
  if(path.endsWith("/lease"))return req.method==="DELETE"?new Response(null,{status:204}):Response.json({data:{nonce:"private-lease"}});
  if(path.endsWith("/machines")){expect(req.method).toBe("GET");return Response.json([current]);}
  if(path.endsWith("/machines/machine1")){
   if(req.method==="GET")return Response.json(current);
   updates++;const body=await req.json() as {config:FlyMachineConfig;current_version:string};expect(body.current_version).toBe("version1");current={...current,config:body.config,instance_id:"version2"};return Response.json(current);
  }
  throw new Error("unexpected provider mutation");
 });
 const storage=await f.enqueue("fly_deploy.ensure_checkpoint",{parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"});expect((await consume(f,storage)).result).toMatchObject({volumeId:"vol_checkpoint"});
 const create=(await f.driver.listChildren(storage.id))[0]!;expect((await consume(f,create)).status).toBe("succeeded");expect(updates).toBe(1);
 expect(current.config).toMatchObject({env:{UNRELATED:"keep",RAILWAY_API_TOKEN:"project_token"},checks:{unrelated:{port:1234},vector_api:{port:8686}},mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}]});
 expect(current.config.files).toContainEqual({guest_path:"/etc/unrelated",raw_value:btoa("keep"),mode:0o400});expect((await readManagedInstall(env,f.userId,f.deployment.id))!.runtime).not.toBeNull();
 expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM managed_checkpoints WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(0);
});
it.each(["organization","region","fleet","name","missing-mount"])("refuses incompatible %s before provisioning or issuing any runtime",async reason=>{
 const f=await fixture();let writes=0;
 mockFetch("https://api.machines.dev",req=>{
  if(req.method!=="GET"){writes++;throw new Error("must not write");}
  const path=new URL(req.url).pathname;
  if(path===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:reason==="organization"?"other":"personal"}});
  if(path.endsWith("/volumes"))return Response.json([]);
  const m={...machine(),region:reason==="region"?"iad":"ord",name:reason==="name"?"other":"forwarder"};return Response.json(reason==="fleet"?[m,{...m,id:"other"}]:[m]);
 });
 const storage=await f.enqueue("fly_deploy.ensure_checkpoint",{parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"});expect((await consume(f,storage)).status).toBe("failed");expect(writes).toBe(0);expect(await f.driver.listChildren(storage.id)).toEqual([]);expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deployment_configuration_state WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(0);
});
it.each([false,true])("keeps uncertain storage outcomes durable and never repeats provisioning (provider observed=%s)",async observed=>{
 const f=await fixture();let creates=0,volume:Record<string,unknown>|null=null,lose=true;
 mockFetch("https://api.machines.dev",async req=>{
  const path=new URL(req.url).pathname;
  if(path===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});
  if(path.endsWith("/machines")){expect(req.method).toBe("GET");return Response.json([]);}
  expect(path.endsWith("/volumes")).toBe(true);if(req.method==="GET")return Response.json(volume?[volume]:[]);
  creates++;const body=await req.json() as {name:string};if(observed)volume={id:"vol_checkpoint",name:body.name,region:"ord",size_gb:1,encrypted:true,state:"created",attached_machine_id:null};if(lose)throw new TypeError("storage acknowledgement lost");return Response.json(volume);
 });
 const payload={parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"},first=await f.enqueue("fly_deploy.ensure_checkpoint",payload);expect((await consume(f,first)).lastError).toContain("acknowledgement lost");lose=false;
 const retry=await f.enqueue("fly_deploy.ensure_checkpoint",payload),result=await consume(f,retry);expect(creates).toBe(1);
 if(observed){expect(result.status).toBe("succeeded");expect((await f.driver.listChildren(retry.id))[0]!.payload.volumeId).toBe("vol_checkpoint");}
 else{expect(result.lastError).toContain("outcome is unknown");expect(await f.driver.listChildren(retry.id)).toEqual([]);}
 expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deployment_configuration_state WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(0);
});
it("routes retained legacy intent to exact recovery and refuses a disappeared journal without any provider write",async()=>{
 const f=await fixture(),{prepareManagedInstall}=await import("../../src/managed-installations"),saved=await prepareManagedInstall(env,{userId:f.userId,deploymentId:f.deployment.id,app:f.appName,org:"personal",region:"ord",configurationVersion:await readConfigurationVersion(env.DB,f.userId),config:{image:`ghcr.io/q32llc/logtura-forwarder@${digest}`},machine:null});
 mockFetch("https://api.machines.dev",()=>{throw new Error("provider must not be contacted");});
 const payload={parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord"};
 for(const change of [{appName:"other"},{orgSlug:"other"},{region:"iad"}]){const step=await f.enqueue("fly_deploy.ensure_checkpoint",{...payload,...change});expect((await consume(f,step)).lastError).toContain("retained installation target changed");}
 const storage=await f.enqueue("fly_deploy.ensure_checkpoint",payload);expect((await consume(f,storage)).result).toMatchObject({installationId:saved.id,recovery:true});const next=(await f.driver.listChildren(storage.id))[0]!;expect(next.payload.installationId).toBe(saved.id);expect(next.payload).not.toHaveProperty("volumeId");
 await env.DB.prepare("DELETE FROM managed_installations WHERE id=?").bind(saved.id).run();expect((await consume(f,next)).lastError).toContain("retained installation is missing");expect(await f.driver.listChildren(next.id)).toEqual([]);
});

it.each(["missing-reservation","missing-volume","wrong-volume","attached-volume","duplicate-volume"])("refuses %s between checkpoint preparation and runtime issuance",async reason=>{
 const f=await fixture();registry();const {prepareManagedCheckpoint,executeManagedCheckpoint}=await import("../../src/managed-checkpoints"),{FlyMachinesClient}=await import("@logtura/core");
 let volume:Record<string,unknown>|null=null,machineWrites=0;
 mockFetch("https://api.machines.dev",async req=>{
  const path=new URL(req.url).pathname;
  if(path===`/v1/apps/${f.appName}`)return Response.json({name:f.appName,organization:{slug:"personal"}});
  if(path.endsWith("/machines")){if(req.method!=="GET"){machineWrites++;throw new Error("must not create a machine");}return Response.json([]);}
  expect(path.endsWith("/volumes")).toBe(true);
  if(req.method==="POST"){const body=await req.json() as {name:string};volume={id:"vol_checkpoint",name:body.name,region:"ord",size_gb:1,encrypted:true,state:"created",attached_machine_id:null};return Response.json(volume);}
  if(reason==="duplicate-volume" && volume)return Response.json([volume,volume]);
  return Response.json(volume?[volume]:[]);
 });
 if(reason!=="missing-reservation"){
  const reservation=await prepareManagedCheckpoint(env,{userId:f.userId,deploymentId:f.deployment.id,app:f.appName,org:"personal",region:"ord",configurationVersion:await readConfigurationVersion(env.DB,f.userId)});
  // Start with valid inventory; corrupt it only after the durable ready reference.
  await executeManagedCheckpoint(env,reservation,new FlyMachinesClient({token:"fo1_fixture",authorizationScheme:"FlyV1"}),new AbortController().signal);
 }
 if(reason==="missing-volume")volume=null;
 else if(reason==="wrong-volume")volume={...volume!,id:"vol_other"};
 else if(reason==="attached-volume")volume={...volume!,attached_machine_id:"unowned"};
 const create=await f.enqueue("fly_deploy.create_or_update_machine",{parentPayload:f.parentPayload,appName:f.appName,orgSlug:"personal",region:"ord",volumeId:"vol_checkpoint"});expect((await consume(f,create)).lastError).toContain("checkpoint is not available");expect(machineWrites).toBe(0);
 expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deployment_configuration_state WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(0);expect(await readManagedInstall(env,f.userId,f.deployment.id)).toBeNull();
});
