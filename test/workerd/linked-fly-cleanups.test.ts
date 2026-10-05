import {SELF,env} from "cloudflare:test";
import {expect,it,afterEach} from "vitest";
import {LogturaServiceClient,exportDeploymentManifest,createSecretVersioner,type FlyRollbackRequest,type FlyCleanupRequest} from "@logtura/core";
import {createConnection,createDeployment,getDeployment} from "../../src/db";
import {readConfigurationVersion} from "../../src/config-version";
import {issueDeploymentConfiguration,readDeploymentConfiguration,acknowledgeDeploymentConfiguration} from "../../src/deployment-configuration";
import {activateDeploymentWithReceipt} from "../../src/deployment-instances";
import {bindLinkedFlyReplacement} from "../../src/linked-fly-bindings";
import {readLinkedFlyCleanup,readLinkedFlyCleanupRebase,prepareLinkedFlyCleanup,completeLinkedFlyCleanup,rebaseLinkedFlyCleanup} from "../../src/linked-fly-cleanups";
import {hashCliSecret} from "../../src/cli-auth";
import {newId} from "../../src/crypto";
import {seedUser} from "./_setup";
const hash=(c:string)=>`sha256:${c.repeat(64)}`;
afterEach(async()=>{await env.DB.exec("DROP TRIGGER IF EXISTS cleanup_injected_failure");});
async function fixture(rolledBack=false){
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
 let rollback=null;
 if(rolledBack){await client.prepareFlyRollback(deployment.id,request);rollback=await client.completeFlyRollback(deployment.id,request.requestId);}
 const cleanup:FlyCleanupRequest={requestId:crypto.randomUUID(),bindingRequestId:binding.request.requestId,rollbackRequestId:rollback?.request.requestId??null,expectedConfigurationVersion:rollback?.configurationVersion??binding.configurationVersion,expectedSequence:issued.sequence,revision:issued.revision,expectedInstanceId:rolledBack?null:activation.instanceId,imageDigest:hash(rolledBack?"b":"d"),survivorConfigDigest:hash("f"),retiredConfigDigest:hash("e")};
 const url=`http://localhost/api/deployments/${deployment.id}/config/fly-cleanups`;
 const send=(value:unknown=cleanup,headers:Record<string,string>={authorization:`Bearer ${token}`})=>SELF.fetch(url,{method:"POST",headers,body:JSON.stringify(value)});
 return {...owner,client,deployment,request:cleanup,rollbackRequest:request,binding,activation,issued,url,send,token};
}
it("reserves installed and restored survivors atomically without changing target, clocks or applied evidence",async()=>{
 for(const restored of [false,true]){
  const f=await fixture(restored),before=await getDeployment(env.DB,f.userId,f.deployment.id),state=await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id),version=await readConfigurationVersion(env.DB,f.userId);
  const p=await f.client.prepareFlyCleanup(f.deployment.id,f.request);expect(p.status).toBe("prepared");expect(p.rollback?.status??null).toBe(restored?"completed":null);expect(p.request).toEqual(f.request);
  expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toEqual(state);expect(await getDeployment(env.DB,f.userId,f.deployment.id)).toEqual(before);
  await expect(activateDeploymentWithReceipt(env.DB,f.userId,f.deployment.id,{requestId:crypto.randomUUID(),expectedConfigurationVersion:version,expectedSequence:f.issued.sequence,revision:f.issued.revision,expectedInstanceId:state!.activeInstanceId})).rejects.toMatchObject({status:409,code:"cleanup_pending"});
  if(!restored)await expect(f.client.prepareFlyRollback(f.deployment.id,f.rollbackRequest)).rejects.toMatchObject({status:409});
  const done=await f.client.completeFlyCleanup(f.deployment.id,f.request.requestId);expect(done).toEqual({...p,status:"completed"});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version);expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toEqual(state);expect(await getDeployment(env.DB,f.userId,f.deployment.id)).toEqual(before);
  expect(await f.client.getFlyCleanup(f.deployment.id,f.request.requestId)).toEqual(done);expect(await f.client.prepareFlyCleanup(f.deployment.id,f.request)).toEqual(done);expect(await f.client.completeFlyCleanup(f.deployment.id,f.request.requestId)).toEqual(done);
  await expect(f.client.prepareFlyCleanup(f.deployment.id,{...f.request,requestId:crypto.randomUUID()})).rejects.toMatchObject({status:409});
  if(!restored)await expect(f.client.prepareFlyRollback(f.deployment.id,f.rollbackRequest)).rejects.toMatchObject({status:409});
 }
});
it("fences competing cleanup and stale physical/graph/reporting intents, preserving exact recovery",async()=>{
 const f=await fixture();
 for(const patch of [{expectedConfigurationVersion:f.request.expectedConfigurationVersion+1},{expectedSequence:2},{revision:hash("e")},{expectedInstanceId:crypto.randomUUID()},{imageDigest:hash("a")},{bindingRequestId:crypto.randomUUID()}])await expect(f.client.prepareFlyCleanup(f.deployment.id,{...f.request,...patch})).rejects.toMatchObject({status:409});
 // Valid hashes with stale identities conflict; malformed hashes fail before DB writes.
 await expect(f.client.prepareFlyCleanup(f.deployment.id,{...f.request,imageDigest:hash("a")})).rejects.toMatchObject({status:409});
});
it("recovers lost prepare/complete responses once and refuses request ID reuse",async()=>{
 const f=await fixture();let posts=0;const client=new LogturaServiceClient({url:"http://localhost",token:f.token,fetch:async(input,init)=>{const response=await SELF.fetch(new Request(input,init));if(init?.method==="POST" && response.ok){posts++;await response.arrayBuffer();throw new Error("response lost");}return response;}});
 await expect(client.prepareFlyCleanup(f.deployment.id,f.request)).rejects.toThrow("response lost");expect((await f.client.getFlyCleanup(f.deployment.id,f.request.requestId))!.status).toBe("prepared");
 await expect(f.client.prepareFlyCleanup(f.deployment.id,{...f.request,survivorConfigDigest:hash("a")})).rejects.toMatchObject({status:409,code:"request_id_reused"});
 await expect(client.completeFlyCleanup(f.deployment.id,f.request.requestId)).rejects.toThrow("response lost");expect((await f.client.completeFlyCleanup(f.deployment.id,f.request.requestId)).status).toBe("completed");expect(posts).toBe(2);
});
it("explicitly rebases a website edit while preserving immutable cleanup and provider fingerprints",async()=>{
 const f=await fixture(true),p=await f.client.prepareFlyCleanup(f.deployment.id,f.request);
 await env.DB.prepare("UPDATE connections SET display_name='Website edit' WHERE id=(SELECT connection_id FROM deployments WHERE id=?)").bind(f.deployment.id).run();
 const version=await readConfigurationVersion(env.DB,f.userId);expect(version).toBeGreaterThan(p.fence.configurationVersion);
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner("private-version"));
 const issued=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,version,f.issued.sequence,exported.document);
 await expect(f.client.completeFlyCleanup(f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:409});
 const request={requestId:crypto.randomUUID(),configurationVersion:issued.configurationVersion,sequence:issued.sequence,revision:issued.revision};
 const ack=await f.client.rebaseFlyCleanup(f.deployment.id,f.request.requestId,request);expect(ack).toEqual({cleanupId:f.request.requestId,request});expect(await f.client.getFlyCleanupRebase(f.deployment.id,f.request.requestId,request.requestId)).toEqual(ack);
 const current=await f.client.getFlyCleanup(f.deployment.id,f.request.requestId);expect(current!.request).toEqual(p.request);expect(current!.fence).toEqual({configurationVersion:issued.configurationVersion,sequence:issued.sequence,revision:issued.revision});
 await expect(f.client.rebaseFlyCleanup(f.deployment.id,f.request.requestId,{...request,revision:hash("a")})).rejects.toMatchObject({status:409,code:"request_id_reused"});
 await f.client.completeFlyCleanup(f.deployment.id,f.request.requestId);expect(await f.client.rebaseFlyCleanup(f.deployment.id,f.request.requestId,request)).toEqual(ack);await expect(f.client.rebaseFlyCleanup(f.deployment.id,f.request.requestId,{...request,requestId:crypto.randomUUID()})).rejects.toMatchObject({status:409});
});
it("keeps owner isolation and bounded origin/body validation; reporting credentials cannot reserve deletion",async()=>{
 const f=await fixture(),other=await seedUser();expect(await readLinkedFlyCleanup(env.DB,other.userId,f.deployment.id,f.request.requestId)).toBeNull();await expect(prepareLinkedFlyCleanup(env.DB,other.userId,f.deployment.id,f.request)).rejects.toMatchObject({status:404});
 expect((await f.send({}, {cookie:f.sessionCookie,origin:"https://wrong.test"})).status).toBe(403);expect((await f.send({}, {cookie:f.sessionCookie,origin:env.APP_URL})).status).toBe(400);
 expect((await SELF.fetch(f.url,{method:"POST",headers:{authorization:`Bearer ${f.token}`},body:"x".repeat(8193)})).status).toBe(413);expect((await SELF.fetch(f.url,{method:"POST",headers:{authorization:`Bearer ${f.token}`},body:"bad json"})).status).toBe(400);
 expect((await SELF.fetch(f.url,{method:"POST",headers:{authorization:"Bearer reporting-token"},body:JSON.stringify(f.request)})).status).toBe(401);
 expect(await f.client.getFlyCleanup(f.deployment.id,crypto.randomUUID())).toBeNull();expect(await f.client.getFlyCleanupRebase(f.deployment.id,crypto.randomUUID(),crypto.randomUUID())).toBeNull();
});
it("rejects malformed persisted cleanup identity and atomically rolls back reservation failures",async()=>{
 const f=await fixture();await env.DB.exec("CREATE TRIGGER cleanup_injected_failure AFTER INSERT ON linked_fly_cleanups BEGIN SELECT RAISE(ABORT,'injected'); END");
 await expect(f.client.prepareFlyCleanup(f.deployment.id,f.request)).rejects.toMatchObject({status:503});expect(await f.client.getFlyCleanup(f.deployment.id,f.request.requestId)).toBeNull();
 await env.DB.exec("DROP TRIGGER cleanup_injected_failure");await f.client.prepareFlyCleanup(f.deployment.id,f.request);
 await env.DB.exec("DROP TRIGGER linked_fly_cleanup_fence_guard");await env.DB.prepare("UPDATE linked_fly_cleanups SET request_json='{}' WHERE deployment_id=?").bind(f.deployment.id).run();await expect(f.client.getFlyCleanup(f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:503});
});
it("preserves the installed reporting identity across an explicit newer desired graph",async()=>{
 const f=await fixture(),p=await f.client.prepareFlyCleanup(f.deployment.id,f.request);await env.DB.prepare("UPDATE connections SET display_name='Pending website config' WHERE id=(SELECT connection_id FROM deployments WHERE id=?)").bind(f.deployment.id).run();
 const document=(await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner("private-version"))).document;
 const issued=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),f.issued.sequence,document);
 await expect(f.client.completeFlyCleanup(f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:409});
 const request={requestId:crypto.randomUUID(),configurationVersion:issued.configurationVersion,sequence:issued.sequence,revision:issued.revision};await f.client.rebaseFlyCleanup(f.deployment.id,f.request.requestId,request);await f.client.completeFlyCleanup(f.deployment.id,f.request.requestId);
 expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toMatchObject({activeInstanceId:f.activation.instanceId,applied:{sequence:p.request.expectedSequence,revision:p.request.revision},desired:{sequence:issued.sequence}});
});
it("rolls back completion and rebase storage failures without releasing owner exclusion",async()=>{
 const f=await fixture(true),p=await f.client.prepareFlyCleanup(f.deployment.id,f.request);
 await env.DB.exec("CREATE TRIGGER cleanup_injected_failure AFTER UPDATE ON linked_fly_cleanups BEGIN SELECT RAISE(ABORT,'injected'); END");
 await expect(f.client.completeFlyCleanup(f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:503});expect(await f.client.getFlyCleanup(f.deployment.id,f.request.requestId)).toEqual(p);
 const request={requestId:crypto.randomUUID(),...p.fence};await expect(f.client.rebaseFlyCleanup(f.deployment.id,f.request.requestId,request)).rejects.toMatchObject({status:503});expect(await f.client.getFlyCleanupRebase(f.deployment.id,f.request.requestId,request.requestId)).toBeNull();expect(await f.client.getFlyCleanup(f.deployment.id,f.request.requestId)).toEqual(p);
});
it("rejects changed owner physical metadata and a missing current accepted report before reservation",async()=>{
 for(const mutation of ["UPDATE deployments SET metadata_json=json_set(metadata_json,'$.orgSlug','another') WHERE id=?","UPDATE deployment_configuration_state SET applied_sequence=NULL,applied_at=NULL WHERE deployment_id=?"]){const f=await fixture();await env.DB.prepare(mutation).bind(f.deployment.id).run();await expect(f.client.prepareFlyCleanup(f.deployment.id,f.request)).rejects.toMatchObject({status:409});expect(await f.client.getFlyCleanup(f.deployment.id,f.request.requestId)).toBeNull();}
});
it("keeps invalid requests, missing receipts, and session-origin checks consistent across every route",async()=>{
 const f=await fixture(),id=crypto.randomUUID(),headers={cookie:f.sessionCookie,origin:"https://wrong.test"};
 for(const suffix of [`/${id}/complete`,`/${id}/rebases`])expect((await SELF.fetch(f.url+suffix,{method:"POST",headers,body:"{}"})).status).toBe(403);
 await expect(completeLinkedFlyCleanup(env.DB,f.userId,f.deployment.id,"bad")).rejects.toMatchObject({status:400});await expect(completeLinkedFlyCleanup(env.DB,f.userId,f.deployment.id,id)).rejects.toMatchObject({status:404});await expect(rebaseLinkedFlyCleanup(env.DB,f.userId,f.deployment.id,id,{})).rejects.toMatchObject({status:400});
 expect((await SELF.fetch(f.url+"/bad",{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(400);expect((await SELF.fetch(f.url+`/bad/rebases/${id}`,{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(400);expect((await SELF.fetch(f.url+`/${id}/rebases/bad`,{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(400);
});
it("recovers durable D1 acknowledgements after prepare, rebase and completion have committed",async()=>{
 const f=await fixture(true);let losses=0;
 const db={prepare(sql:string){const statement=env.DB.prepare(sql);if(!/INSERT INTO linked_fly_cleanup|UPDATE linked_fly_cleanups SET status/.test(sql))return statement;return {bind(...args:unknown[]){const bound=statement.bind(...args);return {async run(){await bound.run();losses++;throw new Error("storage acknowledgement lost");}};}};}} as unknown as D1Database;
 const p=await prepareLinkedFlyCleanup(db,f.userId,f.deployment.id,f.request);expect(p.status).toBe("prepared");const request={requestId:crypto.randomUUID(),...p.fence};expect(await rebaseLinkedFlyCleanup(db,f.userId,f.deployment.id,f.request.requestId,request)).toEqual({cleanupId:f.request.requestId,request});expect((await completeLinkedFlyCleanup(db,f.userId,f.deployment.id,f.request.requestId)).status).toBe("completed");expect(losses).toBe(3);
 expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM linked_fly_cleanups WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(1);expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM linked_fly_cleanup_rebases WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(1);
});
it("isolates receipt/rebase ownership and handles absent bodies, malformed identities and missing parents",async()=>{
 const f=await fixture(true),other=await seedUser(),p=await f.client.prepareFlyCleanup(f.deployment.id,f.request),request={requestId:crypto.randomUUID(),...p.fence};
 const ack=await f.client.rebaseFlyCleanup(f.deployment.id,f.request.requestId,request);expect(await readLinkedFlyCleanupRebase(env.DB,other.userId,f.deployment.id,f.request.requestId,request.requestId)).toBeNull();
 for(const suffix of [`/${f.request.requestId}`,`/${f.request.requestId}/rebases/${request.requestId}`])expect((await SELF.fetch(f.url+suffix,{headers:{cookie:other.sessionCookie}})).status).toBe(404);
 for(const suffix of ["",`/${f.request.requestId}/rebases`])expect((await SELF.fetch(f.url+suffix,{method:"POST",headers:{authorization:`Bearer ${f.token}`}})).status).toBe(400);
 await expect(completeLinkedFlyCleanup(env.DB,other.userId,f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:404});await expect(rebaseLinkedFlyCleanup(env.DB,other.userId,f.deployment.id,f.request.requestId,request)).rejects.toMatchObject({status:404});await expect(rebaseLinkedFlyCleanup(env.DB,f.userId,f.deployment.id,"bad",request)).rejects.toMatchObject({status:400});await expect(rebaseLinkedFlyCleanup(env.DB,f.userId,f.deployment.id,crypto.randomUUID(),request)).rejects.toMatchObject({status:404});expect(ack.request).toEqual(request);
});
it("fails closed on corrupt stored cleanup and rebase identity without returning raw content",async()=>{
 const f=await fixture();await f.client.prepareFlyCleanup(f.deployment.id,f.request);
 const row=await env.DB.prepare(`SELECT p.request_json,p.status,p.fence_version,p.fence_sequence,p.fence_revision,b.request_json AS binding_json,b.configuration_version AS binding_version FROM linked_fly_cleanups p JOIN linked_fly_binding_receipts b ON b.deployment_id=p.deployment_id AND b.request_id=p.binding_request_id WHERE p.deployment_id=?`).bind(f.deployment.id).first();
 for(const value of [{...row,request_json:"private-invalid"},{...row,fence_version:-1},{...row,request_json:JSON.stringify({...f.request,requestId:crypto.randomUUID()})}]){const db={prepare:()=>({bind:()=>({first:async()=>value})})} as unknown as D1Database;await expect(readLinkedFlyCleanup(db,f.userId,f.deployment.id,f.request.requestId)).rejects.toMatchObject({status:503,code:"configuration_unavailable"});}
 for(const request_json of ["private-invalid",JSON.stringify({requestId:crypto.randomUUID(),configurationVersion:3,sequence:1,revision:f.request.revision})]){const db={prepare:()=>({bind:()=>({first:async()=>({request_json})})})} as unknown as D1Database;await expect(readLinkedFlyCleanupRebase(db,f.userId,f.deployment.id,f.request.requestId,crypto.randomUUID())).rejects.toMatchObject({status:503});}
});
