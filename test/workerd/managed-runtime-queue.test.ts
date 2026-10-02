import {env,createMessageBatch,createExecutionContext,getQueueResult} from "cloudflare:test";
import {expect,it} from "vitest";
import type {FlyMachineConfig} from "@logtura/core";
import {JobDriver} from "../../src/jobs/driver";
import worker from "../../src/index";
import type {JobRecord} from "../../src/jobs/types";
import {readManagedInstall} from "../../src/managed-installations";
import {activateDeploymentInstance,acknowledgeDeploymentConfiguration} from "../../src/deployment-configuration";
import {completeIssuedManagedDeployment} from "../../src/managed-runtime-completion";
import {managedIssuedFixture} from "./_managed-issued-fixture";
import {mockFetch} from "./_setup";
import {acceptManagedRuntimeReport} from "./_managed-runtime-report";

async function fixture(){
 const f=await managedIssuedFixture();await env.DB.prepare("UPDATE deployments SET bundle_outdated=1 WHERE id=?").bind(f.deployment.id).run();const install=await f.prepare(),driver=new JobDriver(env.DB,env.JOBS_QUEUE);
 let live:FlyMachineConfig|null=null,creates=0,lose=false;
 mockFetch("https://api.machines.dev/",async req=>{
  expect(req.headers.get("authorization")).toBe("FlyV1 fo1_fixture");const path=new URL(req.url).pathname;
  if(path==="/v1/apps/app")return Response.json({name:"app",organization:{slug:"personal"}});
  expect(path).toBe("/v1/apps/app/machines");
  const machine=()=>({id:"machine1",name:"forwarder",instance_id:"version1",state:"started",region:"ord",config:live,image_ref:{registry:"registry.test",repository:"forwarder",digest:install.payload.after.image.split("@")[1]},checks:[{name:"vector_api",status:"passing"}]});
  if(req.method==="POST"){creates++;live=(await req.json() as {config:FlyMachineConfig}).config;expect(live).toEqual(install.payload.after);if(lose)throw new TypeError("provider acknowledgement lost");return Response.json(machine());}
  return Response.json(live?[machine()]:[]);
 });
 const parentPayload={deploymentId:f.deployment.id,deployTargetId:f.target.id,orgSlug:"personal",region:"ord"};
 const root=(await driver.enqueue({userId:f.userId,kind:"fly_deploy.create_or_update_machine",payload:{parentPayload,appName:"app",orgSlug:"personal",region:"ord"}})).job;
 async function consume(job:JobRecord){await env.DB.prepare("UPDATE jobs SET available_at=NULL WHERE id=?").bind(job.id).run();const batch=createMessageBatch("logtura-jobs",[{id:job.id,timestamp:new Date(),attempts:1,body:{jobId:job.id}}]);await worker.queue(batch,env);const result=await getQueueResult(batch,createExecutionContext());expect(result.explicitAcks).toEqual([job.id]);expect(result.retryMessages).toEqual([]);return (await driver.getById(job.id))!;}
 async function next(){return (await driver.listChildren(root.id)).find(job=>job.kind==="fly_deploy.wait_running" && job.status==="queued")!;}
 async function read(){return env.DB.prepare("SELECT status,bundle_outdated FROM deployments WHERE id=?").bind(f.deployment.id).first();}
 async function report(){
  return acceptManagedRuntimeReport(install.runtime!,live!,f.deployment.heartbeat_token);
 }
 return {...f,install,driver,root,consume,next,read,report,get creates(){return creates;},set lose(value:boolean){lose=value;}};
}
it("recovers the issued queue install and waits for a real API-accepted report before completing healthy deployment",async()=>{
 const f=await fixture();expect((await f.consume(f.root)).status).toBe("succeeded");expect(f.creates).toBe(1);expect(await f.state()).toMatchObject({stale:false,lastReportSequence:0});const wait=await f.next();expect((await f.consume(wait)).result).toMatchObject({polling:true});expect(await f.read()).toMatchObject({bundle_outdated:1});expect((await readManagedInstall(env,f.userId,f.deployment.id))!.phase).toBe("installed");
 expect(await f.report()).toEqual({accepted:true,reportSequence:1});expect((await f.consume(await f.next())).status).toBe("succeeded");expect(await f.read()).toEqual({status:"running",bundle_outdated:0});expect((await readManagedInstall(env,f.userId,f.deployment.id,f.install.id))!.phase).toBe("completed");expect(f.creates).toBe(1);
});
it("recovers a lost provider response through the queue without another create or new issued instance",async()=>{
 const f=await fixture();f.lose=true;expect((await f.consume(f.root)).lastError).toContain("acknowledgement lost");f.lose=false;const retry=(await f.driver.enqueue({userId:f.userId,kind:f.root.kind,payload:f.root.payload})).job;expect((await f.consume(retry)).status).toBe("succeeded");expect(f.creates).toBe(1);expect((await f.state())!.activeInstanceId).toBe(f.install.runtime!.instance.instanceId);
});
it("retains installed intent and explains timeout when provider health has no accepted report",async()=>{
 const f=await fixture();await f.consume(f.root);const wait=await f.next();await env.DB.prepare("UPDATE jobs SET payload_json=? WHERE id=?").bind(JSON.stringify({...wait.payload,pollDeadline:0}),wait.id).run();const expired=(await f.driver.getById(wait.id))!;expect((await f.consume(expired)).lastError).toContain("runtime acknowledgement pending");expect(await f.read()).toMatchObject({bundle_outdated:1});expect((await readManagedInstall(env,f.userId,f.deployment.id))!.phase).toBe("installed");
});
it("refuses a superseded active instance even when provider health and an earlier report passed",async()=>{
 const f=await fixture();await f.consume(f.root);await f.report();const state=(await f.state())!;await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,state.desired.configurationVersion,state.activeInstanceId);expect((await f.consume(await f.next())).lastError).toContain("issued instance changed");expect(await f.read()).toMatchObject({bundle_outdated:1});
});
it("refuses a changed graph while waiting and keeps the recorded deployment bundle outdated",async()=>{
 const f=await fixture();await f.consume(f.root);await f.report();await env.DB.prepare("UPDATE deployments SET display_name='Changed' WHERE id=?").bind(f.deployment.id).run();expect((await f.consume(await f.next())).lastError).toContain("issued instance changed");expect(await f.read()).toMatchObject({bundle_outdated:1});
});
it("fences completion in SQL when acknowledgement is absent or the active instance changes after polling",async()=>{
 const f=await fixture();await f.consume(f.root);const installed=(await readManagedInstall(env,f.userId,f.deployment.id))!;await expect(completeIssuedManagedDeployment(env,installed,installed.installedConfigurationVersion!)).rejects.toThrow("acknowledgement changed");expect(await f.read()).toMatchObject({bundle_outdated:1});
 await f.report();const state=(await f.state())!;await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,state.desired.configurationVersion,state.activeInstanceId);await expect(completeIssuedManagedDeployment(env,installed,installed.installedConfigurationVersion!)).rejects.toThrow("acknowledgement changed");expect((await readManagedInstall(env,f.userId,f.deployment.id))!.phase).toBe("installed");
});
it("requires the exact current applied revision rather than any prior accepted report",async()=>{
 const f=await fixture();await f.consume(f.root);const instance=f.install.runtime!.instance;expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,"old-instance",instance.sequence,instance.revision,1)).toBe(false);expect((await f.consume(await f.next())).result).toMatchObject({polling:true});
});
it("rejects uninstalled or incorrectly versioned completion intent without clearing markers",async()=>{
 const f=await fixture();await expect(completeIssuedManagedDeployment(env,f.install,f.version)).rejects.toThrow("not ready");await f.consume(f.root);const installed=(await readManagedInstall(env,f.userId,f.deployment.id))!;await expect(completeIssuedManagedDeployment(env,{...installed,runtime:null},installed.installedConfigurationVersion!)).rejects.toThrow("not ready");await expect(completeIssuedManagedDeployment(env,installed,0)).rejects.toThrow("not ready");expect(await f.read()).toMatchObject({bundle_outdated:1});
});
