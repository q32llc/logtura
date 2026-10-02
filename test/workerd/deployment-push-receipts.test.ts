import { env,SELF } from "cloudflare:test";
import { expect,it,afterEach } from "vitest";
import { LogturaServiceClient,createSecretVersioner,editDeploymentManifest,type DeploymentConfigPush } from "@logtura/core";
import { seedUser,mockFetch } from "./_setup";
import { createConnection,createDeployment,upsertSources,getConnection,decryptConnectionCredentials,deleteDeployment } from "../../src/db";
import { hashCliSecret } from "../../src/cli-auth";
import { newToken } from "../../src/crypto";
import { readConfigurationVersion } from "../../src/config-version";
import { readDeploymentConfiguration } from "../../src/deployment-configuration";
import { createPushReceiptIntent,readPushReceipt,compilePushReceipt,PushReceiptConflict,PushReceiptUnavailable } from "../../src/deployment-push-receipts";
import { parseDeploymentPush } from "../../src/deployment-push";
import worker from "../../src/index";
import type { Env } from "../../src/env";
afterEach(async()=>{await env.DB.exec("DROP TRIGGER IF EXISTS fail_receipt");});
async function fixture(){
 const user=await seedUser(),connection=await createConnection(env.DB,env,{userId:user.userId,provider:"cloudflare-worker-tail",displayName:"Account",externalAccountId:"account",credentials:{apiToken:"original-private"}});
 await upsertSources(env.DB,connection.id,[{sourceKind:"cf_worker",externalId:"site",displayName:"Site",metadata:null}]);
 const deployment=await createDeployment(env.DB,{userId:user.userId,connectionId:connection.id,targetKind:"other",displayName:"Existing",heartbeatTarget:"none"}),token=`lt_cli_${newToken()}`;
 await env.DB.prepare("INSERT INTO cli_account_tokens(id,user_id,token_hash,label,created_at,expires_at) VALUES (?,?,?,?,?,?)").bind(`tok_${connection.id}`,user.userId,await hashCliSecret(token),"Test",Date.now(),Date.now()+60_000).run();
 mockFetch("https://api.cloudflare.com",()=>Response.json({success:true,result:{status:"active"}}));
 const client=new LogturaServiceClient({url:"https://local.test",token,fetch:(url,init)=>SELF.fetch(url,init)}),exported=await client.pullDeploymentConfig(deployment.id,true);
 const body:DeploymentConfigPush={document:exported.document,expectedConfigurationVersion:exported.configurationVersion!,expectedSequence:exported.desiredSequence!,requestId:crypto.randomUUID()};return {...user,connection,deployment,token,client,exported,body};
}
async function put(f:Awaited<ReturnType<typeof fixture>>,body:unknown=f.body){return SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}/config`,{method:"PUT",headers:{authorization:`Bearer ${f.token}`},body:JSON.stringify(body)});}
it("recovers a lost successful response from an immutable owned receipt and never reapplies a stale request",async()=>{
 const f=await fixture();f.body.document.connections[0]!.connection.displayName="CLI label";
 const response=await put(f);expect(response.status).toBe(200);const result=await response.json();
 const receipt=await f.client.getDeploymentPushReceipt(f.deployment.id,f.body.requestId!);expect(receipt).toEqual({requestId:f.body.requestId,result});
 await env.DB.prepare("UPDATE connections SET display_name=? WHERE id=? AND user_id=?").bind("Website label",f.connection.id,f.userId).run();const version=await readConfigurationVersion(env.DB,f.userId);
 expect(await (await put(f)).json()).toEqual(result);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version);expect((await getConnection(env.DB,f.userId,f.connection.id))!.display_name).toBe("Website label");
 const reused=await put(f,{...f.body,document:{...f.body.document,discoverMonitors:!f.body.document.discoverMonitors}});expect(reused.status).toBe(409);expect(await reused.json()).toEqual({error:"request_id_reused"});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version);
 const row=await env.DB.prepare("SELECT * FROM deployment_push_receipts WHERE deployment_id=?").bind(f.deployment.id).first<any>();expect(row.configuration_version).toBe((result as any).configurationVersion);expect(row.request_hash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(row)).not.toContain("original-private");
 await expect(env.DB.prepare("UPDATE deployment_push_receipts SET sequence=99 WHERE deployment_id=?").bind(f.deployment.id).run()).rejects.toThrow("LOGT_PUSH_RECEIPT_IMMUTABLE");expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version);
});
it("deduplicates concurrent identical requests and rejects concurrent request identity reuse",async()=>{
 const f=await fixture(),responses=await Promise.all([put(f),put(f)]);expect(responses.map(r=>r.status)).toEqual([200,200]);expect(await responses[0]!.json()).toEqual(await responses[1]!.json());expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.desired.sequence).toBe(1);expect(await env.DB.prepare("SELECT COUNT(*) FROM deployment_push_receipts WHERE deployment_id=?").bind(f.deployment.id).first("COUNT(*)")).toBe(1);
 const other=await fixture(),left=structuredClone(other.body),right=structuredClone(other.body);left.document.connections[0]!.connection.displayName="Left";right.document.connections[0]!.connection.displayName="Right";
 expect((await Promise.all([put(other,left),put(other,right)])).map(r=>r.status).sort()).toEqual([200,409]);expect((await readDeploymentConfiguration(env.DB,other.userId,other.deployment.id))!.desired.sequence).toBe(1);
});
it("records new no-op receipts without advancing graph version or desired sequence",async()=>{
 const f=await fixture(),first=await f.client.pushDeploymentConfig(f.deployment.id,f.body),body={...f.body,document:first.document,expectedConfigurationVersion:first.configurationVersion,expectedSequence:first.sequence,requestId:crypto.randomUUID()};
 const responses=await Promise.all([put(f,body),put(f,body)]);expect(responses.map(r=>r.status)).toEqual([200,200]);expect(await responses[0]!.json()).toEqual(first);expect(await responses[1]!.json()).toEqual(first);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(first.configurationVersion);expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.desired.sequence).toBe(first.sequence);expect((await f.client.getDeploymentPushReceipt(f.deployment.id,body.requestId))!.result).toEqual(first);
});
it("binds explicit uploads into a keyed fingerprint and treats equivalent JSON formatting as the same request",async()=>{
 const f=await fixture(),edited=await editDeploymentManifest(f.body.document,f.exported.secretValues!,[{kind:"connection.update",id:f.connection.id,patch:{},credentials:{apiToken:"uploaded-private"}}],await createSecretVersioner("local-private")),body={...f.body,document:edited.document,uploadSecrets:true,secretValues:edited.secretValues};
 const first=await f.client.pushDeploymentConfig(f.deployment.id,body),formatted={...body,secretValues:Object.fromEntries(Object.entries(body.secretValues).map(([name,value])=>[name,JSON.stringify(JSON.parse(value),null,2)]))};expect(await f.client.pushDeploymentConfig(f.deployment.id,formatted)).toEqual(first);
 expect(await decryptConnectionCredentials(env,(await getConnection(env.DB,f.userId,f.connection.id))!)).toEqual({apiToken:"uploaded-private"});
 const row=await env.DB.prepare("SELECT * FROM deployment_push_receipts WHERE deployment_id=?").bind(f.deployment.id).first<any>();expect(JSON.stringify(row)).not.toContain("uploaded-private");expect(JSON.stringify(await f.client.getDeploymentPushReceipt(f.deployment.id,body.requestId!))).not.toContain("uploaded-private");
 const ref=body.document.connections[0]!.credentials!;const response=await put(f,{...body,secretValues:{...body.secretValues,[ref.env]:JSON.stringify({apiToken:"different-private"})}});expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"request_id_reused"});
});
it("rolls back the complete graph/history when receipt insertion fails",async()=>{
 const f=await fixture();await env.DB.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON deployment_push_receipts BEGIN SELECT RAISE(ABORT, 'D1_ERROR receipt unavailable'); END;");f.body.document.connections[0]!.connection.displayName="Must roll back";
 const response=await put(f);expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"configuration_unavailable"});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.body.expectedConfigurationVersion);expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toBeNull();expect((await getConnection(env.DB,f.userId,f.connection.id))!.display_name).toBe("Account");expect(await f.client.getDeploymentPushReceipt(f.deployment.id,f.body.requestId!)).toBeNull();
});
it("enforces receipt ownership, account authorization, no-store responses and deletion lifetime",async()=>{
 const f=await fixture(),other=await fixture();await put(f);const url=`https://local.test/api/deployments/${f.deployment.id}/config/receipts/${f.body.requestId}`;
 for(const headers of [{},{authorization:`Bearer ${f.deployment.heartbeat_token}`}]){const response=await SELF.fetch(url,{headers});expect(response.status).toBe(401);expect(await response.json()).toEqual({error:"auth_required"});expect(response.headers.get("cache-control")).toBe("no-store");expect(response.headers.get("location")).toBeNull();}
 const foreign=await SELF.fetch(url,{headers:{authorization:`Bearer ${other.token}`}});expect(foreign.status).toBe(404);expect(await foreign.json()).toEqual({error:"not_found"});expect(await readPushReceipt(env.DB,other.userId,f.deployment.id,f.body.requestId!)).toBeNull();
 const cookie=await SELF.fetch(url,{headers:{cookie:f.sessionCookie}});expect(cookie.status).toBe(200);expect(cookie.headers.get("cache-control")).toBe("no-store");expect(await f.client.getDeploymentPushReceipt(f.deployment.id,crypto.randomUUID())).toBeNull();
 await deleteDeployment(env.DB,f.userId,f.deployment.id);expect(await env.DB.prepare("SELECT COUNT(*) FROM deployment_push_receipts WHERE deployment_id=?").bind(f.deployment.id).first("COUNT(*)")).toBe(0);await expect(f.client.getDeploymentPushReceipt(f.deployment.id,f.body.requestId!)).rejects.toMatchObject({status:404,code:"not_found"});
});
it("rejects malformed receipt identities and private JSON without writes",async()=>{
 const f=await fixture();for(const requestId of [null,12,"bad","AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]){expect(()=>parseDeploymentPush({...f.body,requestId})).toThrow("invalid_request_id");expect(await (await put(f,{...f.body,requestId})).json()).toEqual({error:"invalid_request_id"});}
 await expect(createPushReceiptIntent(env,f.userId,f.deployment.id,{...f.body,requestId:"bad"})).rejects.toThrow("invalid_request_id");await expect(readPushReceipt(env.DB,f.userId,f.deployment.id,"bad")).rejects.toThrow("invalid_request_id");
 const invalid=await SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}/config/receipts/bad`,{headers:{authorization:`Bearer ${f.token}`}});expect(invalid.status).toBe(400);expect(await invalid.json()).toEqual({error:"invalid_request_id"});
 const ref=f.body.document.connections[0]!.credentials!;expect(await (await put(f,{...f.body,uploadSecrets:true,secretValues:{[ref.env]:"not-json-private"}})).json()).toEqual({error:"invalid_secret_values"});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.body.expectedConfigurationVersion);expect(await env.DB.prepare("SELECT COUNT(*) FROM deployment_push_receipts WHERE deployment_id=?").bind(f.deployment.id).first("COUNT(*)")).toBe(0);
 expect(await createPushReceiptIntent(env,f.userId,f.deployment.id,{...f.body,requestId:undefined})).toBeUndefined();
 const intent=await createPushReceiptIntent(env,f.userId,f.deployment.id,f.body);expect(intent).toEqual(await createPushReceiptIntent(env,f.userId,f.deployment.id,{...f.body,uploadSecrets:false,secretValues:{}}));
 expect(()=>compilePushReceipt(env.DB,f.userId,f.deployment.id,{requestId:"bad",requestHash:"a".repeat(64)},{sequence:1,revision:"hash",document:f.body.document,sourceAliases:{}})).toThrow("invalid_request_id");expect(()=>compilePushReceipt(env.DB,f.userId,f.deployment.id,{requestId:f.body.requestId!,requestHash:"bad"},{sequence:1,revision:"hash",document:f.body.document,sourceAliases:{}})).toThrow("invalid_request_id");
});
it("sanitizes unavailable or corrupt receipt storage and does not expose bound values",async()=>{
 const f=await fixture(),fake={prepare:()=>({bind(){return this;},first:async()=>{throw new Error("D1_ERROR private-receipt-data");}})} as unknown as D1Database;await expect(readPushReceipt(fake,f.userId,f.deployment.id,f.body.requestId!)).rejects.toBeInstanceOf(PushReceiptUnavailable);
 await put(f);const row=await env.DB.prepare("SELECT * FROM deployment_push_receipts WHERE deployment_id=?").bind(f.deployment.id).first<any>();await expect(readPushReceipt(env.DB,f.userId,f.deployment.id,f.body.requestId!,"wrong")).rejects.toBeInstanceOf(PushReceiptConflict);
 for(const patch of [{request_hash:"broken-private"},{document_json:"broken-private"},{source_aliases_json:"broken-private"},{sequence:0}]){
 const corrupt={prepare:()=>({bind(){return this;},first:async()=>({...row,...patch})})} as unknown as D1Database;await expect(readPushReceipt(corrupt,f.userId,f.deployment.id,f.body.requestId!)).rejects.toThrow("Push receipt unavailable");
 }
 const unavailable={prepare:(sql:string)=>sql.includes("FROM deployments")?{bind(){return this;},first:()=>{throw new Error("private-storage");}}:env.DB.prepare(sql)} as unknown as D1Database;
 const response=await worker.fetch(new Request(`https://local.test/api/deployments/${f.deployment.id}/config/receipts/${f.body.requestId}`,{headers:{cookie:f.sessionCookie}}),{...env,DB:unavailable} as Env,{} as ExecutionContext);expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"configuration_unavailable"});expect(response.headers.get("cache-control")).toBe("no-store");
});
it("recovers through the SDK when the transport drops a committed write response",async()=>{
 const f=await fixture();f.body.document.connections[0]!.connection.displayName="Lost response label";
 const uncertain=new LogturaServiceClient({url:"https://local.test",token:f.token,fetch:async(url,init)=>{
  const response=await SELF.fetch(url,init);if(init?.method==="PUT"){await response.arrayBuffer();throw new Error("response dropped after commit");}return response;
 }});
 await expect(uncertain.pushDeploymentConfig(f.deployment.id,f.body)).rejects.toThrow("response dropped after commit");
 const receipt=await uncertain.getDeploymentPushReceipt(f.deployment.id,f.body.requestId!);expect(receipt).not.toBeNull();expect(receipt!.result.document.connections[0]!.connection.displayName).toBe("Lost response label");expect(receipt!.result.sequence).toBe(1);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(receipt!.result.configurationVersion);
 expect(await f.client.pushDeploymentConfig(f.deployment.id,f.body)).toEqual(receipt!.result);expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.desired.sequence).toBe(1);
});
