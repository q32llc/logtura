import {env,SELF} from "cloudflare:test";
import {expect,it} from "vitest";
import {prepareManagedCleanup,readManagedCleanup,executeManagedCleanup} from "../../src/managed-cleanups";
import {readConfigurationVersion} from "../../src/config-version";
import {managedReplacementFixture} from "./_managed-replacement-fixture";
import {selectManagedForwarder} from "../../src/managed-machine-inventory";
import {signCookie,encryptSecret} from "../../src/crypto";
import worker from "../../src/index";
import {readManagedInstall,executeManagedInstall} from "../../src/managed-installations";
import {prepareIssuedManagedInstall} from "../../src/managed-issued-installations";
import {activateDeploymentInstance,issueDeploymentConfiguration} from "../../src/deployment-configuration";
import {acceptManagedRuntimeReport} from "./_managed-runtime-report";
import {FlyMachinesClient,FlyReplacementCleanupPending} from "@logtura/core";
async function fixture(rollback=false){
 const f=await managedReplacementFixture();await f.complete();if(rollback)await f.execute(await f.prepare());
 const prepare=()=>prepareManagedCleanup(env,{userId:f.userId,deploymentId:f.deployment.id,replacementId:f.installation.id,configurationVersion:0,client:f.client,signal:f.signal});
 const reserve=async()=>prepareManagedCleanup(env,{userId:f.userId,deploymentId:f.deployment.id,replacementId:f.installation.id,configurationVersion:await readConfigurationVersion(env.DB,f.userId),client:f.client,signal:f.signal});
 const execute=(cleanup:Awaited<ReturnType<typeof reserve>>)=>executeManagedCleanup(env,cleanup,f.client,f.signal);
 return {...f,prepareInvalid:prepare,reserve,cleanup:execute,get deletes(){return f.deletes;},set mode(value:string){f.mode=value;},set onRequest(value:((path:string,method:string)=>Promise<void>)|undefined){f.onRequest=value;}};
}
it.each([false,true])("retires the exact machine after restoration=%s and reauthorizes the surviving inventory",async rollback=>{
 const f=await fixture(rollback),before=await f.state(),saved=await f.reserve();expect(saved.state.plan.survivor.id).toBe(rollback?"legacy":"candidate");expect(f.deletes).toBe(0);expect(saved.instanceId).toBe(rollback?null:before!.activeInstanceId);
 await f.cleanup(saved);expect(f.deletes).toBe(1);expect(f.machines).toHaveLength(1);expect(f.machines[0]!.state).toBe("started");expect(f.volume.attached_machine_id).toBe(rollback?null:"candidate");expect(await f.state()).toEqual(before);
 const complete=(await readManagedCleanup(env,f.userId,f.deployment.id,saved.id))!;expect(complete.status).toBe("completed");expect(complete.state.phase).toBe("deleted");expect((await readManagedInstall(env,f.userId,f.deployment.id,f.installation.id))!.phase).toBe("obsolete");expect(await selectManagedForwarder(env,f.userId,f.deployment.id,"app",f.machines)).toEqual(f.machines[0]);await f.cleanup(complete);expect(f.deletes).toBe(1);
});
it("replaces the restored legacy survivor again with the released checkpoint and a newly issued candidate",async()=>{
 const f=await fixture(true);await f.cleanup(await f.reserve());const old=(await f.state())!;
 const configurationVersion=(await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),old.desired.sequence,f.input.document)).configurationVersion;
 const next=await prepareIssuedManagedInstall(env,{...f.input,configurationVersion,machine:f.machines[0]!,base:{...f.machines[0]!.config,image:f.input.base.image},replacement:{volume:f.volume.id,volumes:[f.volume]}});
 expect(next.id).not.toBe(f.installation.id);await executeManagedInstall(env,next,f.client,f.signal);expect(f.machines.map(m=>m.state)).toEqual(["stopped","started"]);expect(next.runtime!.instance.instanceId).not.toBe(f.installation.runtime!.instance.instanceId);
 expect(await acceptManagedRuntimeReport(f.installation.runtime!,f.installation.payload.after,f.deployment.heartbeat_token)).toMatchObject({accepted:false});
});
it("blocks concurrent issuance, installation and rollback while pending cleanup without clearing accepted state",async()=>{
 const f=await fixture(),state=(await f.state())!;await f.reserve();await expect(activateDeploymentInstance(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),state.activeInstanceId)).rejects.toThrow("LOGT_CLEANUP_ACTIVE");await expect(f.prepare()).rejects.toThrow("LOGT_CLEANUP_ACTIVE");expect(await f.state()).toEqual(state);
});
it.each(["delete-loss","delete-pending","delete-before-loss"])("observes %s without issuing another destructive request",async mode=>{
 const f=await fixture(true),cleanup=await f.reserve();f.mode=mode;await expect(f.cleanup(cleanup)).rejects.toThrow(mode==="delete-pending"?"pending":"response lost");expect((await readManagedCleanup(env,f.userId,f.deployment.id,cleanup.id))!.state.phase).toBe("deleting");f.mode="normal";
 if(mode==="delete-loss")await f.cleanup(cleanup);else await expect(f.cleanup(cleanup)).rejects.toBeInstanceOf(FlyReplacementCleanupPending);expect(f.deletes).toBe(1);
});
it("rechecks account fences and explicitly rebases without replacing private snapshots",async()=>{
 const f=await fixture(),cleanup=await f.reserve();await env.DB.prepare("UPDATE deployments SET display_name='Reviewed new name' WHERE id=?").bind(f.deployment.id).run();await expect(f.cleanup(cleanup)).rejects.toThrow("cleanup_fence_changed");expect(f.deletes).toBe(0);const rebased=await f.reserve();expect(rebased.id).toBe(cleanup.id);expect(rebased.state).toEqual(cleanup.state);expect(rebased.configurationVersion).toBeGreaterThan(cleanup.configurationVersion);await f.cleanup(rebased);expect(f.deletes).toBe(1);
});
it("requires accepted reporting before any installation retirement and refuses unowned private reads",async()=>{
 const f=await fixture();expect(await readManagedCleanup(env,"foreign",f.deployment.id)).toBeNull();await env.DB.prepare("UPDATE deployment_configuration_state SET applied_sequence=NULL,applied_at=NULL WHERE deployment_id=?").bind(f.deployment.id).run();await expect(f.reserve()).rejects.toThrow("cleanup_not_available");expect(f.deletes).toBe(0);await expect(f.prepareInvalid()).rejects.toThrow();
});
it.each([false,true])("exposes only public cleanup references and executes the native queue after restoration=%s",async rollback=>{
 const f=await fixture(rollback),url=`https://example.com/api/deployments/${f.deployment.id}/cleanup`;
 const get=()=>SELF.fetch(url,{headers:{cookie:f.cookie}}),post=(body:unknown)=>SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body:JSON.stringify(body)});
 expect(await(await get()).json()).toMatchObject({cleanup:null,availableReplacementId:f.installation.id});const command={...await f.command(),confirmRetirement:true};
 const response=await post(command);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");const result=await response.json() as {job:{id:string;kind:string};cleanup:{id:string}};expect(result.job.kind).toBe("fly_cleanup");expect(JSON.stringify(result)).not.toMatch(/retained-private|private-source|payload|files|env/);
 expect(await(await post(command)).json()).toMatchObject({deduped:true,job:{id:result.job.id},cleanup:{id:result.cleanup.id}});expect((await f.consume((await f.driver.getById(result.job.id))!)).status).toBe("succeeded");expect(f.deletes).toBe(1);expect(await(await get()).json()).toMatchObject({availableReplacementId:null,cleanup:{status:"completed",phase:"deleted"}});
});
it("rehydrates an observation-only child and never repeats pending deletion",async()=>{
 const f=await fixture(true),url=`https://example.com/api/deployments/${f.deployment.id}/cleanup`,command={...await f.command(),confirmRetirement:true},post=()=>SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body:JSON.stringify(command)});f.mode="delete-pending";
 const {job}=await(await post()).json() as {job:{id:string}};const root=(await f.driver.getById(job.id))!;expect((await f.consume(root)).result).toMatchObject({pending:true});const children=await f.driver.listChildren(root.id);expect(children).toHaveLength(1);expect(await(await post()).json()).toMatchObject({deduped:true,job:{id:root.id,status:"running"}});expect(f.deletes).toBe(1);
 f.machines.splice(1,1);f.volume.attached_machine_id=null;f.mode="normal";expect((await f.consume(children[0]!)).status).toBe("succeeded");expect(f.deletes).toBe(1);
});
it("refuses unconfirmed, oversized, missing-target and busy API requests before reservation",async()=>{
 const f=await fixture(),url=`https://example.com/api/deployments/${f.deployment.id}/cleanup`,command={...await f.command(),confirmRetirement:true},post=(value:unknown)=>SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body:JSON.stringify(value)});
 for(const invalid of [{},[],{...command,confirmRetirement:false},{...command,extra:"private"},{...command,configurationVersion:-1},{...command,replacementId:"foreign"},{...command,extra:"x".repeat(2000)}])expect((await post(invalid)).status).toBe(400);
 expect((await post({...command,deployTargetId:"foreign"})).status).toBe(404);await f.driver.enqueue({userId:f.userId,kind:"fly_deploy",payload:{deploymentId:f.deployment.id,deployTargetId:f.target.id},lockKey:`fly_deploy:${f.deployment.id}`});expect((await post(command)).status).toBe(409);expect(await readManagedCleanup(env,f.userId,f.deployment.id)).toBeNull();expect(f.deletes).toBe(0);
});
it("retains physical deletion but aborts final completion atomically if its claim is stolen",async()=>{
 const f=await fixture(true),cleanup=await f.reserve(),foreign=crypto.randomUUID();f.onRequest=async(path,method)=>{if(path.endsWith("/candidate") && method==="DELETE")await env.DB.prepare("UPDATE managed_cleanups SET lease_token=?,lease_until=? WHERE id=?").bind(foreign,Date.now()+60000,cleanup.id).run();};await expect(f.cleanup(cleanup)).rejects.toThrow("cleanup_lease_expired");expect(f.deletes).toBe(1);expect((await readManagedCleanup(env,f.userId,f.deployment.id,cleanup.id))!).toMatchObject({status:"pending",state:{phase:"deleting"}});expect(await env.DB.prepare("SELECT lease_token FROM managed_cleanups WHERE id=?").bind(cleanup.id).first("lease_token")).toBe(foreign);
 f.onRequest=undefined;await env.DB.prepare("UPDATE managed_cleanups SET lease_until=0 WHERE id=?").bind(cleanup.id).run();await f.cleanup(cleanup);expect(f.deletes).toBe(1);
});
it("holds the native claim across provider work, refuses a concurrent executor and owner rebase",async()=>{
 const f=await fixture(),cleanup=await f.reserve();let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);f.onRequest=async(path,method)=>{if(path.endsWith("/legacy") && method==="DELETE"){entered();await blocked;}};const running=f.cleanup(cleanup);await ready;await expect(f.cleanup(cleanup)).rejects.toThrow("cleanup_busy");await expect(f.reserve()).rejects.toThrow("cleanup_busy");release();await running;expect(f.deletes).toBe(1);
});
it("rejects foreign physical binding and changed encrypted identity without provider destruction",async()=>{
 const f=await fixture(),cleanup=await f.reserve();await env.DB.prepare("UPDATE deployments SET external_id='fly:foreign:machine' WHERE id=?").bind(f.deployment.id).run();await expect(f.cleanup(cleanup)).rejects.toThrow("cleanup_fence_changed");expect(f.deletes).toBe(0);
 await expect(env.DB.prepare("UPDATE managed_cleanups SET retired_id='foreign' WHERE id=?").bind(cleanup.id).run()).rejects.toThrow("LOGT_CLEANUP_INTENT_IMMUTABLE");
});
it.each(["missing","foreign","duplicate","metadata"])("rejects %s surviving inventory even after completed cleanup",async mode=>{
 const f=await fixture();await f.cleanup(await f.reserve());if(mode==="missing")f.machines.splice(0,1);if(mode==="foreign")f.machines[0]!.id="foreign";if(mode==="duplicate")f.machines.push(structuredClone(f.machines[0]!));if(mode==="metadata")f.machines[0]!.config.metadata={"logtura.replacement":"foreign"};await expect(selectManagedForwarder(env,f.userId,f.deployment.id,"app",f.machines)).rejects.toThrow("cleaned survivor");
});
it("retires the legacy machine against the actual latest candidate update",async()=>{
 const f=await fixture(),old=(await f.state())!,configurationVersion=(await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),old.desired.sequence,f.input.document)).configurationVersion;
 const latest=await prepareIssuedManagedInstall(env,{...f.input,replacement:undefined,configurationVersion,machine:f.machines[1]!,base:{...f.machines[1]!.config,image:`registry.test/forwarder@sha256:${"c".repeat(64)}`}});await f.complete(latest);const cleanup=await f.reserve();expect(cleanup.installationId).toBe(latest.id);expect(cleanup.state.plan.survivor.config).toEqual(f.machines[1]!.config);await f.cleanup(cleanup);expect(f.deletes).toBe(1);
});
it("refuses an oversized immutable recovery plan before creating a D1 journal",async()=>{
 const f=await managedReplacementFixture({privateBytes:400000});await f.complete();await expect(prepareManagedCleanup(env,{userId:f.userId,deploymentId:f.deployment.id,replacementId:f.installation.id,configurationVersion:await readConfigurationVersion(env.DB,f.userId),client:f.client,signal:f.signal})).rejects.toThrow("cleanup_too_large");expect(await readManagedCleanup(env,f.userId,f.deployment.id)).toBeNull();expect(f.deletes).toBe(0);
});
it("rejects malformed native versions, missing ownership and changed provider organization before reservation",async()=>{
 const f=await fixture(),input={userId:f.userId,deploymentId:f.deployment.id,replacementId:f.installation.id,configurationVersion:await readConfigurationVersion(env.DB,f.userId),client:f.client,signal:f.signal};await expect(prepareManagedCleanup(env,{...input,configurationVersion:-1})).rejects.toThrow("invalid_configuration_version");await expect(prepareManagedCleanup(env,{...input,userId:"foreign"})).rejects.toThrow("cleanup_not_available");
 const client=new FlyMachinesClient({token:"private",fetch:async()=>Response.json({name:"app",organization:{slug:"foreign"}})});await expect(prepareManagedCleanup(env,{...input,client})).rejects.toThrow("cleanup_target_changed");expect(f.deletes).toBe(0);
});
it("does not reserve cleanup after an instance changes between inspection and the D1 batch",async()=>{
 const f=await fixture(),prior=(await f.state())!.activeInstanceId;let newInstance:string|undefined;f.onRequest=async(path)=>{if(path==="/v1/apps/app" && !newInstance)newInstance=await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),prior);};await expect(f.reserve()).rejects.toThrow("LOGT_CLEANUP_CONFLICT");expect((await f.state())!.activeInstanceId).toBe(newInstance);expect(await readManagedCleanup(env,f.userId,f.deployment.id)).toBeNull();expect(f.deletes).toBe(0);
});
it("keeps a new cleanup journal if a normal deployment job races its queue insertion",async()=>{
 const f=await fixture(),command={...await f.command(),confirmRetirement:true};let raced=false;f.onRequest=async(path)=>{if(path.endsWith("/machines") && !raced){raced=true;await f.driver.enqueue({userId:f.userId,kind:"fly_deploy",payload:{deploymentId:f.deployment.id,deployTargetId:f.target.id},lockKey:`fly_deploy:${f.deployment.id}`});}};
 const response=await SELF.fetch(`https://example.com/api/deployments/${f.deployment.id}/cleanup`,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body:JSON.stringify(command)});expect(response.status).toBe(409);expect(await readManagedCleanup(env,f.userId,f.deployment.id)).toMatchObject({status:"pending",state:{phase:"prepared"}});expect(f.deletes).toBe(0);
});
it("requires an account session, bounds streamed bodies and returns static availability failures",async()=>{
 const f=await fixture(),url=`https://example.com/api/deployments/${f.deployment.id}/cleanup`;
 expect((await SELF.fetch(url,{headers:{authorization:`Bearer ${f.deployment.heartbeat_token}`}})).status).toBe(401);
 for(const body of [undefined,"{","x".repeat(1025)])expect((await SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body})).status).toBe(400);
 expect((await SELF.fetch("https://example.com/api/deployments/foreign/cleanup",{headers:{cookie:f.cookie}})).status).toBe(404);
 const stale=await SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body:JSON.stringify({...await f.command(),confirmRetirement:true,configurationVersion:0})});expect(stale.status).toBe(409);expect(await stale.json()).toMatchObject({error:"configuration_changed"});
 const db=new Proxy(env.DB,{get(target,key){if(key==="prepare")return(sql:string)=>{if(sql.includes("FROM managed_cleanups"))throw new Error("private DB detail");return target.prepare(sql);};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}}),response=await worker.fetch(new Request(url,{headers:{cookie:f.cookie}}),{...env,DB:db});expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"cleanup_unavailable"});
});
it("refuses an active cleanup with a different reviewed replacement, and only observes a completed retry",async()=>{
 const f=await fixture(),url=`https://example.com/api/deployments/${f.deployment.id}/cleanup`,post=(value:unknown)=>SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body:JSON.stringify(value)}),command={...await f.command(),confirmRetirement:true};const created=await(await post(command)).json() as {job:{id:string}};
 expect((await post({...command,replacementId:crypto.randomUUID()})).status).toBe(409);await f.consume((await f.driver.getById(created.job.id))!);const repeated=await(await post(command)).json() as typeof created;await f.consume((await f.driver.getById(repeated.job.id))!);expect(f.deletes).toBe(1);expect((await f.reserve()).status).toBe("completed");
});
it("fences report state inside the durable deletion CAS, not just during preflight reads",async()=>{
 const f=await fixture(),cleanup=await f.reserve();let marked=false,raced=false;
 const db=new Proxy(env.DB,{get(target,key){if(key==="prepare")return(sql:string)=>{if(sql.includes("UPDATE managed_cleanups SET phase="))marked=true;return target.prepare(sql);};if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(marked && !raced){raced=true;await env.DB.prepare("UPDATE deployment_configuration_state SET applied_sequence=NULL,applied_at=NULL WHERE deployment_id=?").bind(f.deployment.id).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 await expect(executeManagedCleanup({...env,DB:db},cleanup,f.client,f.signal)).rejects.toThrow("journal changed before transition");expect(f.deletes).toBe(0);expect((await readManagedCleanup(env,f.userId,f.deployment.id,cleanup.id))!.state.phase).toBe("prepared");
});
it("aborts completion and installation retirement if its lease is stolen after the final read",async()=>{
 const f=await fixture(),cleanup=await f.reserve(),foreign=crypto.randomUUID();let marked=false,raced=false;
 const db=new Proxy(env.DB,{get(target,key){if(key==="prepare")return(sql:string)=>{if(sql.includes("UPDATE managed_cleanups SET status='completed'"))marked=true;return target.prepare(sql);};if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(marked && !raced){raced=true;await env.DB.prepare("UPDATE managed_cleanups SET lease_token=?,lease_until=? WHERE id=?").bind(foreign,Date.now()+60000,cleanup.id).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 await expect(executeManagedCleanup({...env,DB:db},cleanup,f.client,f.signal)).rejects.toThrow("Configuration changed");expect(f.deletes).toBe(1);expect((await readManagedCleanup(env,f.userId,f.deployment.id,cleanup.id))!).toMatchObject({status:"pending",state:{phase:"deleted"}});expect((await readManagedInstall(env,f.userId,f.deployment.id,f.installation.id))!.phase).toBe("completed");
 await env.DB.prepare("UPDATE managed_cleanups SET lease_until=0 WHERE id=?").bind(cleanup.id).run();await f.cleanup(cleanup);expect(f.deletes).toBe(1);
});
it("keeps corrupt encrypted plans private and refuses oversized envelopes or authenticated mismatched identities",async()=>{
 const f=await fixture(),cleanup=await f.reserve(),sql=await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='managed_cleanup_immutable'").first<string>("sql");await env.DB.prepare("DROP TRIGGER managed_cleanup_immutable").run();
 try{
  const envelopes=[new Uint8Array([1,2,3]),new Uint8Array(1900029),await encryptSecret(JSON.stringify({...cleanup.state,plan:{...cleanup.state.plan,replacement:{...cleanup.state.plan.replacement,plan:{...cleanup.state.plan.replacement.plan,id:crypto.randomUUID()}}}}),env.CREDENTIAL_ENCRYPTION_KEY)];
  for(const bytes of envelopes){await env.DB.prepare("UPDATE managed_cleanups SET payload_encrypted=? WHERE id=?").bind(bytes,cleanup.id).run();await expect(readManagedCleanup(env,f.userId,f.deployment.id,cleanup.id)).rejects.toThrow("invalid_encrypted_cleanup");}
  const response=await SELF.fetch(`https://example.com/api/deployments/${f.deployment.id}/cleanup`,{headers:{cookie:f.cookie}});expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"invalid_encrypted_cleanup"});
 }finally{await env.DB.prepare(sql!).run();}expect(f.deletes).toBe(0);
});
it("validates missing or expired queue payloads before provider mutations, retaining expired observation intent",async()=>{
 const f=await fixture(true),cleanup=await f.reserve(),payload={deploymentId:f.deployment.id,deployTargetId:f.target.id,cleanupId:cleanup.id,deadline:Date.now()+20000};
 for(const invalid of [{...payload,deploymentId:""},{...payload,deployTargetId:""},{...payload,cleanupId:""},{...payload,deadline:-1},{...payload,deadline:1.5},{...payload,deadline:Date.now()+306000},{...payload,cleanupId:"missing"},{...payload,deadline:0}]){const {job}=await f.driver.enqueue({userId:f.userId,kind:"fly_cleanup",payload:invalid});expect((await f.consume(job)).status).toBe("failed");}expect(f.deletes).toBe(0);
 f.mode="delete-pending";f.onRequest=async(path,method)=>{if(path.endsWith("/candidate") && method==="DELETE")await new Promise(resolve=>setTimeout(resolve,2100));};const {job}=await f.driver.enqueue({userId:f.userId,kind:"fly_cleanup",payload:{...payload,deadline:Date.now()+2000}});expect((await f.consume(job)).status).toBe("failed");expect(await f.driver.listChildren(job.id)).toEqual([]);expect(f.deletes).toBe(1);expect((await readManagedCleanup(env,f.userId,f.deployment.id,cleanup.id))!.state.phase).toBe("deleting");
});
it("recovers a failed cleanup queue job through the same immutable journal and completes an expired already-deleted retry",async()=>{
 const f=await fixture(true),url=`https://example.com/api/deployments/${f.deployment.id}/cleanup`,command={...await f.command(),confirmRetirement:true},post=()=>SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body:JSON.stringify(command)});f.mode="delete-loss";const created=await(await post()).json() as {job:{id:string};cleanup:{id:string}};expect((await f.consume((await f.driver.getById(created.job.id))!)).status).toBe("failed");f.mode="normal";const resumed=await(await post()).json() as typeof created;expect(resumed.cleanup.id).toBe(created.cleanup.id);expect((await f.consume((await f.driver.getById(resumed.job.id))!)).status).toBe("succeeded");const {job}=await f.driver.enqueue({userId:f.userId,kind:"fly_cleanup",payload:{deploymentId:f.deployment.id,deployTargetId:f.target.id,cleanupId:created.cleanup.id,deadline:0}});expect((await f.consume(job)).status).toBe("succeeded");expect(f.deletes).toBe(1);
});
it("returns no cleanup choice for an unmanaged deployment and returns a conflict for an issuance race",async()=>{
 const f=await fixture(),url=`https://example.com/api/deployments/${f.deployment.id}/cleanup`;await env.DB.prepare("UPDATE deployments SET managed=0 WHERE id=?").bind(f.deployment.id).run();expect(await(await SELF.fetch(url,{headers:{cookie:f.cookie}})).json()).toMatchObject({availableReplacementId:null});await env.DB.prepare("UPDATE deployments SET managed=1 WHERE id=?").bind(f.deployment.id).run();const prior=(await f.state())!.activeInstanceId;let changed=false;f.onRequest=async(path)=>{if(path==="/v1/apps/app" && !changed){changed=true;await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),prior);}};
 const response=await SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body:JSON.stringify({...await f.command(),confirmRetirement:true})});expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"cleanup_changed"});expect(f.deletes).toBe(0);
});
it("refuses execution after the owned journal disappeared",async()=>{
 const f=await fixture(),cleanup=await f.reserve();await env.DB.prepare("DELETE FROM managed_cleanups WHERE id=?").bind(cleanup.id).run();await expect(f.cleanup(cleanup)).rejects.toThrow("cleanup_not_found");expect(f.deletes).toBe(0);
});
it("retires an unlaunched candidate after rollback of a lost create response",async()=>{
 const f=await managedReplacementFixture();f.mode="create-loss";await expect(executeManagedInstall(env,f.installation,f.client,f.signal)).rejects.toThrow("response lost");f.mode="normal";await f.execute(await f.prepare());expect(f.machines[1]!.state).toBe("created");const cleanup=await prepareManagedCleanup(env,{userId:f.userId,deploymentId:f.deployment.id,replacementId:f.installation.id,configurationVersion:await readConfigurationVersion(env.DB,f.userId),client:f.client,signal:f.signal});await executeManagedCleanup(env,cleanup,f.client,f.signal);expect(f.deletes).toBe(1);expect(f.machines.map(machine=>machine.id)).toEqual(["legacy"]);expect(f.volume.attached_machine_id).toBeNull();
});
