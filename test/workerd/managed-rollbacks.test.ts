import {env,SELF,createMessageBatch,createExecutionContext,getQueueResult} from "cloudflare:test";
import {expect,it} from "vitest";
import {FlyMachinesClient,type FlyMachine,type FlyMachineConfig,type FlyVolume} from "@logtura/core";
import {prepareManagedRollback,readManagedRollback,executeManagedRollback} from "../../src/managed-rollbacks";
import {prepareIssuedManagedInstall,bindInstalledManagedRuntime} from "../../src/managed-issued-installations";
import {executeManagedInstall,readManagedInstall} from "../../src/managed-installations";
import {completeIssuedManagedDeployment} from "../../src/managed-runtime-completion";
import {issueDeploymentConfiguration,activateDeploymentInstance} from "../../src/deployment-configuration";
import {readConfigurationVersion} from "../../src/config-version";
import {managedIssuedFixture} from "./_managed-issued-fixture";
import {acceptManagedRuntimeReport} from "./_managed-runtime-report";
import {mockFetch} from "./_setup";
import {signCookie,encryptSecret} from "../../src/crypto";
import {JobDriver} from "../../src/jobs/driver";
import worker from "../../src/index";
import type {JobRecord} from "../../src/jobs/types";
import {managedReplacementFixture} from "./_managed-replacement-fixture";
const image=`registry.test/forwarder@sha256:${"a".repeat(64)}`;
async function withoutImmutable(operation:()=>Promise<void>){
 const sql=await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='managed_rollback_immutable'").first<string>("sql");expect(sql).toBeTypeOf("string");await env.DB.prepare("DROP TRIGGER managed_rollback_immutable").run();try{await operation();}finally{await env.DB.prepare(sql!).run();}
}
const fixture=managedReplacementFixture;

it("fences reports atomically, restores immutable old config, rebinds physical target and leaves applied unknown",async()=>{
 const f=await fixture();await f.complete();const accepted=(await f.state())!;expect(accepted.applied).not.toBeNull();
 const rollback=await f.prepare();expect(await f.state()).toMatchObject({activeInstanceId:null,lastReportSequence:0,applied:null});expect(f.counts).toEqual({candidateStops:0,oldUpdates:0,oldStarts:0});
 expect(await acceptManagedRuntimeReport(f.installation.runtime!,f.machines[1]!.config,f.deployment.heartbeat_token)).toEqual({accepted:false,reportSequence:1});
 expect(await f.execute(rollback)).toBe("legacy");expect(f.machines.map(m=>m.state)).toEqual(["started","stopped"]);expect(f.machines[0]!.config).toEqual(f.installation.payload.rollback);
 expect(f.counts).toEqual({candidateStops:1,oldUpdates:1,oldStarts:1});expect(await f.state()).toMatchObject({activeInstanceId:null,applied:null,lastReportSequence:0,stale:false});
 expect(await env.DB.prepare("SELECT external_id,image_digest,status,bundle_outdated FROM deployments WHERE id=?").bind(f.deployment.id).first()).toEqual({external_id:"fly:app:legacy",image_digest:f.before.image_ref.digest,status:"running",bundle_outdated:1});
 const saved=(await readManagedRollback(env,f.userId,f.deployment.id,rollback.id))!;expect(saved.status).toBe("completed");expect(saved.state.phase).toBe("rolled_back");expect(await f.execute(saved)).toBe("legacy");expect((await f.prepare()).id).toBe(rollback.id);expect(f.counts.oldStarts).toBe(1);
 const bytes=await env.DB.prepare("SELECT CAST(payload_encrypted AS TEXT) AS value FROM managed_rollbacks WHERE id=?").bind(rollback.id).first<{value:string}>();expect(bytes!.value).not.toContain("retained-private-token");
});
it.each(["stop-loss","update-loss","start-loss"])("resumes %s without repeating committed provider writes",async mode=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();f.mode=mode;await expect(f.execute(rollback)).rejects.toThrow("response lost");f.mode="normal";expect(await f.execute((await readManagedRollback(env,f.userId,f.deployment.id,rollback.id))!)).toBe("legacy");expect(f.counts).toEqual({candidateStops:1,oldUpdates:1,oldStarts:1});
});
it.each(["stop-pending","start-pending"])("keeps %s resumable without duplicating an in-progress request",async mode=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();f.mode=mode;await expect(f.execute(rollback)).rejects.toThrow("pending");expect((await readManagedRollback(env,f.userId,f.deployment.id,rollback.id))!.state.phase).toBe("rolling_back");await expect(f.execute(rollback)).rejects.toThrow("pending");if(mode==="stop-pending")f.machines[1]!.state="stopped";else f.machines[0]!.state="started";f.mode="normal";await f.execute(rollback);expect(f.counts).toEqual({candidateStops:1,oldUpdates:1,oldStarts:1});
});
it("rolls back the actual latest candidate configuration after a later issued update",async()=>{
 const f=await fixture();await f.complete();const state=(await f.state())!,version=(await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),state.desired.sequence,f.input.document)).configurationVersion;
 const latest=await prepareIssuedManagedInstall(env,{...f.input,replacement:undefined,configurationVersion:version,machine:f.machines[1]!,base:{...f.machines[1]!.config,image:`registry.test/forwarder@sha256:${"c".repeat(64)}`}});
 await f.complete(latest);const rollback=await f.prepare();expect(rollback.installationId).toBe(latest.id);expect(rollback.state.plan.after).toEqual(latest.payload.after);expect(rollback.state.plan.before.config).toEqual(f.before.config);await f.execute(rollback);expect(f.machines[0]!.config).toEqual(f.installation.payload.rollback);
});
it("restores the old runtime even when candidate storage is unavailable",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();f.mode="missing-volume";expect(await f.execute(rollback)).toBe("legacy");
});
it("blocks new CLI issuance and native installation while rollback is pending",async()=>{
 const f=await fixture();await f.complete();await f.prepare();const state=(await f.state())!;
 await expect(activateDeploymentInstance(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),null)).rejects.toThrow("LOGT_ROLLBACK_ACTIVE");
 await expect(f.prepare()).resolves.toMatchObject({status:"pending"});
 await expect(prepareIssuedManagedInstall(env,{...f.input,configurationVersion:state.desired.configurationVersion,machine:f.machines[1]!,replacement:undefined,base:f.machines[1]!.config})).rejects.toThrow("LOGT_ROLLBACK_ACTIVE");expect((await f.state())!.activeInstanceId).toBeNull();
});
it("rejects an instance changed between the read and rollback reservation without partial fencing",async()=>{
 const f=await fixture();await f.complete();const original=(await f.state())!.activeInstanceId;let changed=false,newInstance:string|undefined;
 const db=new Proxy(env.DB,{get(target,key){if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;newInstance=await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),original);}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 await expect(prepareManagedRollback({...env,DB:db},{userId:f.userId,deploymentId:f.deployment.id,replacementId:f.installation.id,configurationVersion:await readConfigurationVersion(env.DB,f.userId)})).rejects.toThrow("LOGT_ROLLBACK_CONFLICT");expect((await f.state())!.activeInstanceId).toBe(newInstance);expect(await readManagedRollback(env,f.userId,f.deployment.id)).toBeNull();expect(f.machines[1]!.state).toBe("started");
});
it("holds the durable rollback claim across provider work and excludes another executor",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);f.onRequest=async(path,method)=>{if(path.endsWith("/stop") && method==="POST"){entered();await blocked;}};const running=f.execute(rollback);await ready;await expect(f.execute(rollback)).rejects.toThrow("rollback_busy");await expect(f.prepare()).rejects.toThrow("rollback_busy");release();expect(await running).toBe("legacy");
});
it("fences graph changes and accepts only an explicit owner rebase before continuing the same private plan",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();await env.DB.prepare("UPDATE deployments SET display_name='Edited while pending' WHERE id=?").bind(f.deployment.id).run();await expect(f.execute(rollback)).rejects.toThrow("rollback_fence_changed");expect(f.counts.candidateStops).toBe(0);
 const rebased=await f.prepare();expect(rebased.id).toBe(rollback.id);expect(rebased.payload).toEqual(rollback.payload);expect(rebased.configurationVersion).toBeGreaterThan(rollback.configurationVersion);expect(await f.execute(rebased)).toBe("legacy");
});
it("retains a stopped candidate and refuses restoration after a stolen claim",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare(),foreign=crypto.randomUUID();f.onRequest=async(path)=>{if(path.endsWith("/stop"))await env.DB.prepare("UPDATE managed_rollbacks SET lease_token=?,lease_until=? WHERE id=?").bind(foreign,Date.now()+60000,rollback.id).run();};await expect(f.execute(rollback)).rejects.toThrow("rollback_lease_expired");expect(f.machines.map(m=>m.state)).toEqual(["stopped","stopped"]);expect(f.counts.oldUpdates).toBe(0);expect(await env.DB.prepare("SELECT lease_token FROM managed_rollbacks WHERE id=?").bind(rollback.id).first()).toEqual({lease_token:foreign});
});
it("rejects corrupt encrypted intent and unowned lookups without provider mutations",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();expect(await readManagedRollback(env,"other",f.deployment.id,rollback.id)).toBeNull();await expect(prepareManagedRollback(env,{userId:"other",deploymentId:f.deployment.id,replacementId:f.installation.id,configurationVersion:0})).rejects.toThrow("rollback_not_found");
 await withoutImmutable(async()=>{await env.DB.prepare("UPDATE managed_rollbacks SET payload_encrypted=? WHERE id=?").bind(new Uint8Array([1,2,3]),rollback.id).run();await expect(readManagedRollback(env,f.userId,f.deployment.id,rollback.id)).rejects.toThrow("invalid_encrypted_rollback");});expect(f.counts.candidateStops).toBe(0);
});
it("the account API exposes only public references and runs restoration through the real native queue",async()=>{
 const f=await fixture();await f.complete();const status=await f.request();expect(status.status).toBe(200);expect(status.headers.get("cache-control")).toBe("no-store");expect(await status.json()).toMatchObject({rollback:null,availableReplacementId:f.installation.id});
 const response=await f.request(await f.command());expect(response.status).toBe(200);const created=await response.json() as {job:{id:string;kind:string};rollback:{id:string}};expect(created.job.kind).toBe("fly_rollback");expect(JSON.stringify(created)).not.toMatch(/retained-private|private-source|payload|files|env/);
 const repeat=await f.request(await f.command());expect(repeat.status).toBe(200);expect(await repeat.json()).toMatchObject({deduped:true,job:{id:created.job.id}});expect((await f.consume((await f.driver.getById(created.job.id))!)).status).toBe("succeeded");expect(await(await f.request()).json()).toMatchObject({availableReplacementId:null,rollback:{id:created.rollback.id,status:"completed",phase:"rolled_back",oldMachineId:"legacy"}});
});
it("API retry rehydrates the running child chain without another job or new private intent",async()=>{
 const f=await fixture();await f.complete();f.mode="stop-pending";const created=await(await f.request(await f.command())).json() as {job:{id:string};rollback:{id:string}};const root=(await f.driver.getById(created.job.id))!;expect((await f.consume(root)).result).toMatchObject({pending:true});const children=await f.driver.listChildren(root.id);expect(children).toHaveLength(1);const repeat=await f.request(await f.command());expect(repeat.status).toBe(200);expect(await repeat.json()).toMatchObject({deduped:true,job:{id:root.id,status:"running"},rollback:{id:created.rollback.id}});expect(await f.driver.listChildren(root.id)).toHaveLength(1);
 f.mode="normal";f.machines[1]!.state="stopped";expect((await f.consume(children[0]!)).status).toBe("succeeded");expect(f.counts.candidateStops).toBe(1);
});
it("an API retry after failed provider work reuses the private journal",async()=>{
 const f=await fixture();await f.complete();f.mode="stop-loss";const created=await(await f.request(await f.command())).json() as {job:{id:string};rollback:{id:string}};expect((await f.consume((await f.driver.getById(created.job.id))!)).status).toBe("failed");f.mode="normal";const recovered=await(await f.request(await f.command())).json() as typeof created;expect(recovered.rollback.id).toBe(created.rollback.id);expect(recovered.job.id).not.toBe(created.job.id);expect((await f.consume((await f.driver.getById(recovered.job.id))!)).status).toBe("succeeded");expect(f.counts.candidateStops).toBe(1);
});
it("refuses another deployment job and invalid requests without fencing the running instance",async()=>{
 const f=await fixture();await f.complete();const instance=(await f.state())!.activeInstanceId;
 for(const body of [{},[],{...(await f.command()),extra:"private"},{...(await f.command()),configurationVersion:-1},{...(await f.command()),replacementId:"foreign"}])expect((await f.request(body)).status).toBe(400);
 expect((await f.request({...await f.command(),deployTargetId:"other"})).status).toBe(404);
 await f.driver.enqueue({userId:f.userId,kind:"fly_deploy",payload:{deploymentId:f.deployment.id,deployTargetId:f.target.id},lockKey:`fly_deploy:${f.deployment.id}`});expect((await f.request(await f.command())).status).toBe(409);expect((await f.state())!.activeInstanceId).toBe(instance);expect(await readManagedRollback(env,f.userId,f.deployment.id)).toBeNull();
});
it.each(["create-loss","old-stop-loss","candidate-start-loss"])("restores a partially replaced runtime after %s with the same observed candidate",async mode=>{
 const f=await fixture();f.mode=mode;await expect(executeManagedInstall(env,f.installation,f.client,f.signal)).rejects.toThrow("response lost");f.mode="normal";const rollback=await f.prepare();expect(await f.execute(rollback)).toBe("legacy");expect(f.machines).toHaveLength(2);expect(f.machines.map(m=>m.state)).toEqual(["started",mode==="candidate-start-loss"?"stopped":"created"]);expect((await f.state())!.applied).toBeNull();
});
it("refuses rollback before create dispatch without fencing an unmodified installation",async()=>{
 const f=await fixture(),instance=(await f.state())!.activeInstanceId;await expect(f.prepare()).rejects.toThrow("rollback_not_available");expect((await f.state())!.activeInstanceId).toBe(instance);expect(await readManagedRollback(env,f.userId,f.deployment.id)).toBeNull();
});
it("aborts every binding mutation if the lease is stolen between the final read and completion batch",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare(),foreign=crypto.randomUUID(),base=await readConfigurationVersion(env.DB,f.userId);let completing=false,stolen=false;
 const db=new Proxy(env.DB,{get(target,key){if(key==="prepare")return(sql:string)=>{if(sql.includes("UPDATE managed_rollbacks SET status='completed'"))completing=true;return target.prepare(sql);};if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(completing && !stolen){stolen=true;await env.DB.prepare("UPDATE managed_rollbacks SET lease_token=?,lease_until=? WHERE id=?").bind(foreign,Date.now()+60000,rollback.id).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 await expect(executeManagedRollback({...env,DB:db},rollback,f.client,f.signal)).rejects.toThrow("Configuration changed");expect(f.machines.map(m=>m.state)).toEqual(["started","stopped"]);expect((await readManagedRollback(env,f.userId,f.deployment.id,rollback.id))!.status).toBe("pending");expect(await env.DB.prepare("SELECT external_id FROM deployments WHERE id=?").bind(f.deployment.id).first("external_id")).toBe("fly:app:candidate");expect(await readConfigurationVersion(env.DB,f.userId)).toBe(base);
 await env.DB.prepare("UPDATE managed_rollbacks SET lease_until=0 WHERE id=?").bind(rollback.id).run();expect(await f.execute(rollback)).toBe("legacy");expect(f.counts).toEqual({candidateStops:1,oldUpdates:1,oldStarts:1});
});
it("authenticates recovery separately from forwarder reporting and bounds streamed request bodies",async()=>{
 const f=await fixture();await f.complete();const url=`https://example.com/api/deployments/${f.deployment.id}/rollback`;
 expect((await SELF.fetch(url,{headers:{authorization:`Bearer ${f.deployment.heartbeat_token}`}})).status).toBe(401);
 for(const body of [undefined,"{",JSON.stringify({padding:"x".repeat(1025)})])expect((await SELF.fetch(url,{method:"POST",headers:{cookie:f.cookie,origin:"https://example.com","content-type":"application/json"},body})).status).toBe(400);
 const missing=await SELF.fetch("https://example.com/api/deployments/other/rollback",{headers:{cookie:f.cookie}});expect(missing.status).toBe(404);
 expect((await f.request({...await f.command(),configurationVersion:0})).status).toBe(409);expect(await readManagedRollback(env,f.userId,f.deployment.id)).toBeNull();expect((await f.state())!.activeInstanceId).not.toBeNull();
});
it("reports unreadable private recovery state as a static unavailable response",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();await withoutImmutable(async()=>{await env.DB.prepare("UPDATE managed_rollbacks SET payload_encrypted=x'010203' WHERE id=?").bind(rollback.id).run();const corrupt=await f.request();expect(corrupt.status).toBe(503);expect(await corrupt.json()).toEqual({error:"invalid_encrypted_rollback"});});
 const db=new Proxy(env.DB,{get(target,key){if(key==="prepare")return(sql:string)=>{if(sql.includes("FROM managed_rollbacks"))throw new Error("private-database-detail");return target.prepare(sql);};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 const absent=await worker.fetch(new Request(`https://example.com/api/deployments/${f.deployment.id}/rollback`,{headers:{cookie:f.cookie}}),{...env,DB:db},createExecutionContext());expect(absent.status).toBe(503);expect(await absent.json()).toEqual({error:"rollback_unavailable"});
});
it("refuses invalid fences, foreign physical binding and missing installed issuance",async()=>{
 const f=await fixture();await f.complete();await expect(prepareManagedRollback(env,{userId:f.userId,deploymentId:f.deployment.id,replacementId:f.installation.id,configurationVersion:-1})).rejects.toThrow("invalid_configuration_version");
 await env.DB.prepare("UPDATE deployments SET external_id='fly:other:foreign' WHERE id=?").bind(f.deployment.id).run();await expect(f.prepare()).rejects.toThrow("rollback_target_changed");
 await env.DB.prepare("UPDATE deployments SET external_id='fly:app:candidate' WHERE id=?").bind(f.deployment.id).run();await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),(await f.state())!.activeInstanceId);await expect(f.prepare()).rejects.toThrow("rollback_instance_changed");expect(await readManagedRollback(env,f.userId,f.deployment.id)).toBeNull();
});
it.each(["oversized","schema","binding","phase","revision"])("refuses authenticated %s journal corruption without another provider step",async kind=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();await withoutImmutable(async()=>{
 if(kind==="oversized")await env.DB.prepare("UPDATE managed_rollbacks SET payload_encrypted=? WHERE id=?").bind(new Uint8Array(1_900_029),rollback.id).run();
 if(kind==="schema")await env.DB.prepare("UPDATE managed_rollbacks SET payload_encrypted=? WHERE id=?").bind(await encryptSecret(JSON.stringify({...rollback.payload,schemaVersion:2}),env.CREDENTIAL_ENCRYPTION_KEY),rollback.id).run();
 if(kind==="binding")await env.DB.prepare("UPDATE managed_rollbacks SET instance_id=? WHERE id=?").bind(crypto.randomUUID(),rollback.id).run();
 if(kind==="phase")await env.DB.prepare("UPDATE managed_rollbacks SET phase='creating' WHERE id=?").bind(rollback.id).run();
 if(kind==="revision")await env.DB.prepare("UPDATE managed_rollbacks SET fence_revision='foreign' WHERE id=?").bind(rollback.id).run();
 await expect(readManagedRollback(env,f.userId,f.deployment.id,rollback.id)).rejects.toThrow("invalid_encrypted_rollback");});expect(f.counts.candidateStops).toBe(0);
});
it("keeps immutable provider inputs and permits no reservation while native installation holds a live claim",async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);f.onRequest=async(path,method)=>{if(path.endsWith("/machines") && method==="POST"){entered();await blocked;}};const running=executeManagedInstall(env,f.installation,f.client,f.signal);await ready;await expect(f.prepare()).rejects.toThrow("LOGT_ROLLBACK_CONFLICT");expect(await readManagedRollback(env,f.userId,f.deployment.id)).toBeNull();release();await running;f.onRequest=undefined;const rollback=await f.prepare();await expect(env.DB.prepare("UPDATE managed_rollbacks SET instance_id=? WHERE id=?").bind(crypto.randomUUID(),rollback.id).run()).rejects.toThrow("LOGT_ROLLBACK_INTENT_IMMUTABLE");
});
it("refuses a changed physical target on explicit rebase and missing ownership on execution",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();await env.DB.prepare("UPDATE deployments SET external_id='fly:app:foreign' WHERE id=?").bind(f.deployment.id).run();await expect(f.prepare()).rejects.toThrow("rollback_target_changed");await env.DB.prepare("DELETE FROM managed_rollbacks WHERE id=?").bind(rollback.id).run();await expect(f.execute(rollback)).rejects.toThrow("rollback_not_found");
});
it.each(["invalid","missing","expired"])("refuses a %s queued restoration without provider work",async kind=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare(),job=(await f.driver.enqueue({userId:f.userId,kind:"fly_rollback",payload:{deploymentId:f.deployment.id,deployTargetId:f.target.id,rollbackId:kind==="missing"?crypto.randomUUID():rollback.id,deadline:kind==="invalid"?-1:kind==="expired"?0:Date.now()+300000}})).job;expect((await f.consume(job)).status).toBe("failed");expect(f.counts.candidateStops).toBe(0);expect((await readManagedRollback(env,f.userId,f.deployment.id,rollback.id))!.status).toBe("pending");
});
it("bounds a provider transition that remains pending past the job deadline",async()=>{
 const f=await fixture();await f.complete();const rollback=await f.prepare();f.mode="stop-pending";f.onRequest=async(path)=>{if(path.endsWith("/stop"))await new Promise(resolve=>setTimeout(resolve,2100));};const job=(await f.driver.enqueue({userId:f.userId,kind:"fly_rollback",payload:{deploymentId:f.deployment.id,deployTargetId:f.target.id,rollbackId:rollback.id,deadline:Date.now()+2000}})).job;expect((await f.consume(job)).lastError).toContain("deadline exceeded");expect(await f.driver.listChildren(job.id)).toEqual([]);expect((await readManagedRollback(env,f.userId,f.deployment.id,rollback.id))!.state.phase).toBe("rolling_back");
});
