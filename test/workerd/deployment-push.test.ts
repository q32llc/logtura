import { SELF,env,createExecutionContext } from "cloudflare:test";
import { expect,it } from "vitest";
import { createSecretVersioner,editDeploymentManifest,exportDeploymentManifest,parseDeploymentManifest,LogturaServiceClient,type DeploymentConfigPush,type DeploymentConfigExport } from "@logtura/core";
import { createConnection,createDestination,createMonitor,createSink,createDeployment,upsertSources,getConnection,refreshConnectionCredentials,decryptConnectionCredentials,decryptDestinationConfig,getDestination } from "../../src/db";
import { readConfigurationVersion } from "../../src/config-version";
import { readDeploymentConfiguration } from "../../src/deployment-configuration";
import { hashCliSecret } from "../../src/cli-auth";
import { newToken } from "../../src/crypto";
import { parseDeploymentPush,resolveOwnedDeploymentManifest } from "../../src/deployment-push";
import { seedUser,mockFetch } from "./_setup";
import worker from "../../src/index";
import type { Env } from "../../src/env";

async function fixture(provider="cloudflare-worker-tail"){
  const user=await seedUser(),credentials=provider==="cloudflare-worker-tail"?{apiToken:"owned-private-token"}:provider==="supabase-edge-logs"?{pat:"owned-private-pat",refreshToken:"owned-private-refresh",expiresAt:Date.now()+120_000}:{apiToken:"owned-private-token",refreshToken:"owned-private-refresh",expiresAt:Date.now()+120_000};
  const connection=await createConnection(env.DB,env,{userId:user.userId,provider,displayName:"Account",externalAccountId:"account",credentials});
  if(provider==="cloudflare-worker-tail")await upsertSources(env.DB,connection.id,[{sourceKind:"cf_worker",externalId:"site",displayName:"Site",metadata:{private:"source-private"}}]);
  const destination=await createDestination(env.DB,env,{userId:user.userId,kind:"webhook",displayName:"Alerts",config:{url:"https://private.test/hook"}}),monitor=await createMonitor(env.DB,{userId:user.userId,connectionId:connection.id,displayName:"Errors",filterSteps:[{kind:"errors"}],enabled:true});
  await createSink(env.DB,{monitorId:monitor.id,destinationId:destination.id,filterSteps:[]});
  const deployment=await createDeployment(env.DB,{userId:user.userId,connectionId:connection.id,targetKind:"other",displayName:"Existing",heartbeatTarget:"none",sourceIds:provider==="cloudflare-worker-tail"?null:[]});
  const token=`lt_cli_${newToken()}`;await env.DB.prepare("INSERT INTO cli_account_tokens(id,user_id,token_hash,label,created_at,expires_at) VALUES (?,?,?,?,?,?)").bind(`tok_${connection.id}`,user.userId,await hashCliSecret(token),"Test",Date.now(),Date.now()+60_000).run();
  mockFetch("https://api.cloudflare.com",()=>Response.json({success:true,result:{status:"active"}}));
  const client=new LogturaServiceClient({url:"https://local.test",token,fetch:(url,init)=>SELF.fetch(url,init)}),exported=await client.pullDeploymentConfig(deployment.id,true);
  return {...user,connection,destination,monitor,deployment,token,client,exported};
}
function body(exported:DeploymentConfigExport):DeploymentConfigPush{return {document:exported.document,expectedConfigurationVersion:exported.configurationVersion!,expectedSequence:exported.desiredSequence!};}
async function put(f:Awaited<ReturnType<typeof fixture>>,value:unknown,headers:Record<string,string>={authorization:`Bearer ${f.token}`}){return SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}/config`,{method:"PUT",headers:{"content-type":"application/json",...headers},body:JSON.stringify(value)});}

it("pushes a CLI edit, exposes it to the website, tracks desired sequence and performs a no-op",async()=>{
  const f=await fixture(),edited=await editDeploymentManifest(f.exported.document,f.exported.secretValues!,[{kind:"source.add",connectionId:f.connection.id,source:{id:"src_cli",externalId:"new-site",displayName:"New",sourceKind:"cf_worker",metadata:null}},{kind:"monitor.update",id:f.monitor.id,patch:{displayName:"Updated errors"}}],await createSecretVersioner("local-private"));
  const result=await f.client.pushDeploymentConfig(f.deployment.id,{...body(f.exported),document:edited.document});expect(result.sequence).toBe(1);expect(JSON.stringify(result)).not.toContain("owned-private-token");expect(JSON.stringify(result)).not.toContain("source-private");
  const response=await SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}/config`,{headers:{cookie:f.sessionCookie}});expect(response.headers.get("cache-control")).toBe("no-store");const website=await response.json() as DeploymentConfigExport;expect(website.document).toEqual(result.document);expect(website.desiredSequence).toBe(1);expect(website.secretValues).toBeUndefined();
  expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.desired.revision).toBe(result.revision);expect(await f.client.pushDeploymentConfig(f.deployment.id,body(website))).toEqual(result);
});
it("requires explicit secret upload for changed private values and encrypts accepted values",async()=>{
  const f=await fixture(),edited=await editDeploymentManifest(f.exported.document,f.exported.secretValues!,[{kind:"destination.update",id:f.destination.id,patch:{},destinationConfig:{url:"https://new-private.test/hook"}}],await createSecretVersioner("local-private")),request={...body(f.exported),document:edited.document};
  expect((await put(f,request)).status).toBe(400);expect(await (await put(f,request)).json()).toEqual({error:"secret_required"});expect(await (await put(f,{...request,secretValues:edited.secretValues})).json()).toEqual({error:"secret_upload_not_authorized"});
  const result=await f.client.pushDeploymentConfig(f.deployment.id,{...request,uploadSecrets:true,secretValues:edited.secretValues});expect(JSON.stringify(result)).not.toContain("new-private.test");expect(await decryptDestinationConfig(env,(await getDestination(env.DB,f.userId,f.destination.id))!)).toEqual({url:"https://new-private.test/hook"});
});
it("rejects manually edited private values whose reference version was not changed",async()=>{
  const f=await fixture(),ref=f.exported.document.connections[0]!.credentials!,request={...body(f.exported),uploadSecrets:true,secretValues:{[ref.env]:JSON.stringify({apiToken:"manual-private-edit"})}};
  expect(await (await put(f,request)).json()).toEqual({error:"secret_revision_required"});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.exported.configurationVersion);
});
it.each(["supabase-edge-logs","railway-logs"])("resolves unchanged %s broker references to the latest renewed raw grant",async provider=>{
  const f=await fixture(provider),connection=(await getConnection(env.DB,f.userId,f.connection.id))!,renewed=provider==="supabase-edge-logs"?{pat:"new-private",refreshToken:"new-refresh",expiresAt:Date.now()+120_000}:{apiToken:"new-private",refreshToken:"new-refresh",expiresAt:Date.now()+120_000};
  expect(await refreshConnectionCredentials(env.DB,env,connection,renewed)).toBe(true);
  const result=await f.client.pushDeploymentConfig(f.deployment.id,{...body(f.exported),uploadSecrets:true,secretValues:f.exported.secretValues});expect(result.document).toEqual(f.exported.document);expect(await decryptConnectionCredentials(env,(await getConnection(env.DB,f.userId,f.connection.id))!)).toEqual(renewed);
  const ref=structuredClone(result.document);ref.connections[0]!.credentials!.version="locally-changed";const current=await f.client.pullDeploymentConfig(f.deployment.id,true);
  expect(await (await put(f,{...body(current),document:ref,uploadSecrets:true,secretValues:f.exported.secretValues})).json()).toEqual({error:"raw_credentials_required"});
});
it("fences stale account and desired versions and accepts only one concurrent writer",async()=>{
  const f=await fixture(),request=body(f.exported),responses=await Promise.all([put(f,request),put(f,request)]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
  const stale=await put(f,request);expect(await stale.json()).toMatchObject({error:"configuration_changed"});
  const current=await f.client.pullDeploymentConfig(f.deployment.id);expect(await (await put(f,{...body(current),expectedSequence:0})).json()).toEqual({error:"desired_changed"});
});
it("enforces account ownership and rejects forwarder, expired and revoked credentials",async()=>{
  const f=await fixture(),other=await fixture(),request=body(f.exported);
  expect((await put(f,request,{})).status).toBe(401);expect((await put(f,request,{authorization:`Bearer ${f.deployment.heartbeat_token}`})).status).toBe(401);expect((await put(f,request,{authorization:`Bearer ${other.token}`})).status).toBe(404);
  await env.DB.prepare("UPDATE cli_account_tokens SET revoked_at=1 WHERE user_id=?").bind(f.userId).run();expect((await put(f,request)).status).toBe(401);
  expect((await put(f,request,{cookie:f.sessionCookie})).status).toBe(200);
});
it("rejects malformed or unrelated secret uploads and oversized streamed bodies without writes",async()=>{
  const f=await fixture(),base=body(f.exported),ref=base.document.connections[0]!.credentials!;
  for(const [request,error] of [[null,"invalid_push"],[{...base,extra:true},"invalid_push"],[{...base,expectedSequence:-1},"invalid_push"],[{...base,expectedConfigurationVersion:1.2},"invalid_push"],[{...base,uploadSecrets:"yes"},"invalid_push"],[{...base,document:{}},"invalid_manifest"],[{...base,uploadSecrets:true,secretValues:[]},"invalid_secret_values"],[{...base,uploadSecrets:true,secretValues:{UNRELATED:"secret"}},"unreferenced_secret"],[{...base,uploadSecrets:true,secretValues:{[ref.env]:"private-not-json"}},"invalid_secret_values"]] as const){const response=await put(f,request);expect(response.status).toBe(400);expect(await response.json()).toEqual({error});}
  const malformed=await SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}/config`,{method:"PUT",headers:{authorization:`Bearer ${f.token}`},body:"not-json"});expect(await malformed.json()).toEqual({error:"invalid_push"});
  const large=await SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}/config`,{method:"PUT",headers:{authorization:`Bearer ${f.token}`},body:"x".repeat(1_048_577)});expect(large.status).toBe(413);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.exported.configurationVersion);
});
it("rejects cross-account secret references and identity collisions without partially writing",async()=>{
  const f=await fixture(),other=await fixture(),doc=structuredClone(f.exported.document);doc.connections[0]!.credentials=other.exported.document.connections[0]!.credentials;
  expect(await (await put(f,{...body(f.exported),document:doc})).json()).toEqual({error:"secret_required"});
  doc.connections[0]!.credentials=f.exported.document.connections[0]!.credentials;doc.connections[0]!.connection.id=other.connection.id;doc.connections[0]!.selectedSources=[];doc.monitors=[];
  const ref=doc.connections[0]!.credentials!;expect(await (await put(f,{...body(f.exported),document:doc,uploadSecrets:true,secretValues:{[ref.env]:f.exported.secretValues![ref.env]!}})).json()).toEqual({error:"identity_conflict"});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.exported.configurationVersion);
});
it("sanitizes unavailable stored payloads and validates request structure before resolving",async()=>{
  const f=await fixture();await env.DB.prepare("UPDATE connections SET credentials_encrypted='broken-private-cipher' WHERE id=?").bind(f.connection.id).run();await expect(resolveOwnedDeploymentManifest(env,f.userId,f.deployment.id,body(f.exported))).rejects.toMatchObject({status:503,code:"configuration_unavailable"});
  await expect(resolveOwnedDeploymentManifest(env,f.userId,"missing",body(f.exported))).rejects.toMatchObject({status:404,code:"not_found"});
  for(const value of [[],"bad",{...body(f.exported),expectedConfigurationVersion:-1},{...body(f.exported),expectedSequence:0.1},{...body(f.exported),expectedSequence:Number.MAX_SAFE_INTEGER},{...body(f.exported),uploadSecrets:true,secretValues:null},{...body(f.exported),uploadSecrets:true,secretValues:"bad"},{...body(f.exported),uploadSecrets:true,secretValues:{KEY:12}},{...body(f.exported),uploadSecrets:true,secretValues:{KEY:""}}])expect(()=>parseDeploymentPush(value)).toThrow();
});
it("adopts native source aliases and accepts explicitly uploaded metadata for a new source",async()=>{
  const f=await fixture(),doc=structuredClone(f.exported.document),id=doc.connections[0]!.selectedSources[0]!.id;doc.connections[0]!.selectedSources[0]!.id="src_alias";
  doc.connections[0]!.selectedSources.push({id:"src_new_metadata",externalId:"new",displayName:"New",sourceKind:"cf_worker",metadata:{env:"LOCAL_METADATA",version:"local"}});
  const result=await f.client.pushDeploymentConfig(f.deployment.id,{...body(f.exported),document:doc,uploadSecrets:true,secretValues:{LOCAL_METADATA:JSON.stringify({private:"new-private-metadata"})}});expect(result.sourceAliases).toEqual({src_alias:id});expect(JSON.stringify(result)).not.toContain("new-private-metadata");
});
it("resolves owned metrics references and allows explicit runtime removal for a legacy missing token",async()=>{
  const f=await fixture(),metrics=await createDestination(env.DB,env,{userId:f.userId,kind:"datadog_metrics",displayName:"Metrics",config:{apiKey:"metric-private-key"}});
  const input=parseDeploymentManifest(f.exported.document,{env:f.exported.secretValues}).input;input.metrics={kind:"destination",destination:{id:metrics.id,kind:metrics.kind,displayName:metrics.display_name},destinationConfig:{apiKey:"metric-private-key"}};
  const exported=await exportDeploymentManifest(input,await createSecretVersioner(env.CREDENTIAL_ENCRYPTION_KEY)),request={...body(f.exported),document:exported.document,expectedConfigurationVersion:await readConfigurationVersion(env.DB,f.userId)};
  expect((await f.client.pushDeploymentConfig(f.deployment.id,request)).document.metrics!.kind).toBe("destination");
  const current=await f.client.pullDeploymentConfig(f.deployment.id);await env.DB.prepare("UPDATE deployments SET heartbeat_token=NULL WHERE id=?").bind(f.deployment.id).run();current.document.runtimeEnv=null;
  const result=await f.client.pushDeploymentConfig(f.deployment.id,{...body(current),expectedConfigurationVersion:await readConfigurationVersion(env.DB,f.userId)});expect(result.sequence).toBe(2);
});
it.each([null,[],"invalid-private"])("rejects invalid uploaded credential payloads without disclosing values (%s)",async value=>{
  const f=await fixture(),doc=structuredClone(f.exported.document),ref=doc.connections[0]!.credentials!;ref.version="changed";
  expect(await (await put(f,{...body(f.exported),document:doc,uploadSecrets:true,secretValues:{[ref.env]:JSON.stringify(value)}})).json()).toEqual({error:"invalid_manifest_payload"});
  doc.connections[0]!.credentials=null;expect(await (await put(f,{...body(f.exported),document:doc})).json()).toEqual({error:"invalid_configuration"});
});
it("accepts explicit raw OAuth replacement and rejects alternate broker fields and shared-reference ambiguity",async()=>{
  const f=await fixture("supabase-edge-logs"),doc=structuredClone(f.exported.document),ref=doc.connections[0]!.credentials!;ref.version="changed";
  expect(await (await put(f,{...body(f.exported),document:doc,uploadSecrets:true,secretValues:{[ref.env]:JSON.stringify({pat:"raw",refreshToken:"raw-refresh",tailTokenUrl:"https://broker.test"})}})).json()).toEqual({error:"raw_credentials_required"});
  const raw={pat:"replacement-private",refreshToken:"replacement-refresh"},result=await f.client.pushDeploymentConfig(f.deployment.id,{...body(f.exported),document:doc,uploadSecrets:true,secretValues:{[ref.env]:JSON.stringify(raw)}});expect(await decryptConnectionCredentials(env,(await getConnection(env.DB,f.userId,f.connection.id))!)).toEqual(raw);
  const current=await f.client.pullDeploymentConfig(f.deployment.id,true),ambiguous=structuredClone(current.document);ambiguous.runtimeEnv=ambiguous.connections[0]!.credentials;
  const credentialRef=ambiguous.connections[0]!.credentials!;expect(await (await put(f,{...body(current),document:ambiguous,uploadSecrets:true,secretValues:{[credentialRef.env]:current.secretValues![credentialRef.env]!}})).json()).toEqual({error:"conflicting_secret_reference"});expect(result.sequence).toBe(1);
});
it("preserves configuration conflict classification while loading a changing owned inventory",async()=>{
  const f=await fixture();let version=0;
  const db={prepare:(query:string)=>query.startsWith("SELECT version FROM configuration_versions")?{bind:()=>({first:async()=>({version:++version})})}:env.DB.prepare(query),batch:(statements:D1PreparedStatement[])=>env.DB.batch(statements)} as unknown as D1Database;
  await expect(resolveOwnedDeploymentManifest({...env,DB:db},f.userId,f.deployment.id,body(f.exported))).rejects.toMatchObject({name:"ConfigurationConflict"});
});
it("returns private-safe API errors for unavailable storage without partial writes",async()=>{
  const f=await fixture();
  for(const failure of [new Error("D1_ERROR: overloaded private storage detail"),"opaque-private-storage-failure"]){
    let batches=0;const db={prepare:(query:string)=>env.DB.prepare(query),batch:(statements:D1PreparedStatement[])=>{if(++batches===3)throw failure;return env.DB.batch(statements);}} as unknown as D1Database;
    const response=await worker.fetch(new Request(`https://local.test/api/deployments/${f.deployment.id}/config`,{method:"PUT",headers:{cookie:f.sessionCookie},body:JSON.stringify(body(f.exported))}),{...env,DB:db} as Env,createExecutionContext());
    expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"configuration_unavailable"});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.exported.configurationVersion);
  }
  const unavailable={prepare:(query:string)=>{if(query.includes("SELECT * FROM deployments WHERE id"))throw new Error("D1_ERROR: overloaded");return env.DB.prepare(query);}} as unknown as D1Database;
  const response=await worker.fetch(new Request(`https://local.test/api/deployments/${f.deployment.id}/config`,{method:"PUT",headers:{cookie:f.sessionCookie},body:"{}"}),{...env,DB:unavailable} as Env,createExecutionContext());expect(response.status).toBe(503);
});
it("rejects missing or failed request streams and never redirects unauthenticated configuration requests",async()=>{
  const f=await fixture(),url=`https://local.test/api/deployments/${f.deployment.id}/config`;
  const missing=await worker.fetch(new Request(url,{method:"PUT",headers:{cookie:f.sessionCookie}}),env as Env,createExecutionContext());expect(await missing.json()).toEqual({error:"invalid_push"});
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.error(new Error("private stream failure"));}});
  const failed=await worker.fetch(new Request(url,{method:"PUT",headers:{cookie:f.sessionCookie},body:stream}),env as Env,createExecutionContext());expect(await failed.json()).toEqual({error:"invalid_push"});
  for(const method of ["GET","PUT"]){const response=await SELF.fetch(url,{method,redirect:"manual"});expect(response.status).toBe(401);expect(response.headers.get("cache-control")).toBe("no-store");expect(response.headers.get("location")).toBeNull();}
  await env.DB.prepare("UPDATE cli_account_tokens SET expires_at=1 WHERE user_id=?").bind(f.userId).run();const expired=await put(f,body(f.exported));expect(expired.status).toBe(401);expect(expired.headers.get("cache-control")).toBe("no-store");
});
it.each([1,2])("preserves renewal between resolver and transaction read phase %s",async phase=>{
  const f=await fixture("supabase-edge-logs"),before=(await getConnection(env.DB,f.userId,f.connection.id))!,renewed={pat:"concurrent-renewed",refreshToken:"concurrent-refresh",expiresAt:Date.now()+120_000},request=body(f.exported);request.document=structuredClone(request.document);request.document.connections[0]!.connection.displayName="Updated label";
  let batches=0;const db={prepare:(query:string)=>env.DB.prepare(query),batch:async(statements:D1PreparedStatement[])=>{const result=await env.DB.batch(statements);if(++batches===phase)expect(await refreshConnectionCredentials(env.DB,env,before,renewed)).toBe(true);return result;}} as unknown as D1Database;
  const response=await worker.fetch(new Request(`https://local.test/api/deployments/${f.deployment.id}/config`,{method:"PUT",headers:{cookie:f.sessionCookie},body:JSON.stringify(request)}),{...env,DB:db} as Env,createExecutionContext());expect(response.status).toBe(200);
  const after=(await getConnection(env.DB,f.userId,f.connection.id))!;expect(after.display_name).toBe("Updated label");expect(after.credential_version).toBe(before.credential_version);expect(await decryptConnectionCredentials(env,after)).toEqual(renewed);
  const committed=await response.json() as any;expect(committed.document.connections[0].credentials).toEqual(f.exported.document.connections[0]!.credentials);
});
