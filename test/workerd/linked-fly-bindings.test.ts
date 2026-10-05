import {SELF,env} from "cloudflare:test";
import {afterEach,expect,it} from "vitest";
import {LogturaServiceClient,exportDeploymentManifest,createSecretVersioner,type FlyBindingRequest} from "@logtura/core";
import {createConnection,createDeployment,getDeployment} from "../../src/db";
import {readConfigurationVersion} from "../../src/config-version";
import {issueDeploymentConfiguration,readDeploymentConfiguration,acknowledgeDeploymentConfiguration} from "../../src/deployment-configuration";
import {activateDeploymentWithReceipt} from "../../src/deployment-instances";
import {bindLinkedFlyReplacement,readFlyBindingReceipt} from "../../src/linked-fly-bindings";
import {exportDeploymentTarget} from "../../src/deployment-target";
import {hashCliSecret} from "../../src/cli-auth";
import {newId} from "../../src/crypto";
import {seedUser} from "./_setup";

const hash=(c:string)=>`sha256:${c.repeat(64)}`;
afterEach(async()=>{await env.DB.exec("DROP TRIGGER IF EXISTS binding_injected_failure");});
async function fixture(){
 const user=await seedUser(),connection=await createConnection(env.DB,env,{userId:user.userId,provider:"cloudflare-worker-tail",displayName:"Site",externalAccountId:"account",credentials:{apiToken:"private-source"}});
 const deployment=await createDeployment(env.DB,{userId:user.userId,connectionId:connection.id,targetKind:"fly",displayName:"Forwarder"});
 await env.DB.prepare("UPDATE deployments SET external_id='fly:app:abc123',image_digest=?,metadata_json=? WHERE id=?").bind(hash("a"),JSON.stringify({appName:"app",region:"iad",orgSlug:"personal",keep:"preserved"}),deployment.id).run();
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner("private-version-key"));
 const issued=await issueDeploymentConfiguration(env.DB,user.userId,deployment.id,await readConfigurationVersion(env.DB,user.userId),0,exported.document);
 const activation=await activateDeploymentWithReceipt(env.DB,user.userId,deployment.id,{requestId:crypto.randomUUID(),expectedConfigurationVersion:issued.configurationVersion,expectedSequence:issued.sequence,revision:issued.revision,expectedInstanceId:null});
 const request:FlyBindingRequest={requestId:crypto.randomUUID(),instanceId:activation.instanceId,expectedConfigurationVersion:issued.configurationVersion,expectedSequence:issued.sequence,revision:issued.revision,appName:"app",orgSlug:"personal",region:"iad",previousMachineId:"abc123",expectedImageDigest:hash("a"),previousImageDigest:hash("b"),previousConfigDigest:hash("c"),machineId:"def456",imageDigest:hash("d")};
 const token=`lt_cli_${crypto.randomUUID().replaceAll("-","").padEnd(43,"T")}`;
 await env.DB.prepare("INSERT INTO cli_account_tokens(id,user_id,token_hash,device_hash,label,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").bind(newId("cli"),user.userId,await hashCliSecret(token),newId("device"),"Test",Date.now(),Date.now()+60_000).run();
 const client=new LogturaServiceClient({url:"http://localhost",token,fetch:(input,init)=>SELF.fetch(new Request(input,init))});
 const url=`http://localhost/api/deployments/${deployment.id}/config/fly-bindings`;
 const send=(value:unknown=request,headers:Record<string,string>={authorization:`Bearer ${token}`})=>SELF.fetch(url,{method:"POST",headers,body:JSON.stringify(value)});
 return {...user,deployment,activation,issued,request,client,url,send,token};
}
it("atomically binds the candidate, retains public rollback identity, and waits for a real applied report",async()=>{
 const f=await fixture(),before=(await getDeployment(env.DB,f.userId,f.deployment.id))!;
 expect(await f.client.getFlyBinding(f.deployment.id)).toBeNull();expect(await f.client.getFlyBindingReceipt(f.deployment.id,f.request.requestId)).toBeNull();
 const receipt=await f.client.bindFlyReplacement(f.deployment.id,f.request);
 expect(receipt).toEqual({request:f.request,configurationVersion:f.issued.configurationVersion+1});
 const after=(await getDeployment(env.DB,f.userId,f.deployment.id))!;
 expect(exportDeploymentTarget(after)).toEqual({kind:"fly",managed:false,imageDigest:hash("d"),fly:{appName:"app",machineId:"def456",region:"iad",orgSlug:"personal"}});
 expect(JSON.parse(after.metadata_json!)).toMatchObject({keep:"preserved",machineId:"def456"});
 for(const key of ["heartbeat_token","connection_id","source_selection_json","monitor_selection_json","status","managed"] as const)expect(after[key]).toEqual(before[key]);
 expect(await f.client.getFlyBinding(f.deployment.id)).toEqual(receipt);expect(await f.client.getFlyBindingReceipt(f.deployment.id,f.request.requestId)).toEqual(receipt);
 expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toMatchObject({activeInstanceId:f.request.instanceId,lastReportSequence:0,applied:null,stale:false,desired:{configurationVersion:receipt.configurationVersion,sequence:f.issued.sequence,revision:f.issued.revision}});
 expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,f.request.instanceId,f.issued.sequence,f.issued.revision,1)).toBe(true);
 expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.applied?.sequence).toBe(f.issued.sequence);
 expect(JSON.stringify(receipt)).not.toMatch(/private-source|private-version-key|lt_cli_/);
});
it("recovers a lost response exactly once and keeps historical receipts after newer website edits",async()=>{
 const f=await fixture();let writes=0;
 const lost=new LogturaServiceClient({url:"http://localhost",token:f.token,fetch:async(input,init)=>{const response=await SELF.fetch(new Request(input,init));if(init?.method==="POST" && response.ok){writes++;await response.arrayBuffer();throw new Error("response lost");}return response;}});
 await expect(lost.bindFlyReplacement(f.deployment.id,f.request)).rejects.toThrow("response lost");
 const receipt=await f.client.getFlyBindingReceipt(f.deployment.id,f.request.requestId);expect(writes).toBe(1);
 await env.DB.prepare("UPDATE deployments SET display_name='Website edit' WHERE id=?").bind(f.deployment.id).run();
 const version=await readConfigurationVersion(env.DB,f.userId);
 expect(await f.client.bindFlyReplacement(f.deployment.id,f.request)).toEqual(receipt);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version);
 expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.stale).toBe(true);
 expect((await f.send({...f.request,machineId:"abcdef"})).status).toBe(409);
 await env.DB.prepare("UPDATE deployments SET external_id='fly:app:abcdef' WHERE id=?").bind(f.deployment.id).run();expect(await f.client.getFlyBinding(f.deployment.id)).toBeNull();
});
it("permits one physical binding per issued instance even when two requests race",async()=>{
 const f=await fixture(),other={...f.request,requestId:crypto.randomUUID(),machineId:"abcdef"};
 const responses=await Promise.all([f.send(),f.send(other)]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
 const receipt=await responses.find(r=>r.status===200)!.json() as {request:FlyBindingRequest;configurationVersion:number};
 expect(await f.client.getFlyBinding(f.deployment.id)).toEqual(receipt);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.issued.configurationVersion+1);
 const repeated={...receipt.request,requestId:crypto.randomUUID(),previousMachineId:receipt.request.machineId,machineId:"123456",expectedImageDigest:receipt.request.imageDigest,expectedConfigurationVersion:receipt.configurationVersion};
 expect((await f.send(repeated)).status).toBe(409);
 expect(await f.client.bindFlyReplacement(f.deployment.id,receipt.request)).toEqual(receipt);
});
it("rejects stale graph, sequence, revision, instance, target, organization, region and image before changing anything",async()=>{
 const f=await fixture(),before=(await getDeployment(env.DB,f.userId,f.deployment.id))!;
 for(const patch of [{expectedConfigurationVersion:f.request.expectedConfigurationVersion+1},{expectedSequence:2},{revision:hash("e")},{instanceId:crypto.randomUUID()},{previousMachineId:"abcdef"},{appName:"elsewhere"},{orgSlug:"elsewhere"},{region:"ord"},{expectedImageDigest:hash("f")},{expectedImageDigest:null}]){
  expect((await f.send({...f.request,...patch})).status).toBe(409);
  expect(await readFlyBindingReceipt(env.DB,f.userId,f.deployment.id,f.request.requestId)).toBeNull();
  expect(await getDeployment(env.DB,f.userId,f.deployment.id)).toEqual(before);
 }
 await env.DB.prepare("UPDATE deployments SET display_name='New graph' WHERE id=?").bind(f.deployment.id).run();expect((await f.send()).status).toBe(409);
});
it("requires a server-issued active instance and refuses managed, wrong-target and malformed metadata rows",async()=>{
 for(const sql of ["managed=1","target_kind='other'","metadata_json='not-json'","metadata_json='{\"appName\":\"wrong\"}'"]){const f=await fixture();await env.DB.prepare(`UPDATE deployments SET ${sql} WHERE id=?`).bind(f.deployment.id).run();expect((await f.send()).status).toBe(409);expect(await readFlyBindingReceipt(env.DB,f.userId,f.deployment.id,f.request.requestId)).toBeNull();}
 const f=await fixture();await env.DB.prepare("DELETE FROM deployment_instance_receipts WHERE deployment_id=?").bind(f.deployment.id).run();expect((await f.send()).status).toBe(409);
});
it("rolls back the receipt, target and graph rebase together on a storage failure",async()=>{
 const f=await fixture(),before=(await getDeployment(env.DB,f.userId,f.deployment.id))!,state=await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id);
 await env.DB.exec("CREATE TRIGGER binding_injected_failure BEFORE UPDATE ON deployment_configuration_revisions BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;");
 expect((await f.send()).status).toBe(503);expect(await getDeployment(env.DB,f.userId,f.deployment.id)).toEqual(before);expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toEqual(state);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.issued.configurationVersion);expect(await f.client.getFlyBindingReceipt(f.deployment.id,f.request.requestId)).toBeNull();
});
it("records an image update at the same graph clock while retaining the original standby binding",async()=>{
 const f=await fixture(),replacement=await f.client.bindFlyReplacement(f.deployment.id,f.request);
 const activation=await activateDeploymentWithReceipt(env.DB,f.userId,f.deployment.id,{requestId:crypto.randomUUID(),expectedConfigurationVersion:replacement.configurationVersion,expectedSequence:f.issued.sequence,revision:f.issued.revision,expectedInstanceId:f.request.instanceId});
 const update={...f.request,requestId:activation.requestId,instanceId:activation.instanceId,expectedConfigurationVersion:replacement.configurationVersion,previousMachineId:f.request.machineId,machineId:f.request.machineId,expectedImageDigest:f.request.imageDigest,previousImageDigest:f.request.imageDigest,imageDigest:hash("e")};
 const receipt=await f.client.bindFlyReplacement(f.deployment.id,update);expect(receipt.configurationVersion).toBe(replacement.configurationVersion);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(replacement.configurationVersion);expect(await f.client.getFlyBinding(f.deployment.id)).toEqual(replacement);
 const target=exportDeploymentTarget((await getDeployment(env.DB,f.userId,f.deployment.id))!);expect(target.imageDigest).toBe(hash("e"));expect(target.fly?.machineId).toBe(f.request.machineId);
 expect(await f.client.bindFlyReplacement(f.deployment.id,update)).toEqual(receipt);expect((await f.send({...update,requestId:crypto.randomUUID(),imageDigest:hash("f")})).status).toBe(409);
 expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.stale).toBe(false);
});
it("isolates ownership, denies reporting and anonymous access, and protects browser writes with Origin",async()=>{
 const f=await fixture(),other=await seedUser();
 for(const headers of [{},{authorization:"Bearer forwarder-report-token"}])expect((await f.send(f.request,headers)).status).toBe(401);
 expect((await f.send(f.request,{cookie:other.sessionCookie,origin:"http://localhost"})).status).toBe(404);
 for(const origin of [undefined,"https://wrong.test"]){const headers:Record<string,string>={cookie:f.sessionCookie};if(origin)headers.origin=origin;expect((await f.send(f.request,headers)).status).toBe(403);}
 expect((await f.send(f.request,{cookie:f.sessionCookie,origin:"http://localhost"})).status).toBe(200);
 for(const path of [f.url+`/${f.request.requestId}`,f.url.replace(/s$/,"" )])expect((await SELF.fetch(path,{headers:{cookie:other.sessionCookie}})).status).toBe(404);
 expect(await readFlyBindingReceipt(env.DB,other.userId,f.deployment.id,f.request.requestId)).toBeNull();
});
it("rejects malformed and oversized bodies, missing resources and invalid receipt identifiers",async()=>{
 const f=await fixture();
 for(const body of [null,[],{}, {...f.request,extra:"secret"},{...f.request,machineId:"not-a-machine"},{...f.request,previousConfigDigest:"private-secret"}])expect((await f.send(body)).status).toBe(400);
 for(const body of [undefined,"{", " ".repeat(8193)])expect((await SELF.fetch(f.url,{method:"POST",headers:{authorization:`Bearer ${f.token}`},body})).status).toBe(body?.length===8193?413:400);
 expect((await SELF.fetch(f.url+"/bad",{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(400);
 await expect(bindLinkedFlyReplacement(env.DB,f.userId,"missing",f.request)).rejects.toMatchObject({status:404});
 await f.client.bindFlyReplacement(f.deployment.id,f.request);
 await expect(env.DB.prepare("UPDATE linked_fly_binding_receipts SET created_at=0 WHERE deployment_id=?").bind(f.deployment.id).run()).rejects.toThrow("LOGT_FLY_BINDING_IMMUTABLE");
 await env.DB.prepare("DELETE FROM deployments WHERE id=?").bind(f.deployment.id).run();expect(await env.DB.prepare("SELECT * FROM linked_fly_binding_receipts WHERE deployment_id=?").bind(f.deployment.id).all()).toMatchObject({results:[]});
});
it("advertises binding capabilities only to the deployment owner",async()=>{
 const f=await fixture(),path=`http://localhost/api/deployments/${f.deployment.id}/config/fly-capabilities`;
 const owner=await SELF.fetch(path,{headers:{authorization:`Bearer ${f.token}`}});
 expect(owner.status).toBe(200);expect(await owner.json()).toEqual({schemaVersion:1,features:["replacement","image-update","rollback"]});
 expect((await SELF.fetch(path)).status).toBe(401);
 const other=await fixture();expect((await SELF.fetch(path,{headers:{authorization:`Bearer ${other.token}`}})).status).toBe(404);
 expect((await SELF.fetch(path.replace(f.deployment.id,"dep_missing"),{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(404);
});
