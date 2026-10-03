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
const image=`registry.test/forwarder@sha256:${"a".repeat(64)}`;
export async function managedReplacementFixture(options:{privateBytes?:number}={}){
 const f=await managedIssuedFixture(false);
 const before:FlyMachine={id:"legacy",name:"forwarder",instance_id:"old_version",state:"started",region:"ord",config:{image:"registry.test/old:tag",env:{OLD:"retained-private-token",...(options.privateBytes?{EXTRA:"x".repeat(options.privateBytes)}:{})},files:[{guest_path:"/etc/vector/vector.yaml",raw_value:"b2xkLXByaXZhdGU=",mode:0o400}],guest:{cpu_kind:"shared",cpus:2,memory_mb:4096},init:{cmd:["--config","/etc/vector/vector.yaml"]},checks:{vector_api:{port:8686}},restart:{policy:"always"}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}} as FlyMachine;
 await env.DB.prepare("UPDATE deployments SET external_id='fly:app:legacy',status='running' WHERE id=?").bind(f.deployment.id).run();
 const configurationVersion=(await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),0,f.input.document)).configurationVersion;
 const volume:FlyVolume={id:f.input.volume,region:"ord",state:"created",encrypted:true,attached_machine_id:null};
 const input={...f.input,configurationVersion,machine:before,base:{...before.config,image},replacement:{volume:volume.id,volumes:[volume]}};
 const installation=await prepareIssuedManagedInstall(env,input),machines=[structuredClone(before)];
 const counts={candidateStops:0,oldUpdates:0,oldStarts:0};let deletes=0;let mode="normal",onRequest:((path:string,method:string)=>Promise<void>)|undefined;
 mockFetch("https://api.machines.dev/",async request=>{
  const path=new URL(request.url).pathname,method=request.method;await onRequest?.(path,method);
  if(path==="/v1/apps/app")return Response.json({name:"app",organization:{slug:"personal"}});
  if(path.endsWith("/volumes"))return Response.json(mode==="missing-volume"?[]:[volume]);
  if(path.endsWith("/machines")){
   if(method==="POST"){
    const body=await request.json() as {name:string;region:string;config:FlyMachineConfig};
    const candidateId=deletes?`candidate${deletes+1}`:"candidate";machines.push({id:candidateId,name:body.name,instance_id:"new_version",state:"created",region:body.region,config:body.config,image_ref:{registry:"registry.test",repository:"forwarder",digest:body.config.image.split("@")[1]!}} as FlyMachine);volume.attached_machine_id=candidateId;if(mode==="create-loss")throw new Error("create response lost");return Response.json(machines[1]);
   }return Response.json(machines);
  }
  const id=path.match(/\/machines\/([^/]+)/)?.[1],machine=machines.find(item=>item.id===id)!;
  if(path.endsWith("/lease"))return method==="DELETE"?new Response(null,{status:204}):Response.json({data:{nonce:`nonce-${id}`}});
  if(path.endsWith("/stop")){
   expect(request.headers.get("fly-machine-lease-nonce")).toBe(`nonce-${id}`);
   if(id==="candidate")counts.candidateStops++;
   machine.state=mode==="stop-pending" && id==="candidate"?"stopping":"stopped";
   if(mode==="stop-loss" && id==="candidate" || mode==="old-stop-loss" && id==="legacy")throw new Error("stop response lost");return new Response(null,{status:204});
  }
  if(path.endsWith("/start")){
   if(id==="legacy"){expect(["created","stopped"]).toContain(machines[1]!.state);counts.oldStarts++;}
   machine.state=mode==="start-pending" && id==="legacy"?"starting":"started";
   if(mode==="start-loss" && id==="legacy" || mode==="candidate-start-loss" && id==="candidate")throw new Error("start response lost");return new Response(null,{status:204});
  }
  if(method==="DELETE"){
   expect(request.headers.get("fly-machine-lease-nonce")).toBe(`nonce-${id}`);expect(new URL(request.url).search).toBe("");expect(["created","stopped"]).toContain(machine.state);
   deletes++;if(mode!=="delete-pending" && mode!=="delete-before-loss"){machines.splice(machines.indexOf(machine),1);if(volume.attached_machine_id===id)volume.attached_machine_id=null;}
   if(mode==="delete-loss" || mode==="delete-before-loss")throw new Error("delete response lost");return new Response(null,{status:204});
  }
  if(method==="POST"){
   const body=await request.json() as {config:FlyMachineConfig;current_version:string};expect(body.current_version).toBe(machine.instance_id);expect(request.headers.get("fly-machine-lease-nonce")).toBe(`nonce-${id}`);
   if(id==="legacy")counts.oldUpdates++;
   machine.config=body.config;machine.instance_id=`updated_${Date.now()}`;machine.image_ref.digest=body.config.image.split("@")[1]!;
   if(mode==="update-loss" && id==="legacy")throw new Error("update response lost");
  }
  return Response.json(machine);
 });
 const client=new FlyMachinesClient({token:"private-fixture"}),signal=new AbortController().signal;
 async function complete(install=installation){
  await executeManagedInstall(env,install,client,signal);const version=await bindInstalledManagedRuntime(env,f.userId,f.deployment.id,install.id);
  await acceptManagedRuntimeReport(install.runtime!,machines[1]!.config,f.deployment.heartbeat_token);
  await completeIssuedManagedDeployment(env,(await readManagedInstall(env,f.userId,f.deployment.id,install.id))!,version);
 }
 const prepare=async()=>prepareManagedRollback(env,{userId:f.userId,deploymentId:f.deployment.id,replacementId:installation.id,configurationVersion:await readConfigurationVersion(env.DB,f.userId)});
 const cookie=`logtura_session=${await signCookie(f.userId,env.SESSION_SECRET)}`,driver=new JobDriver(env.DB,env.JOBS_QUEUE);
 const request=(body?:unknown)=>SELF.fetch(`https://example.com/api/deployments/${f.deployment.id}/rollback`,{method:body===undefined?"GET":"POST",headers:{cookie,origin:"https://example.com","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
 async function consume(job:JobRecord){await env.DB.prepare("UPDATE jobs SET available_at=NULL WHERE id=?").bind(job.id).run();const batch=createMessageBatch("logtura-jobs",[{id:job.id,timestamp:new Date(),attempts:1,body:{jobId:job.id}}]);await worker.queue(batch,env);expect((await getQueueResult(batch,createExecutionContext())).explicitAcks).toEqual([job.id]);return (await driver.getById(job.id))!;}
 const command=async()=>({replacementId:installation.id,configurationVersion:await readConfigurationVersion(env.DB,f.userId),deployTargetId:f.target.id});
 return {...f,input,installation,before,volume,machines,client,signal,counts,complete,prepare,request,command,driver,consume,cookie,get deletes(){return deletes;},set mode(value:string){mode=value;},set onRequest(value:typeof onRequest){onRequest=value;},execute:(rollback:Awaited<ReturnType<typeof prepare>>)=>executeManagedRollback(env,rollback,client,signal)};
}