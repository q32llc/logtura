import {SELF,env} from "cloudflare:test";
import {expect,it,afterEach} from "vitest";
import {LogturaServiceClient,exportDeploymentManifest,createSecretVersioner,type FlyRollbackRequest} from "@logtura/core";
import {createConnection,createDeployment,getDeployment} from "../../src/db";
import {readConfigurationVersion} from "../../src/config-version";
import {issueDeploymentConfiguration,readDeploymentConfiguration,acknowledgeDeploymentConfiguration} from "../../src/deployment-configuration";
import {activateDeploymentWithReceipt} from "../../src/deployment-instances";
import {bindLinkedFlyReplacement} from "../../src/linked-fly-bindings";
import {readLinkedFlyRollback,readLinkedFlyRollbackRebase,rebaseLinkedFlyRollback,prepareLinkedFlyRollback,completeLinkedFlyRollback} from "../../src/linked-fly-rollbacks";
import {hashCliSecret} from "../../src/cli-auth";
import {newId} from "../../src/crypto";
import {seedUser} from "./_setup";
const hash=(c:string)=>`sha256:${c.repeat(64)}`;
afterEach(async()=>{await env.DB.exec("DROP TRIGGER IF EXISTS rollback_injected_failure");});
async function fixture(){
 const owner=await seedUser(),connection=await createConnection(env.DB,env,{userId:owner.userId,provider:"cloudflare-worker-tail",displayName:"Site",externalAccountId:"account",credentials:{apiToken:"private-source"}});
 const deployment=await createDeployment(env.DB,{userId:owner.userId,connectionId:connection.id,targetKind:"fly",displayName:"Forwarder"});
 await env.DB.prepare("UPDATE deployments SET external_id='fly:app:abc123',image_digest=?,metadata_json=? WHERE id=?").bind(hash("a"),JSON.stringify({appName:"app",region:"iad",orgSlug:"personal",keep:"preserved"}),deployment.id).run();
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner("private-version"));
 const issued=await issueDeploymentConfiguration(env.DB,owner.userId,deployment.id,await readConfigurationVersion(env.DB,owner.userId),0,exported.document);
 const activation=await activateDeploymentWithReceipt(env.DB,owner.userId,deployment.id,{requestId:crypto.randomUUID(),expectedConfigurationVersion:issued.configurationVersion,expectedSequence:issued.sequence,revision:issued.revision,expectedInstanceId:null});
 const binding=await bindLinkedFlyReplacement(env.DB,owner.userId,deployment.id,{requestId:crypto.randomUUID(),instanceId:activation.instanceId,expectedConfigurationVersion:issued.configurationVersion,expectedSequence:issued.sequence,revision:issued.revision,appName:"app",orgSlug:"personal",region:"iad",previousMachineId:"abc123",expectedImageDigest:hash("a"),previousImageDigest:hash("b"),previousConfigDigest:hash("c"),machineId:"def456",imageDigest:hash("d")});
 expect(await acknowledgeDeploymentConfiguration(env.DB,deployment.id,activation.instanceId,issued.sequence,issued.revision,1)).toBe(true);
 const request:FlyRollbackRequest={requestId:crypto.randomUUID(),bindingRequestId:binding.request.requestId,expectedConfigurationVersion:binding.configurationVersion,expectedSequence:issued.sequence,revision:issued.revision,expectedInstanceId:activation.instanceId,expectedImageDigest:hash("d"),candidateConfigDigest:hash("e")};
 const token=`lt_cli_${crypto.randomUUID().replaceAll("-","").padEnd(43,"T")}`;
 await env.DB.prepare("INSERT INTO cli_account_tokens(id,user_id,token_hash,device_hash,label,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").bind(newId("cli"),owner.userId,await hashCliSecret(token),newId("device"),"Test",Date.now(),Date.now()+60_000).run();
 const client=new LogturaServiceClient({url:"http://localhost",token,fetch:(input,init)=>SELF.fetch(new Request(input,init))});
 const url=`http://localhost/api/deployments/${deployment.id}/config/fly-rollbacks`;
 const send=(value:unknown=request,headers:Record<string,string>={authorization:`Bearer ${token}`})=>SELF.fetch(url,{method:"POST",headers,body:JSON.stringify(value)});
 return {...owner,client,deployment,request,binding,activation,issued,url,send,token};
}
it("retires reports before provider handoff and atomically restores a truthful unknown applied state",async()=>{
 const f=await fixture(),before=(await getDeployment(env.DB,f.userId,f.deployment.id))!;
 const prepared=await f.client.prepareFlyRollback(f.deployment.id,f.request);expect(prepared).toEqual({request:f.request,binding:f.binding,status:"prepared",configurationVersion:f.request.expectedConfigurationVersion,fence:{configurationVersion:f.request.expectedConfigurationVersion,sequence:f.request.expectedSequence,revision:f.request.revision}});
 expect((await getDeployment(env.DB,f.userId,f.deployment.id))!.external_id).toBe(before.external_id);
 expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toMatchObject({activeInstanceId:null,lastReportSequence:0,applied:null,stale:false});
 expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,f.activation.instanceId,f.issued.sequence,f.issued.revision,2)).toBe(false);
 await expect(activateDeploymentWithReceipt(env.DB,f.userId,f.deployment.id,{requestId:crypto.randomUUID(),expectedConfigurationVersion:prepared.configurationVersion,expectedSequence:f.issued.sequence,revision:f.issued.revision,expectedInstanceId:null})).rejects.toMatchObject({status:409,code:"rollback_pending"});
 expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.activeInstanceId).toBeNull();
 const completed=await f.client.completeFlyRollback(f.deployment.id,f.request.requestId);expect(completed.status).toBe("completed");expect(completed.configurationVersion).toBe(prepared.configurationVersion+1);
 const after=(await getDeployment(env.DB,f.userId,f.deployment.id))!;expect(after.external_id).toBe("fly:app:abc123");expect(after.image_digest).toBe(hash("b"));expect(after.bundle_outdated).toBe(1);expect(JSON.parse(after.metadata_json!)).toMatchObject({keep:"preserved",machineId:"abc123"});
 for(const key of ["heartbeat_token","connection_id","source_selection_json","monitor_selection_json","managed"] as const)expect(after[key]).toEqual(before[key]);
 expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toMatchObject({activeInstanceId:null,applied:null,stale:false,desired:{sequence:f.issued.sequence,revision:f.issued.revision,configurationVersion:completed.configurationVersion}});
 expect(await f.client.getFlyBinding(f.deployment.id)).toBeNull();expect(await f.client.getFlyBindingReceipt(f.deployment.id,f.binding.request.requestId)).toEqual(f.binding);
 expect(await f.client.completeFlyRollback(f.deployment.id,f.request.requestId)).toEqual(completed);expect(await f.client.prepareFlyRollback(f.deployment.id,f.request)).toEqual(completed);
});
it("recovers lost prepare and complete responses once while keeping immutable intent",async()=>{
 const f=await fixture();let posts=0;const client=new LogturaServiceClient({url:"http://localhost",token:f.token,fetch:async(input,init)=>{const response=await SELF.fetch(new Request(input,init));if(init?.method==="POST" && response.ok){posts++;await response.arrayBuffer();throw new Error("response lost");}return response;}});
 await expect(client.prepareFlyRollback(f.deployment.id,f.request)).rejects.toThrow("response lost");expect((await f.client.getFlyRollback(f.deployment.id,f.request.requestId))!.status).toBe("prepared");
 await expect(client.completeFlyRollback(f.deployment.id,f.request.requestId)).rejects.toThrow("response lost");expect(posts).toBe(2);const receipt=(await f.client.getFlyRollback(f.deployment.id,f.request.requestId))!;expect(receipt.status).toBe("completed");
 expect(await f.client.prepareFlyRollback(f.deployment.id,f.request)).toEqual(receipt);expect((await f.send({...f.request,candidateConfigDigest:hash("f")})).status).toBe(409);
});
it("rejects stale owner, graph, instance, image and binding fences without retiring reports",async()=>{
 const f=await fixture(),state=await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id),before=await getDeployment(env.DB,f.userId,f.deployment.id);
 for(const patch of [{expectedConfigurationVersion:f.request.expectedConfigurationVersion+1},{expectedSequence:2},{revision:hash("f")},{expectedInstanceId:null},{expectedInstanceId:crypto.randomUUID()},{expectedImageDigest:hash("f")},{bindingRequestId:crypto.randomUUID()}]){
  expect((await f.send({...f.request,...patch})).status).toBe(409);expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toEqual(state);expect(await getDeployment(env.DB,f.userId,f.deployment.id)).toEqual(before);
 }
 const other=await seedUser();expect((await f.send(f.request,{cookie:other.sessionCookie,origin:"http://localhost"})).status).toBe(404);
});
it("permits one pending rollback and fences intervening edits at completion",async()=>{
 const f=await fixture();const responses=await Promise.all([f.send(),f.send({...f.request,requestId:crypto.randomUUID()})]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
 const receipt=await responses.find(r=>r.ok)!.json() as {request:FlyRollbackRequest};await env.DB.prepare("UPDATE deployments SET display_name='Website edit' WHERE id=?").bind(f.deployment.id).run();
 await expect(f.client.completeFlyRollback(f.deployment.id,receipt.request.requestId)).rejects.toMatchObject({status:409});expect((await getDeployment(env.DB,f.userId,f.deployment.id))!.external_id).toBe("fly:app:def456");expect((await f.client.getFlyRollback(f.deployment.id,receipt.request.requestId))!.status).toBe("prepared");
 expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.activeInstanceId).toBeNull();
});
it("aborts completion receipt, target and graph rebase together on native storage failure",async()=>{
 const f=await fixture();await f.client.prepareFlyRollback(f.deployment.id,f.request);const state=await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id),version=await readConfigurationVersion(env.DB,f.userId),before=await getDeployment(env.DB,f.userId,f.deployment.id);
 await env.DB.exec("CREATE TRIGGER rollback_injected_failure BEFORE UPDATE ON deployment_configuration_revisions BEGIN SELECT RAISE(ABORT,'injected rollback storage failure'); END;");
 await expect(f.client.completeFlyRollback(f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:503});expect(await getDeployment(env.DB,f.userId,f.deployment.id)).toEqual(before);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version);expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toEqual(state);expect((await f.client.getFlyRollback(f.deployment.id,f.request.requestId))!.status).toBe("prepared");
});
it("isolates account writes, browser origins and malformed or missing receipts",async()=>{
 const f=await fixture();expect(await f.client.getFlyRollback(f.deployment.id,f.request.requestId)).toBeNull();
 for(const headers of [{},{authorization:"Bearer report-token"}])expect((await f.send(f.request,headers)).status).toBe(401);
 for(const origin of [undefined,"https://elsewhere.test"]){const headers:Record<string,string>={cookie:f.sessionCookie};if(origin)headers.origin=origin;expect((await f.send(f.request,headers)).status).toBe(403);expect((await SELF.fetch(`${f.url}/${f.request.requestId}/complete`,{method:"POST",headers})).status).toBe(403);}
 for(const body of [null,[],{}, {...f.request,extra:"secret"}])expect((await f.send(body)).status).toBe(400);
 for(const body of [undefined,"{"," ".repeat(8193)])expect((await SELF.fetch(f.url,{method:"POST",headers:{authorization:`Bearer ${f.token}`},body})).status).toBe(body?.length===8193?413:400);
 expect((await SELF.fetch(f.url+"/bad",{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(400);await expect(completeLinkedFlyRollback(env.DB,f.userId,f.deployment.id,"bad")).rejects.toMatchObject({status:400});
 await expect(prepareLinkedFlyRollback(env.DB,f.userId,"missing",f.request)).rejects.toMatchObject({status:404});await expect(completeLinkedFlyRollback(env.DB,f.userId,"missing",f.request.requestId)).rejects.toMatchObject({status:404});await expect(completeLinkedFlyRollback(env.DB,f.userId,f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:404});
 expect((await f.send(f.request,{cookie:f.sessionCookie,origin:"http://localhost"})).status).toBe(200);const other=await seedUser();expect(await readLinkedFlyRollback(env.DB,other.userId,f.deployment.id,f.request.requestId)).toBeNull();
});
it("rebases only explicit graph fences and recovers lost acknowledgement without rewriting original rollback intent",async()=>{
 const f=await fixture();await f.client.prepareFlyRollback(f.deployment.id,f.request);
 await env.DB.prepare("UPDATE deployments SET display_name='Website edit' WHERE id=?").bind(f.deployment.id).run();
 const version=await readConfigurationVersion(env.DB,f.userId),state=(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!;
 const issued=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,version,state.desired.sequence,state.desired.document);
 const request={requestId:crypto.randomUUID(),configurationVersion:issued.configurationVersion,sequence:issued.sequence,revision:issued.revision};
 expect(await f.client.getFlyRollbackRebase(f.deployment.id,f.request.requestId,request.requestId)).toBeNull();
 const lost=new LogturaServiceClient({url:"http://localhost",token:f.token,fetch:async(input,init)=>{const response=await SELF.fetch(new Request(input,init));if(init?.method==="POST" && response.ok){await response.arrayBuffer();throw new Error("rebase response lost");}return response;}});
 await expect(lost.rebaseFlyRollback(f.deployment.id,f.request.requestId,request)).rejects.toThrow("rebase response lost");
 const receipt=await f.client.getFlyRollbackRebase(f.deployment.id,f.request.requestId,request.requestId);expect(receipt).toEqual({rollbackId:f.request.requestId,request});
 expect(await f.client.rebaseFlyRollback(f.deployment.id,f.request.requestId,request)).toEqual(receipt);
 await expect(f.client.rebaseFlyRollback(f.deployment.id,f.request.requestId,{...request,revision:hash("f")})).rejects.toMatchObject({status:409});
 const pending=(await f.client.getFlyRollback(f.deployment.id,f.request.requestId))!;expect(pending.request).toEqual(f.request);expect(pending.binding).toEqual(f.binding);expect(pending.fence).toEqual({configurationVersion:issued.configurationVersion,sequence:issued.sequence,revision:issued.revision});
 const completed=await f.client.completeFlyRollback(f.deployment.id,f.request.requestId);expect(completed.configurationVersion).toBe(issued.configurationVersion+1);expect(completed.fence).toEqual(pending.fence);expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.applied).toBeNull();
 expect(await f.client.rebaseFlyRollback(f.deployment.id,f.request.requestId,request)).toEqual(receipt);
 await expect(f.client.rebaseFlyRollback(f.deployment.id,f.request.requestId,{...request,requestId:crypto.randomUUID()})).rejects.toMatchObject({status:409});
 await expect(env.DB.prepare("UPDATE linked_fly_rollback_rebases SET created_at=0 WHERE deployment_id=?").bind(f.deployment.id).run()).rejects.toThrow("LOGT_FLY_ROLLBACK_IMMUTABLE");
});
it("restores the original standby after a subsequent image update at the same graph clock",async()=>{
 const f=await fixture();const activation=await activateDeploymentWithReceipt(env.DB,f.userId,f.deployment.id,{requestId:crypto.randomUUID(),expectedConfigurationVersion:f.binding.configurationVersion,expectedSequence:f.issued.sequence,revision:f.issued.revision,expectedInstanceId:f.activation.instanceId});
 await bindLinkedFlyReplacement(env.DB,f.userId,f.deployment.id,{...f.binding.request,requestId:crypto.randomUUID(),instanceId:activation.instanceId,expectedConfigurationVersion:f.binding.configurationVersion,previousMachineId:"def456",machineId:"def456",expectedImageDigest:hash("d"),previousImageDigest:hash("d"),imageDigest:hash("f")});
 const request={...f.request,expectedInstanceId:activation.instanceId,expectedImageDigest:hash("f")};await f.client.prepareFlyRollback(f.deployment.id,request);await f.client.completeFlyRollback(f.deployment.id,request.requestId);
 expect((await getDeployment(env.DB,f.userId,f.deployment.id))!.external_id).toBe("fly:app:abc123");expect((await getDeployment(env.DB,f.userId,f.deployment.id))!.image_digest).toBe(hash("b"));
});

it("isolates rebase ownership and rejects malformed, missing and stale rebase intents",async()=>{
 const f=await fixture();await f.client.prepareFlyRollback(f.deployment.id,f.request);const request={requestId:crypto.randomUUID(),configurationVersion:f.request.expectedConfigurationVersion,sequence:f.request.expectedSequence,revision:f.request.revision};
 const url=`${f.url}/${f.request.requestId}/rebases`;
 for(const origin of [undefined,"https://wrong.test"]){const headers:Record<string,string>={cookie:f.sessionCookie};if(origin)headers.origin=origin;expect((await SELF.fetch(url,{method:"POST",headers,body:JSON.stringify(request)})).status).toBe(403);}
 for(const value of [null,[],{}, {...request,extra:"secret"}])await expect(rebaseLinkedFlyRollback(env.DB,f.userId,f.deployment.id,f.request.requestId,value)).rejects.toMatchObject({status:400});
 await expect(rebaseLinkedFlyRollback(env.DB,f.userId,f.deployment.id,"bad",request)).rejects.toMatchObject({status:400});await expect(rebaseLinkedFlyRollback(env.DB,f.userId,"missing",f.request.requestId,request)).rejects.toMatchObject({status:404});
 await expect(rebaseLinkedFlyRollback(env.DB,f.userId,f.deployment.id,crypto.randomUUID(),request)).rejects.toMatchObject({status:404});
 await expect(f.client.rebaseFlyRollback(f.deployment.id,f.request.requestId,{...request,configurationVersion:request.configurationVersion+1})).rejects.toMatchObject({status:409});
 const other=await seedUser();expect((await SELF.fetch(url,{method:"POST",headers:{cookie:other.sessionCookie,origin:"http://localhost"},body:JSON.stringify(request)})).status).toBe(404);
 const receipt=await f.client.rebaseFlyRollback(f.deployment.id,f.request.requestId,request);expect(await readLinkedFlyRollbackRebase(env.DB,other.userId,f.deployment.id,f.request.requestId,request.requestId)).toBeNull();
 for(const path of [f.url+"/bad/rebases/"+request.requestId,url+"/bad"])expect((await SELF.fetch(path,{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(400);
 expect((await SELF.fetch(url+"/"+request.requestId,{headers:{cookie:other.sessionCookie}})).status).toBe(404);expect(receipt.request).toEqual(request);
});
it("fails closed on corrupt persisted rollback and rebase receipts without exposing their contents",async()=>{
 const f=await fixture();await f.client.prepareFlyRollback(f.deployment.id,f.request);
 const row=await env.DB.prepare(`SELECT p.request_json,p.status,p.configuration_version,p.fence_version,p.fence_sequence,p.fence_revision,b.request_json AS binding_json,b.configuration_version AS binding_version FROM linked_fly_rollbacks p JOIN linked_fly_binding_receipts b ON b.deployment_id=p.deployment_id AND b.request_id=p.binding_request_id WHERE p.deployment_id=?`).bind(f.deployment.id).first();
 for(const value of [{...row,request_json:"corrupt-private"},{...row,fence_version:-1},{...row,request_json:JSON.stringify({...f.request,requestId:crypto.randomUUID()})}]){
  const db={prepare:()=>({bind:()=>({first:async()=>value})})} as unknown as D1Database;
  await expect(readLinkedFlyRollback(db,f.userId,f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:503,code:"configuration_unavailable"});
 }
 for(const request_json of ["corrupt-private",JSON.stringify({requestId:crypto.randomUUID(),configurationVersion:3,sequence:1,revision:hash("a")})]){
  const db={prepare:()=>({bind:()=>({first:async()=>({request_json})})})} as unknown as D1Database;
  await expect(readLinkedFlyRollbackRebase(db,f.userId,f.deployment.id,f.request.requestId,crypto.randomUUID())).rejects.toMatchObject({status:503,code:"configuration_unavailable"});
 }
});
it("aborts report retirement and its receipt together when preparing rollback fails",async()=>{
 const f=await fixture(),before=await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id);
 await env.DB.exec("CREATE TRIGGER rollback_injected_failure BEFORE UPDATE ON deployment_configuration_state BEGIN SELECT RAISE(ABORT,'injected retirement failure'); END;");
 await expect(f.client.prepareFlyRollback(f.deployment.id,f.request)).rejects.toMatchObject({status:503});expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toEqual(before);expect(await f.client.getFlyRollback(f.deployment.id,f.request.requestId)).toBeNull();
});
it("aborts a rebase acknowledgement with its fence update on storage failure",async()=>{
 const f=await fixture(),before=await f.client.prepareFlyRollback(f.deployment.id,f.request),request={requestId:crypto.randomUUID(),configurationVersion:f.request.expectedConfigurationVersion,sequence:f.request.expectedSequence,revision:f.request.revision};
 await env.DB.exec("CREATE TRIGGER rollback_injected_failure BEFORE UPDATE ON linked_fly_rollbacks BEGIN SELECT RAISE(ABORT,'injected rebase storage failure'); END;");
 await expect(f.client.rebaseFlyRollback(f.deployment.id,f.request.requestId,request)).rejects.toMatchObject({status:503});expect(await f.client.getFlyRollback(f.deployment.id,f.request.requestId)).toEqual(before);expect(await f.client.getFlyRollbackRebase(f.deployment.id,f.request.requestId,request.requestId)).toBeNull();
});
