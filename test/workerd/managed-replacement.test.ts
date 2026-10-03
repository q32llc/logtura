import {env,createMessageBatch,createExecutionContext,getQueueResult} from "cloudflare:test";
import {expect,it} from "vitest";
import {FlyMachinesClient,type FlyMachine,type FlyMachineConfig,type FlyVolume} from "@logtura/core";
import {prepareIssuedManagedInstall,bindInstalledManagedRuntime} from "../../src/managed-issued-installations";
import {readManagedInstall,executeManagedInstall,compileManagedInstallIntent} from "../../src/managed-installations";
import {selectManagedForwarder} from "../../src/managed-machine-inventory";
import {issueDeploymentConfiguration,activateDeploymentInstance} from "../../src/deployment-configuration";
import {readConfigurationVersion} from "../../src/config-version";
import {managedIssuedFixture} from "./_managed-issued-fixture";
import {mockFetch} from "./_setup";
import {acceptManagedRuntimeReport} from "./_managed-runtime-report";
import {JobDriver} from "../../src/jobs/driver";
import worker from "../../src/index";
import type {JobRecord} from "../../src/jobs/types";
const image=`registry.test/forwarder@sha256:${"a".repeat(64)}`;
function oldMachine():FlyMachine & {name:string}{return {id:"legacy",name:"forwarder",instance_id:"legacy_version",state:"started",region:"ord",config:{image:"registry.test/old:tag",env:{OLD:"private-retained-token"},files:[{guest_path:"/etc/vector/vector.yaml",raw_value:"b2xkLXByaXZhdGU=",mode:0o400}],guest:{cpu_kind:"shared",cpus:2,memory_mb:4096},checks:{vector_api:{port:8686}},init:{cmd:["--config","/etc/vector/vector.yaml"]},restart:{policy:"always"}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};}
async function fixture(state="started"){
 const f=await managedIssuedFixture(false),before={...oldMachine(),state};
 await env.DB.prepare("UPDATE deployments SET external_id='fly:app:legacy',status='running',bundle_outdated=1 WHERE id=?").bind(f.deployment.id).run();
 const version=(await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),0,f.input.document)).configurationVersion;
 const volume:FlyVolume={id:f.input.volume,region:"ord",state:"created",encrypted:true,attached_machine_id:null};
 const input={...f.input,configurationVersion:version,machine:before,base:{...before.config,image},replacement:{volume:volume.id,volumes:[structuredClone(volume)]}};
 const install=await prepareIssuedManagedInstall(env,input),machines:FlyMachine[]=[structuredClone(before)],calls:Array<{path:string;method:string}>=[];
 let mode="normal",onRequest:((path:string,method:string)=>Promise<void>)|undefined;
 const counts={creates:0,oldStops:0,newStarts:0,updates:0};
 mockFetch("https://api.machines.dev/",async request=>{
  const path=new URL(request.url).pathname,method=request.method;calls.push({path,method});await onRequest?.(path,method);
  if(path==="/v1/apps/app")return Response.json({name:"app",organization:{slug:mode==="wrong-org"?"other":"personal"}});
  if(path.endsWith("/volumes"))return Response.json([volume]);
  const match=path.match(/\/machines\/([^/]+)(?:\/(.*))?$/),machine=machines.find(item=>item.id===match?.[1]);
  if(path.endsWith("/lease"))return method==="DELETE"?new Response(null,{status:204}):Response.json({data:{nonce:`nonce-${machine!.id}`}});
  if(path.endsWith("/machines")){
   if(method==="POST"){
    expect(await env.DB.prepare("SELECT phase,replacement_phase,machine_id FROM managed_installations WHERE id=?").bind(install.id).first()).toEqual({phase:"dispatched",replacement_phase:"creating",machine_id:null});
    const body=await request.json() as {name:string;region:string;config:FlyMachineConfig;skip_launch:boolean};expect(body.skip_launch).toBe(true);expect(body.config).toEqual(install.payload.after);expect(machines[0]!.state).toBe(before.state);counts.creates++;
    if(mode!=="create-absent")machines.push({id:"candidate",name:body.name,instance_id:"candidate_version",state:"created",region:body.region,config:body.config,image_ref:{registry:"registry.test",repository:"forwarder",digest:body.config.image.split("@")[1]!},checks:[{name:"vector_api",status:"passing"}]} as FlyMachine);
    if(mode!=="create-absent")volume.attached_machine_id="candidate";
    if(mode==="create-loss" || mode==="create-absent")throw new Error("provider create response lost");
    return Response.json(machines[1]);
   }return Response.json(machines);
  }
  if(path.endsWith("/stop")){
   expect(request.headers.get("fly-machine-lease-nonce")).toBe(`nonce-${machine!.id}`);expect(await request.json()).toEqual({signal:"SIGTERM",timeout:"35s"});counts.oldStops++;if(mode!=="stop-pending")machine!.state="stopped";if(mode==="stop-loss")throw new Error("provider stop response lost");return new Response(null,{status:204});
  }
  if(path.endsWith("/start")){
   expect(["created","stopped"]).toContain(machines[0]!.state);counts.newStarts++;if(mode!=="start-pending")machine!.state="started";if(mode==="start-loss")throw new Error("provider start response lost");return new Response(null,{status:204});
  }
  if(machine && method==="POST"){
   const body=await request.json() as {config:FlyMachineConfig;current_version:string};expect(body.current_version).toBe(machine.instance_id);expect(request.headers.get("fly-machine-lease-nonce")).toBe(`nonce-${machine.id}`);counts.updates++;machine.config=body.config;machine.instance_id="updated_version";machine.image_ref.digest=body.config.image.split("@")[1]!;
  }
  return Response.json(machine);
 });
 const client=new FlyMachinesClient({token:"private-fixture"}),signal=new AbortController().signal;
 const execute=()=>executeManagedInstall(env,install,client,signal);
 const driver=new JobDriver(env.DB,env.JOBS_QUEUE),parentPayload={deploymentId:f.deployment.id,deployTargetId:f.target.id,orgSlug:"personal",region:"ord"};
 async function consume(job:JobRecord){await env.DB.prepare("UPDATE jobs SET available_at=NULL WHERE id=?").bind(job.id).run();const batch=createMessageBatch("logtura-jobs",[{id:job.id,timestamp:new Date(),attempts:1,body:{jobId:job.id}}]);await worker.queue(batch,env);expect((await getQueueResult(batch,createExecutionContext())).explicitAcks).toEqual([job.id]);return (await driver.getById(job.id))!;}
 return {...f,version,input,install,client,signal,before,volume,machines,calls,counts,execute,driver,parentPayload,consume,set mode(value:string){mode=value;},set onRequest(value:typeof onRequest){onRequest=value;},read:()=>readManagedInstall(env,f.userId,f.deployment.id,install.id),report:()=>acceptManagedRuntimeReport(install.runtime!,machines[1]!.config,f.deployment.heartbeat_token)};
}
it("atomically issues an encrypted replacement plan and preserves exact rollback without provider writes",async()=>{
 const f=await fixture();expect(f.install).toMatchObject({phase:"prepared",replacementPhase:"prepared",machineId:null,payload:{schemaVersion:3,name:`forwarder-${f.install.id}`,before:f.before,rollback:{...f.before.config,image:`registry.test/old@${f.before.image_ref.digest}`}}});
 expect((await f.state())!.activeInstanceId).toBe(f.install.runtime!.instance.instanceId);expect((await prepareIssuedManagedInstall(env,f.input)).id).toBe(f.install.id);expect(f.calls).toEqual([]);
 const row=await env.DB.prepare("SELECT CAST(payload_encrypted AS TEXT) AS ciphertext FROM managed_installations WHERE id=?").bind(f.install.id).first<{ciphertext:string}>();expect(row!.ciphertext).not.toContain("private-retained-token");expect(row!.ciphertext).not.toContain("private-source-token");
});
it("uses the public handoff with a D1 journal and binds the candidate without deleting rollback inputs",async()=>{
 const f=await fixture();expect(await f.execute()).toBe("candidate");expect(await f.read()).toMatchObject({phase:"installed",replacementPhase:"installed",machineId:"candidate"});expect(f.machines.map(m=>m.state)).toEqual(["stopped","started"]);expect(f.counts).toEqual({creates:1,oldStops:1,newStarts:1,updates:0});
 const version=await bindInstalledManagedRuntime(env,f.userId,f.deployment.id,f.install.id);expect((await f.read())!.installedConfigurationVersion).toBe(version);expect(await f.execute()).toBe("candidate");expect(f.counts).toEqual({creates:1,oldStops:1,newStarts:1,updates:0});expect(await f.state()).toMatchObject({stale:false,lastReportSequence:0});
 expect(await env.DB.prepare("SELECT lease_token,lease_until FROM managed_installations WHERE id=?").bind(f.install.id).first()).toEqual({lease_token:null,lease_until:null});
});
it.each(["create-loss","stop-loss","start-loss"])("recovers %s from encrypted intent with the same issued instance",async mode=>{
 const f=await fixture();f.mode=mode;await expect(f.execute()).rejects.toThrow("response lost");const instance=(await f.state())!.activeInstanceId;f.mode="normal";expect(await f.execute()).toBe("candidate");expect((await f.state())!.activeInstanceId).toBe(instance);expect(f.counts).toEqual({creates:1,oldStops:1,newStarts:1,updates:0});
});
it("never repeats an uncertain absent candidate create",async()=>{
 const f=await fixture();f.mode="create-absent";await expect(f.execute()).rejects.toThrow("response lost");f.mode="normal";await expect(f.execute()).rejects.toThrow("outcome is unknown");expect(f.counts.creates).toBe(1);expect((await f.read())!.replacementPhase).toBe("creating");expect(f.machines[0]!.state).toBe("started");
});
it.each(["stop-pending","start-pending"])("retains %s and resumes without a new issuance",async mode=>{
 const f=await fixture();f.mode=mode;await expect(f.execute()).rejects.toThrow("pending");expect((await f.read())!.replacementPhase).toBe("switching");f.mode="normal";expect(await f.execute()).toBe("candidate");expect(f.counts.creates).toBe(1);
});
it("holds the durable claim until the public operation completes and excludes concurrent queue recovery",async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);f.onRequest=async path=>{if(path.endsWith("/machines")){entered();await wait;}};
 const running=f.execute();await ready;await expect(f.execute()).rejects.toThrow("busy");release();expect(await running).toBe("candidate");expect(f.counts.creates).toBe(1);
});
it("detects expired or stolen D1 claims before another provider write",async()=>{
 const f=await fixture(),foreign=crypto.randomUUID();f.onRequest=async(path,method)=>{if(path.endsWith("/machines") && method==="POST")await env.DB.prepare("UPDATE managed_installations SET lease_token=?,lease_until=? WHERE id=?").bind(foreign,Date.now()+60000,f.install.id).run();};
 await expect(f.execute()).rejects.toThrow("lease expired");expect(f.machines[0]!.state).toBe("started");expect(f.counts.creates).toBe(1);expect(await env.DB.prepare("SELECT lease_token FROM managed_installations WHERE id=?").bind(f.install.id).first()).toEqual({lease_token:foreign});
 await env.DB.prepare("UPDATE managed_installations SET lease_until=0 WHERE id=?").bind(f.install.id).run();f.onRequest=undefined;expect(await f.execute()).toBe("candidate");expect(f.counts.creates).toBe(1);
});
it("fences a changed instance during provider create before stopping the old forwarder",async()=>{
 const f=await fixture();f.onRequest=async(path,method)=>{if(path.endsWith("/machines") && method==="POST"){const state=(await f.state())!;await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,state.desired.configurationVersion,state.activeInstanceId);}};
 await expect(f.execute()).rejects.toThrow("issued instance changed");expect(f.machines[0]!.state).toBe("started");expect((await f.read())!.replacementPhase).toBe("creating");expect(f.counts.oldStops).toBe(0);
});
it("the actual queue waits for an API-accepted candidate report before completing replacement",async()=>{
 const f=await fixture(),root=(await f.driver.enqueue({userId:f.userId,kind:"fly_deploy.create_or_update_machine",payload:{parentPayload:f.parentPayload,appName:"app",orgSlug:"personal",region:"ord",installationId:f.install.id}})).job;
 expect((await f.consume(root)).status).toBe("succeeded");const next=async()=>(await f.driver.listChildren(root.id)).find(job=>job.kind==="fly_deploy.wait_running" && job.status==="queued")!;
 expect((await f.consume(await next())).result).toMatchObject({polling:true});expect((await f.read())!.phase).toBe("installed");expect(await f.report()).toEqual({accepted:true,reportSequence:1});expect((await f.consume(await next())).status).toBe("succeeded");expect((await f.read())!.phase).toBe("completed");expect(await env.DB.prepare("SELECT status,bundle_outdated,external_id FROM deployments WHERE id=?").bind(f.deployment.id).first()).toEqual({status:"running",bundle_outdated:0,external_id:"fly:app:candidate"});
 expect((await selectManagedForwarder(env,f.userId,f.deployment.id,"app",f.machines))!.id).toBe("candidate");
});
it("rejects an old machine that resumes while waiting even after the candidate report was accepted",async()=>{
 const f=await fixture(),root=(await f.driver.enqueue({userId:f.userId,kind:"fly_deploy.create_or_update_machine",payload:{parentPayload:f.parentPayload,appName:"app",orgSlug:"personal",region:"ord",installationId:f.install.id}})).job;await f.consume(root);await f.report();f.machines[0]!.state="started";const wait=(await f.driver.listChildren(root.id)).find(job=>job.kind==="fly_deploy.wait_running")!;expect((await f.consume(wait)).lastError).toContain("retained rollback machine changed");expect((await f.read())!.phase).toBe("installed");
});
it("refuses missing replacement input before retiring any instance",async()=>{
 const f=await fixture();await env.DB.prepare("DELETE FROM managed_installations WHERE id=?").bind(f.install.id).run();const state=(await f.state())!;
 await expect(compileManagedInstallIntent(env,{...f.input,config:f.install.payload.after,machine:null},3)).rejects.toThrow("complete previous machine");expect((await f.state())!.activeInstanceId).toBe(state.activeInstanceId);
 await expect(compileManagedInstallIntent(env,{...f.input,config:f.install.payload.after,replacement:undefined},3)).rejects.toThrow("complete previous machine");
});
it.each(["stop-pending","start-pending"])("queues %s as a bounded same-instance continuation",async mode=>{
 const f=await fixture();f.mode=mode;const instance=f.install.runtime!.instance.instanceId,root=(await f.driver.enqueue({userId:f.userId,kind:"fly_deploy.create_or_update_machine",payload:{parentPayload:f.parentPayload,appName:"app",orgSlug:"personal",region:"ord",installationId:f.install.id}})).job;
 expect((await f.consume(root)).result).toMatchObject({pending:true,installationId:f.install.id});const continuation=(await f.driver.listChildren(root.id)).find(job=>job.kind===root.kind)!;expect(continuation.payload).toMatchObject({installationId:f.install.id,installDeadline:expect.any(Number)});expect((await f.read())!.phase).toBe("dispatched");
 f.mode="normal";expect((await f.consume(continuation)).status).toBe("succeeded");expect((await f.state())!.activeInstanceId).toBe(instance);expect(f.counts.creates).toBe(1);expect((await f.read())!.phase).toBe("installed");
});
it("retains the exact replacement journal when a bounded handoff deadline expires",async()=>{
 const f=await fixture();f.mode="stop-pending";const root=(await f.driver.enqueue({userId:f.userId,kind:"fly_deploy.create_or_update_machine",payload:{parentPayload:f.parentPayload,appName:"app",orgSlug:"personal",region:"ord",installationId:f.install.id,installDeadline:0}})).job;
 expect((await f.consume(root)).lastError).toContain("handoff deadline exceeded");expect(await f.driver.listChildren(root.id)).toEqual([]);expect((await f.read())!.replacementPhase).toBe("switching");expect(f.machines[0]!.state).toBe("started");
});
it("rejects an invalid continuation deadline before any provider handoff",async()=>{
 const f=await fixture();const root=(await f.driver.enqueue({userId:f.userId,kind:"fly_deploy.create_or_update_machine",payload:{parentPayload:f.parentPayload,appName:"app",orgSlug:"personal",region:"ord",installationId:f.install.id,installDeadline:-1}})).job;
 expect((await f.consume(root)).lastError).toContain("Invalid managed installation deadline");expect(f.counts.creates).toBe(0);expect((await f.read())!.replacementPhase).toBe("prepared");
});
async function completeReplacement(f:Awaited<ReturnType<typeof fixture>>){
 const root=(await f.driver.enqueue({userId:f.userId,kind:"fly_deploy.create_or_update_machine",payload:{parentPayload:f.parentPayload,appName:"app",orgSlug:"personal",region:"ord",installationId:f.install.id}})).job;
 expect((await f.consume(root)).status).toBe("succeeded");await f.report();const wait=(await f.driver.listChildren(root.id)).find(job=>job.kind==="fly_deploy.wait_running")!;expect((await f.consume(wait)).status).toBe("succeeded");
}
it("completes replacement of an unlaunched legacy VM without stopping or starting that rollback VM",async()=>{
 const f=await fixture("created");await completeReplacement(f);expect(f.counts).toEqual({creates:1,oldStops:0,newStarts:1,updates:0});expect(f.machines[0]!.state).toBe("created");expect((await selectManagedForwarder(env,f.userId,f.deployment.id,"app",f.machines))!.id).toBe("candidate");
});
it.each(["missing-old","running-old","changed-old-region","changed-old-image","changed-old-config","foreign-machine","missing-candidate","wrong-candidate-name","wrong-candidate-marker","wrong-binding"])("rejects %s in retained rollback inventory",async scenario=>{
 const f=await fixture();await completeReplacement(f);
 if(scenario==="missing-old")f.machines.shift();
 if(scenario==="running-old")f.machines[0]!.state="started";
 if(scenario==="changed-old-region")f.machines[0]!.region="iad";
 if(scenario==="changed-old-image")f.machines[0]!.image_ref.digest=`sha256:${"c".repeat(64)}`;
 if(scenario==="changed-old-config")f.machines[0]!.config.env={OLD:"external"};
 if(scenario==="foreign-machine")f.machines.push({...f.machines[1]!,id:"foreign"});
 if(scenario==="missing-candidate")f.machines.pop();
 if(scenario==="wrong-candidate-name")(f.machines[1] as FlyMachine & {name:string}).name="foreign";
 if(scenario==="wrong-candidate-marker")(f.machines[1]!.config.metadata as Record<string,string>)["logtura.replacement"]="foreign";
 if(scenario==="wrong-binding")await env.DB.prepare("UPDATE deployments SET external_id='fly:other:candidate' WHERE id=?").bind(f.deployment.id).run();
 await expect(selectManagedForwarder(env,f.userId,f.deployment.id,"app",f.machines)).rejects.toThrow();
});
it("does not treat names or provider metadata as ownership without an exact completed journal",async()=>{
 const f=await fixture();await expect(selectManagedForwarder(env,"other",f.deployment.id,"app",f.machines)).rejects.toThrow("no longer owned");
 await expect(selectManagedForwarder(env,f.userId,f.deployment.id,"other",f.machines)).rejects.toThrow("binding changed");await expect(selectManagedForwarder(env,f.userId,f.deployment.id,"app",[])).rejects.toThrow("bound forwarder is missing");
 await env.DB.prepare("UPDATE deployments SET external_id=NULL WHERE id=?").bind(f.deployment.id).run();expect(await selectManagedForwarder(env,f.userId,f.deployment.id,"app",[])).toBeNull();(f.machines[0] as FlyMachine & {name:string}).name="forwarder-foreign";await expect(selectManagedForwarder(env,f.userId,f.deployment.id,"app",f.machines)).rejects.toThrow("one owned forwarder");
});
it("allows a later issued update while retaining the journal-owned stopped rollback VM",async()=>{
 const f=await fixture();await completeReplacement(f);
 const input={...f.input,replacement:undefined,configurationVersion:await readConfigurationVersion(env.DB,f.userId),machine:f.machines[1]!,base:{...f.machines[1]!.config,image}};
 // Completion changes operational status but does not alter the desired manifest;
 // issue its next desired revision at the new graph clock before activation.
 const desired=(await f.state())!.desired;input.configurationVersion=(await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,input.configurationVersion,desired.sequence,input.document)).configurationVersion;
 const next=await prepareIssuedManagedInstall(env,input);expect(next.payload.schemaVersion).toBe(2);expect(next.payload.before!.id).toBe("candidate");
 expect(await executeManagedInstall(env,next,f.client,f.signal)).toBe("candidate");expect(f.counts.creates).toBe(1);expect(f.counts.updates).toBe(1);expect(f.machines[1]!.config).toEqual(next.payload.after);expect(f.machines[0]!.state).toBe("stopped");
});
it("fences an instance replaced between journal read and native SQL CAS",async()=>{
 const f=await fixture();let cursorPrepared=false,replaced=false;
 const db=new Proxy(env.DB,{get(target,key){if(key==="prepare")return(sql:string)=>{if(sql.includes("UPDATE managed_installations SET replacement_phase="))cursorPrepared=true;return target.prepare(sql);};if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(cursorPrepared && !replaced){replaced=true;const state=(await f.state())!;await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,state.desired.configurationVersion,state.activeInstanceId);}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 await expect(executeManagedInstall({...env,DB:db},f.install,f.client,f.signal)).rejects.toThrow("journal changed before transition");expect(f.counts.creates).toBe(0);expect((await f.read())!.replacementPhase).toBe("prepared");
});
it("does not clear a stolen claim when ownership changes between read and SQL CAS",async()=>{
 const f=await fixture(),foreign=crypto.randomUUID();let cursorPrepared=false,stolen=false;
 const db=new Proxy(env.DB,{get(target,key){if(key==="prepare")return(sql:string)=>{if(sql.includes("UPDATE managed_installations SET replacement_phase="))cursorPrepared=true;return target.prepare(sql);};if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(cursorPrepared && !stolen){stolen=true;await env.DB.prepare("UPDATE managed_installations SET lease_token=?,lease_until=? WHERE id=?").bind(foreign,Date.now()+60000,f.install.id).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 await expect(executeManagedInstall({...env,DB:db},f.install,f.client,f.signal)).rejects.toThrow("journal changed before transition");expect(f.counts.creates).toBe(0);expect(await env.DB.prepare("SELECT lease_token FROM managed_installations WHERE id=?").bind(f.install.id).first()).toEqual({lease_token:foreign});
});
it("rejects ownership removed between the native lease read and encrypted intent lookup",async()=>{
 const f=await fixture();let removed=false;
 function statementProxy(statement:D1PreparedStatement):D1PreparedStatement{return new Proxy(statement,{get(target,key){if(key==="bind")return(...values:unknown[])=>statementProxy(target.bind(...values));if(key==="first")return async(...args:[])=>{const result=await target.first(...args);if(!removed){removed=true;await env.DB.prepare("DELETE FROM managed_installations WHERE id=?").bind(f.install.id).run();}return result;};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});}
 const db=new Proxy(env.DB,{get(target,key){if(key==="prepare")return(sql:string)=>sql.startsWith("SELECT id FROM managed_installations WHERE id=? AND user_id=? AND lease_token=")?statementProxy(target.prepare(sql)):target.prepare(sql);const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
 await expect(executeManagedInstall({...env,DB:db},f.install,f.client,f.signal)).rejects.toThrow("replacement no longer owned");expect(f.counts.creates).toBe(0);expect(await f.read()).toBeNull();
});
