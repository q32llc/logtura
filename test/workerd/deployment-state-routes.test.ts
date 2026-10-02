import { SELF,env,createExecutionContext } from "cloudflare:test";
import { expect,it,afterEach } from "vitest";
import { LogturaServiceClient,DeploymentReportingClient,compileForwarderRuntime,reportLoadedForwarder,hashConfigDocument,exportDeploymentManifest,createSecretVersioner,type DeploymentInstanceActivation } from "@logtura/core";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { createConnection,createDeployment } from "../../src/db";
import { newId } from "../../src/crypto";
import { hashCliSecret } from "../../src/cli-auth";
import { issueDeploymentConfiguration,readDeploymentConfiguration } from "../../src/deployment-configuration";
import { readConfigurationVersion } from "../../src/config-version";
import { activateDeploymentWithReceipt,readDeploymentInstanceReceipt } from "../../src/deployment-instances";
import { listProviders } from "../../src/providers";
import { listDestinationDrivers } from "../../src/destinations";
import { seedUser } from "./_setup";
afterEach(async()=>{await env.DB.exec("DROP TRIGGER IF EXISTS instance_receipt_failure");});
async function fixture(issue=true){
 const user=await seedUser(),con=await createConnection(env.DB,env,{userId:user.userId,provider:"cloudflare-worker-tail",displayName:"Account",externalAccountId:"account",credentials:{apiToken:"private-grant"}}),dep=await createDeployment(env.DB,{userId:user.userId,connectionId:con.id,targetKind:"fly",displayName:"Forwarder"});
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[{connection:{id:con.id,provider:con.provider,displayName:con.display_name,externalAccountId:"account"},credentials:{apiToken:"private-grant"},selectedSources:[]}],monitors:[]},await createSecretVersioner("private-key"));
 const version=await readConfigurationVersion(env.DB,user.userId),issued=issue?await issueDeploymentConfiguration(env.DB,user.userId,dep.id,version,0,exported.document):{configurationVersion:version,sequence:0,revision:await hashConfigDocument(exported.document)};
 const deviceHash=newId("device"),accountToken=`lt_cli_${deviceHash.padEnd(43,"T").slice(0,43)}`;
 await env.DB.prepare("INSERT INTO cli_account_tokens(id,user_id,token_hash,device_hash,label,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").bind(newId("cli"),user.userId,await hashCliSecret(accountToken),deviceHash,"Test",Date.now(),Date.now()+60_000).run();
 const intent:DeploymentInstanceActivation={requestId:crypto.randomUUID(),expectedConfigurationVersion:issued.configurationVersion,expectedSequence:Math.max(1,issued.sequence),revision:issued.revision,expectedInstanceId:null};
 const fetch:typeof globalThis.fetch=(input,init)=>SELF.fetch(new Request(input,init));
 const client=new LogturaServiceClient({url:"https://local.test",token:accountToken,fetch}),reporting=new DeploymentReportingClient({url:"https://local.test",token:dep.heartbeat_token!,fetch});
 return {...user,con,dep,issued,intent,client,reporting,accountToken,exported};
}
async function activate(f:Awaited<ReturnType<typeof fixture>>,body:unknown=f.intent,headers:HeadersInit={cookie:f.sessionCookie}){return SELF.fetch(`https://local.test/api/deployments/${f.dep.id}/config/instances`,{method:"POST",headers,body:JSON.stringify(body)});}
it("exposes legacy/desired/applied state and durably recovers activation after a lost response",async()=>{
 const f=await fixture(false);expect(await f.client.getDeploymentConfigurationState(f.dep.id)).toBeNull();expect((await activate(f)).status).toBe(409);
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner("key"));const issued=await issueDeploymentConfiguration(env.DB,f.userId,f.dep.id,f.issued.configurationVersion,0,exported.document);f.intent={...f.intent,expectedConfigurationVersion:issued.configurationVersion,revision:issued.revision};
 let writes=0;const lost=new LogturaServiceClient({url:"https://local.test",token:f.accountToken,fetch:async(input,init)=>{const response=await SELF.fetch(new Request(input,init));if(init?.method==="POST"){writes++;if(response.ok){await response.arrayBuffer();throw new Error("Response lost after commit");}}return response;}});
 await expect(lost.activateDeploymentInstance(f.dep.id,f.intent)).rejects.toThrow("Response lost");const receipt=await f.client.getDeploymentInstanceReceipt(f.dep.id,f.intent.requestId);expect(receipt).toMatchObject({requestId:f.intent.requestId,sequence:1,revision:issued.revision});expect(writes).toBe(1);
 expect(await f.client.activateDeploymentInstance(f.dep.id,f.intent)).toEqual(receipt);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(issued.configurationVersion);
 const report={instanceId:receipt!.instanceId,sequence:1,revision:issued.revision,reportSequence:1};expect(await f.reporting.reportApplied(f.dep.id,report)).toBe(true);expect(await f.reporting.reportApplied(f.dep.id,report)).toBe(false);
 const state=await f.client.getDeploymentConfigurationState(f.dep.id);expect(state).toMatchObject({desired:{sequence:1},applied:{sequence:1,revision:issued.revision,at:expect.any(Number)},activeInstanceId:receipt!.instanceId,lastReportSequence:1,stale:false});expect(JSON.stringify(state)).not.toContain("private-grant");
});
it("fences instances, desired revisions and website configuration while immutable receipts stay historical",async()=>{
 const f=await fixture(),first=await f.client.activateDeploymentInstance(f.dep.id,f.intent);
 const second=await f.client.activateDeploymentInstance(f.dep.id,{...f.intent,requestId:crypto.randomUUID(),expectedInstanceId:first.instanceId});
 expect(await f.client.activateDeploymentInstance(f.dep.id,f.intent)).toEqual(first);expect((await f.client.getDeploymentConfigurationState(f.dep.id))!.activeInstanceId).toBe(second.instanceId);
 expect(await f.reporting.reportApplied(f.dep.id,{instanceId:first.instanceId,sequence:1,revision:first.revision,reportSequence:100})).toBe(false);
 expect(await f.reporting.reportApplied(f.dep.id,{instanceId:second.instanceId,sequence:1,revision:second.revision,reportSequence:2})).toBe(true);
 expect(await f.reporting.reportApplied(f.dep.id,{instanceId:second.instanceId,sequence:1,revision:second.revision,reportSequence:1})).toBe(false);
 for(const patch of [{expectedInstanceId:null},{expectedSequence:2},{revision:`sha256:${"a".repeat(64)}`}])expect((await activate(f,{...f.intent,...patch,requestId:crypto.randomUUID()})).status).toBe(409);
 expect((await activate(f,{...f.intent,expectedInstanceId:second.instanceId})).status).toBe(409);
 await env.DB.prepare("UPDATE connections SET display_name='Website edit' WHERE id=?").bind(f.con.id).run();expect((await f.client.getDeploymentConfigurationState(f.dep.id))!.stale).toBe(true);
 expect((await activate(f,{...f.intent,requestId:crypto.randomUUID(),expectedInstanceId:second.instanceId})).status).toBe(409);
 const version=await readConfigurationVersion(env.DB,f.userId);expect((await activate(f,{...f.intent,expectedConfigurationVersion:version,requestId:crypto.randomUUID(),expectedInstanceId:second.instanceId})).status).toBe(409);
 expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version);
});
it("serializes identical concurrent activations and rejects conflicting reuse without rotating twice",async()=>{
 const f=await fixture(),responses=await Promise.all([activate(f),activate(f)]);expect(responses.map(r=>r.status)).toEqual([200,200]);const receipts=await Promise.all(responses.map(r=>r.json()));expect(receipts[0]).toEqual(receipts[1]);
 expect((await activate(f,{...f.intent,revision:`sha256:${"b".repeat(64)}`})).status).toBe(409);
 expect(await env.DB.prepare("SELECT COUNT(*) FROM deployment_instance_receipts WHERE deployment_id=?").bind(f.dep.id).first("COUNT(*)")).toBe(1);
});
it("denies foreign ownership, sessions/account tokens on reporting, and reporting tokens on account operations",async()=>{
 const f=await fixture(),other=await seedUser(),base=`https://local.test/api/deployments/${f.dep.id}/config`;
 for(const suffix of ["/state",`/instances/${f.intent.requestId}`])for(const [headers,status] of [[{},401],[{authorization:`Bearer ${f.dep.heartbeat_token}`},401],[{cookie:other.sessionCookie},404]] as const){const response=await SELF.fetch(base+suffix,{headers,redirect:"manual"});expect(response.status).toBe(status);expect(response.headers.get("cache-control")).toBe("no-store");}
 for(const [headers,status] of [[{},401],[{authorization:`Bearer ${f.dep.heartbeat_token}`},401],[{cookie:other.sessionCookie},404]] as const)expect((await activate(f,f.intent,headers)).status).toBe(status);
 for(const headers of [{},{cookie:f.sessionCookie},{authorization:`Bearer ${f.accountToken}`},{authorization:"Bearer wrong"}])expect((await SELF.fetch(`https://local.test/api/applied/${f.dep.id}`,{method:"POST",headers,body:"{}"})).status).toBe(401);
 expect((await SELF.fetch(`https://local.test/api/deployments/missing/config/state`,{headers:{cookie:f.sessionCookie}})).status).toBe(404);
 expect((await SELF.fetch(`https://local.test/api/deployments/missing/config/instances/${f.intent.requestId}`,{headers:{cookie:f.sessionCookie}})).status).toBe(404);
 expect((await SELF.fetch(`https://local.test/api/applied/missing`,{method:"POST",headers:{authorization:`Bearer ${f.dep.heartbeat_token}`},body:"{}"})).status).toBe(401);
});
it("validates bounded streamed activation/report bodies without reflecting private input",async()=>{
 const f=await fixture(),base=`https://local.test/api/deployments/${f.dep.id}/config`,reportUrl=`https://local.test/api/applied/${f.dep.id}`;
 for(const body of [undefined,"bad-private-json","{}",JSON.stringify({...f.intent,extra:"private"}),"x".repeat(8193)]){const response=await worker.fetch(new Request(base+"/instances",{method:"POST",headers:{cookie:f.sessionCookie},body}),env as Env,createExecutionContext());expect(response.status).toBe(body && body.length>8192?413:400);expect(await response.text()).not.toContain("private");}
 for(const body of [undefined,"bad-private-json","{}","x".repeat(8193)]){const response=await worker.fetch(new Request(reportUrl,{method:"POST",headers:{authorization:`Bearer ${f.dep.heartbeat_token}`},body}),env as Env,createExecutionContext());expect(response.status).toBe(body && body.length>8192?413:400);expect(await response.text()).not.toContain("private");}
 const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode("x".repeat(5000)));controller.enqueue(new TextEncoder().encode("x".repeat(5000)));controller.close();}});
 expect((await worker.fetch(new Request(base+"/instances",{method:"POST",headers:{cookie:f.sessionCookie,"content-length":"1"},body:stream}),env as Env,createExecutionContext())).status).toBe(413);
 const broken=new ReadableStream<Uint8Array>({pull(controller){controller.error(new Error("private-stream-failure"));}});
 const failed=await worker.fetch(new Request(base+"/instances",{method:"POST",headers:{cookie:f.sessionCookie},body:broken}),env as Env,createExecutionContext());expect(failed.status).toBe(400);expect(await failed.text()).not.toContain("private-stream-failure");
 expect((await SELF.fetch(base+"/instances/bad",{headers:{cookie:f.sessionCookie}})).status).toBe(400);
 expect(await f.client.getDeploymentInstanceReceipt(f.dep.id,crypto.randomUUID())).toBeNull();
 await expect(activateDeploymentWithReceipt(env.DB,f.userId,f.dep.id,{})).rejects.toMatchObject({status:400});
});
it("atomically rolls back instance replacement when receipt storage fails, sanitizes outages and corrupt receipts",async()=>{
 const f=await fixture(),before=await readDeploymentConfiguration(env.DB,f.userId,f.dep.id);
 await env.DB.exec("CREATE TRIGGER instance_receipt_failure BEFORE INSERT ON deployment_instance_receipts BEGIN SELECT RAISE(ABORT,'private-storage-detail'); END");const failed=await activate(f);expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("private-storage-detail");expect(await readDeploymentConfiguration(env.DB,f.userId,f.dep.id)).toEqual(before);
 await env.DB.exec("DROP TRIGGER instance_receipt_failure");const receipt=await f.client.activateDeploymentInstance(f.dep.id,f.intent);await expect(env.DB.prepare("UPDATE deployment_instance_receipts SET instance_id='bad' WHERE deployment_id=?").bind(f.dep.id).run()).rejects.toThrow("LOGT_INSTANCE_RECEIPT_IMMUTABLE");
 const db={...env.DB,prepare(sql:string){if(/deployments|deployment_configuration|deployment_instance/.test(sql))throw new Error("private-storage-detail");return env.DB.prepare(sql);}} as D1Database;
 for(const [path,method,headers,body] of [[`/deployments/${f.dep.id}/config/state`,"GET",{cookie:f.sessionCookie},undefined],[`/deployments/${f.dep.id}/config/instances/${f.intent.requestId}`,"GET",{cookie:f.sessionCookie},undefined],[`/applied/${f.dep.id}`,"POST",{authorization:`Bearer ${f.dep.heartbeat_token}`},"{}"]] as const){const response=await worker.fetch(new Request("https://local.test/api"+path,{method,headers,body}),{...env,DB:db} as Env,createExecutionContext());expect(response.status).toBe(503);expect(await response.text()).not.toContain("private-storage-detail");}
 await env.DB.prepare("DELETE FROM deployment_instance_receipts WHERE deployment_id=?").bind(f.dep.id).run();
 for(const [request_json,instance_id,configuration_version,sequence,revision] of [["broken",receipt.instanceId,receipt.configurationVersion,1,receipt.revision],[JSON.stringify({...f.intent,requestId:crypto.randomUUID()}),receipt.instanceId,receipt.configurationVersion,1,receipt.revision],[JSON.stringify(f.intent),"bad",receipt.configurationVersion,1,receipt.revision],[JSON.stringify(f.intent),receipt.instanceId,receipt.configurationVersion+1,1,receipt.revision],[JSON.stringify(f.intent),receipt.instanceId,receipt.configurationVersion,2,receipt.revision],[JSON.stringify(f.intent),receipt.instanceId,receipt.configurationVersion,1,`sha256:${"c".repeat(64)}`]] as const){
  await env.DB.prepare("INSERT INTO deployment_instance_receipts(deployment_id,user_id,request_id,request_json,instance_id,configuration_version,sequence,revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(f.dep.id,f.userId,f.intent.requestId,request_json,instance_id,configuration_version,sequence,revision,1).run();expect((await SELF.fetch(`https://local.test/api/deployments/${f.dep.id}/config/instances/${f.intent.requestId}`,{headers:{cookie:f.sessionCookie}})).status).toBe(503);await env.DB.prepare("DELETE FROM deployment_instance_receipts WHERE deployment_id=?").bind(f.dep.id).run();
 }
 expect(await readDeploymentInstanceReceipt(env.DB,f.userId,f.dep.id,f.intent.requestId)).toBeNull();
});
it("honors reporting token rotation immediately and ignores unknown revisions without changing graph versions",async()=>{
 const f=await fixture(),receipt=await f.client.activateDeploymentInstance(f.dep.id,f.intent),report={instanceId:receipt.instanceId,sequence:receipt.sequence,revision:receipt.revision,reportSequence:1};
 expect(await f.reporting.reportApplied(f.dep.id,{...report,revision:`sha256:${"d".repeat(64)}`})).toBe(false);expect(await f.reporting.reportApplied(f.dep.id,{...report,sequence:2})).toBe(false);
 await env.DB.prepare("UPDATE deployments SET heartbeat_token='rotated-report-token' WHERE id=?").bind(f.dep.id).run();await expect(f.reporting.reportApplied(f.dep.id,report)).rejects.toMatchObject({status:401});
 const afterRotation=await readConfigurationVersion(env.DB,f.userId);const reporting=new DeploymentReportingClient({url:"https://local.test",token:"rotated-report-token",fetch:(input,init)=>SELF.fetch(new Request(input,init))});expect(await reporting.reportApplied(f.dep.id,report)).toBe(true);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(afterRotation);
 await env.DB.prepare("DELETE FROM deployments WHERE id=?").bind(f.dep.id).run();expect(await env.DB.prepare("SELECT COUNT(*) FROM deployment_instance_receipts WHERE deployment_id=?").bind(f.dep.id).first("COUNT(*)")).toBe(0);
});

it("recovers the shared verified-report engine through the real reporting API after acknowledgement loss",async()=>{
 const f=await fixture(),instance=await f.client.activateDeploymentInstance(f.dep.id,f.intent);
 const {artifact,bundle}=await compileForwarderRuntime({service:"https://local.test",deploymentId:f.dep.id,document:f.exported.document,instance,env:f.exported.secretValues,providers:listProviders(),destinations:listDestinationDrivers()});
 const observed={ready:true,generatorVersion:artifact.generatorVersion,vectorVersion:artifact.vectorVersion,files:{"vector.yaml":bundle.vectorYaml,...Object.fromEntries(bundle.runtimeAssets.map(asset=>[`assets/${asset.driverId}/${asset.path}`,asset.content]))},environment:Object.fromEntries(bundle.envVars.map(v=>[v.name,v.value??undefined]))};
 let checkpoint:unknown=null,writes=0;const store={load:async()=>checkpoint,save:async(value:unknown)=>{checkpoint=structuredClone(value);}};
 await expect(reportLoadedForwarder({artifact,observed,store,report:async body=>{writes++;expect(await f.reporting.reportApplied(f.dep.id,body)).toBe(true);throw new Error("Acknowledgement lost");}})).rejects.toThrow("Acknowledgement lost");
 expect(checkpoint).toMatchObject({lastReportSequence:0,pending:{reportSequence:1}});
 expect(await reportLoadedForwarder({artifact,observed,store,report:body=>{writes++;return f.reporting.reportApplied(f.dep.id,body);}})).toEqual({reportSequence:1,accepted:false});
 expect(writes).toBe(2);expect(checkpoint).toMatchObject({lastReportSequence:1,pending:null,lastAccepted:false});expect(await f.client.getDeploymentConfigurationState(f.dep.id)).toMatchObject({applied:{sequence:1,revision:instance.revision},lastReportSequence:1});
});
