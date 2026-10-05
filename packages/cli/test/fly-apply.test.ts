import {afterEach,expect,it,vi} from "vitest";
import * as fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {exportDeploymentManifest,createSecretVersioner,hashConfigDocument,LogturaServiceClient,FlyMachinesClient,type FlyMachine,type DeploymentConfigurationState,type DeploymentInstanceReceipt} from "@logtura/core";
import {readPrivateFlyReplacement,readPrivateFlyReplacementArchive} from "../src/fly-replacement-store";
import {cleanupLinkedFlyDeployment,readPendingFlyCleanup,PrivateFlyCleanupStore} from "../src/fly-cleanup";
import {rollbackLinkedFlyDeployment,readPendingFlyRollback} from "../src/fly-rollback";
import {applyLinkedFlyDeployment,readPendingFlyApply,abandonObsoleteFlyApply} from "../src/fly-apply";
import {readPendingActivation} from "../src/activation";
import {createDeploymentLink,deploymentStatus,readDeploymentLink} from "../src/deployment-link";
import {writePulledConfig} from "../src/pull";
import {pendingFlyApplyPath,pendingActivationPath,pendingFlyReplacementPath,pendingFlyRollbackPath,pendingFlyCleanupPath,assertNoPendingPush,commitFileTransaction} from "../src/file-transaction";
import {writeConfigDoc} from "../src/config";
import {main} from "../src/main";

vi.mock("node:fs",{spy:true});
const native=await vi.importActual<typeof fs>("node:fs"),roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.mocked(fs.linkSync).mockImplementation(native.linkSync);vi.mocked(fs.fsyncSync).mockImplementation(native.fsyncSync);vi.mocked(fs.lstatSync).mockImplementation(native.lstatSync);vi.mocked(fs.openSync).mockImplementation(native.openSync);vi.unstubAllEnvs();for(const root of roots.splice(0))native.rmSync(root,{recursive:true,force:true});});
import {image,indexImage,platformDigest,configDigest,registryBody} from "./oci-fixture";
async function fixture(){
 const root=fs.mkdtempSync(join(tmpdir(),"logt-fly-apply-"));roots.push(root);const config=join(root,"logt.yaml");
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[{connection:{id:"con_site",provider:"cloudflare-worker-tail",displayName:"Site",externalAccountId:"account"},credentials:{apiToken:"private-source-token"},selectedSources:[]}],monitors:[],heartbeat:{kind:"logtura",deploymentId:"dep_site",appUrl:"https://service.test"},runtimeEnv:{LOGTURA_HEARTBEAT_TOKEN:"private-report-token"}},await createSecretVersioner("service-private"));
 const revision=await hashConfigDocument(exported.document),result={...exported,revision,configurationVersion:3,desiredSequence:1,deployment:{id:"dep_site",displayName:"Site"},target:{kind:"fly" as const,managed:false,imageDigest:null,fly:{appName:"app",machineId:"abc123",region:"ord",orgSlug:"personal"}}};
 const link=await createDeploymentLink("https://service.test","usr_site",result);await writePulledConfig(result,config,false,link);
 let state:DeploymentConfigurationState={desired:{sequence:1,revision,document:exported.document,configurationVersion:3},applied:null,activeInstanceId:null,lastReportSequence:0,stale:false},receipt:DeploymentInstanceReceipt|null=null;
 let machine:FlyMachine={id:"abc123",instance_id:"version1",state:"started",region:"ord",config:{image:"registry.test/old:latest",env:{PREVIOUS_PRIVATE:"old-secret"},guest:{memory_mb:512},mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}]},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};
 let candidate:FlyMachine|undefined,binding:any=null,rollback:any=null,cleanup:any=null,cleanupDeletes=0,oldAbsent=false,candidateAbsent=false,snapshot={...result},creates=0;const rebases=new Map<string,any>();
 let lost=false,activationLost=false,acknowledge=true,updates=0,issuances=0,leaseFailure=false,releaseFailure=false,org="personal",extraMachine=false,volumeRegion="ord",mutateOnWait=false,wrongAccount=false;
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(new URL(String(url)).origin==="https://registry.test"){expect(new Headers(init?.headers).has("authorization")).toBe(false);const body=registryBody(path);return body===null?new Response(null,{status:404}):new Response(body);}
  if(String(url).startsWith("https://service.test")){
   if(path.endsWith("/me"))return Response.json({user:{id:wrongAccount?"usr_other":"usr_site",githubLogin:"site"}});
   if(path.endsWith("/state")){if(acknowledge && updates && receipt && state.activeInstanceId===receipt.instanceId){state.lastReportSequence=1;state.applied={sequence:1,revision,at:Date.now()};state.stale=false;if(mutateOnWait)machine.config.env={changed:"outside"};}return Response.json({state});}
   if(path.endsWith("/fly-capabilities"))return Response.json({schemaVersion:1,features:["replacement","image-update","rollback","cleanup"]});
   if(path.endsWith("/fly-binding"))return Response.json({binding:binding && binding.request.machineId!==binding.request.previousMachineId && snapshot.target.fly.machineId===binding.request.machineId?binding:null});
   if(path.includes("/fly-bindings/"))return binding?Response.json(binding):Response.json({error:"receipt_not_found"},{status:404});
   if(path.endsWith("/fly-cleanups")){
    const request=JSON.parse(init!.body as string);expect(fs.existsSync(pendingFlyCleanupPath(config))).toBe(true);
    cleanup={request,binding,rollback:request.rollbackRequestId?rollback:null,status:"prepared",fence:{configurationVersion:request.expectedConfigurationVersion,sequence:request.expectedSequence,revision:request.revision}};return Response.json(cleanup);
   }
   if(path.includes("/fly-cleanups/")){
    if(path.endsWith("/rebases")){const request=JSON.parse(init!.body as string),ack={cleanupId:cleanup.request.requestId,request};rebases.set(request.requestId,ack);cleanup={...cleanup,fence:{configurationVersion:request.configurationVersion,sequence:request.sequence,revision:request.revision}};return Response.json(ack);}
    if(path.includes("/rebases/")){const ack=rebases.get(path.split("/").at(-1)!);return ack?Response.json(ack):Response.json({error:"receipt_not_found"},{status:404});}
    if(path.endsWith("/complete")){expect(cleanup.request.rollbackRequestId?candidateAbsent:oldAbsent).toBe(true);expect((await readPendingFlyCleanup(config))!.state.phase).toBe("deleted");cleanup={...cleanup,status:"completed"};return Response.json(cleanup);}
    return cleanup?Response.json(cleanup):Response.json({error:"receipt_not_found"},{status:404});
   }
   if(path.endsWith("/fly-rollbacks")){
    const request=JSON.parse(init!.body as string);expect(fs.existsSync(pendingFlyRollbackPath(config)) || fs.existsSync(pendingFlyCleanupPath(config))).toBe(true);
    rollback={request,binding,status:"prepared",configurationVersion:request.expectedConfigurationVersion,fence:{configurationVersion:request.expectedConfigurationVersion,sequence:request.expectedSequence,revision:request.revision}};
    state.activeInstanceId=null;state.applied=null;state.lastReportSequence=0;return Response.json(rollback);
   }
   if(path.includes("/fly-rollbacks/")){
    if(path.endsWith("/rebases")){
     const request=JSON.parse(init!.body as string),ack={rollbackId:rollback.request.requestId,request};rebases.set(request.requestId,ack);rollback={...rollback,configurationVersion:request.configurationVersion,fence:{configurationVersion:request.configurationVersion,sequence:request.sequence,revision:request.revision}};return Response.json(ack);
    }
    if(path.includes("/rebases/")){const ack=rebases.get(path.split("/").at(-1)!);return ack?Response.json(ack):Response.json({error:"receipt_not_found"},{status:404});}
    if(path.endsWith("/complete")){
     expect(candidate!.state).toBe("stopped");expect(machine.state).toBe("started");expect(machine.config.image).toBe(binding.request.previousImageDigest?`registry.test/old@${binding.request.previousImageDigest}`:null);
     rollback={...rollback,status:"completed",configurationVersion:rollback.fence.configurationVersion+1};state.desired.configurationVersion=rollback.configurationVersion;
     snapshot={...snapshot,configurationVersion:rollback.configurationVersion,desiredSequence:state.desired.sequence,revision:state.desired.revision,target:{kind:"fly",managed:false,imageDigest:binding.request.previousImageDigest,fly:{appName:"app",machineId:"abc123",region:"ord",orgSlug:"personal"}}};return Response.json(rollback);
    }
    return rollback?Response.json(rollback):Response.json({error:"receipt_not_found"},{status:404});
   }
   if(path.endsWith("/fly-bindings")){const request=JSON.parse(init!.body as string);binding={request,configurationVersion:request.expectedConfigurationVersion+(request.machineId===request.previousMachineId?0:1)};state.desired.configurationVersion=binding.configurationVersion;snapshot={...result,configurationVersion:binding.configurationVersion,target:{kind:"fly",managed:false,imageDigest:request.imageDigest,fly:{appName:request.appName,machineId:request.machineId,region:request.region,orgSlug:request.orgSlug}}};return Response.json(binding);}
   if(path.endsWith("/config"))return Response.json(snapshot);
   if(init?.method==="POST"){const request=JSON.parse(init.body as string);issuances++;receipt={requestId:request.requestId,instanceId:randomUUID(),configurationVersion:3,sequence:1,revision};state.activeInstanceId=receipt.instanceId;expect(fs.existsSync(pendingActivationPath(config))).toBe(true);if(activationLost)throw new TypeError("activation acknowledgement lost");return Response.json(receipt);}
   return receipt?Response.json(receipt):Response.json({error:"receipt_not_found"},{status:404});
  }
  expect(new URL(String(url)).origin).toBe("https://api.machines.dev");
  if(path.endsWith("/lease")){expect(fs.existsSync(pendingFlyApplyPath(config)) || fs.existsSync(pendingFlyRollbackPath(config)) || fs.existsSync(pendingFlyCleanupPath(config))).toBe(true);if(init!.method==="DELETE")return new Response(null,{status:releaseFailure?500:204});if(leaseFailure)return new Response(null,{status:409});return Response.json({data:{nonce:"lease-secret"}});}
  const physical=path.includes("/def456")?candidate:machine;
  if(path.endsWith("/start")){physical!.state="started";return new Response(null,{status:204});}
  if(path.endsWith("/stop")){expect(fs.existsSync(pendingFlyApplyPath(config)) || fs.existsSync(pendingFlyRollbackPath(config)) || fs.existsSync(pendingFlyCleanupPath(config))).toBe(true);physical!.state="stopped";return new Response(null,{status:204});}
  if(path.endsWith("/machines") && init?.method==="POST"){
   creates++;updates++;const saved=readPrivateFlyReplacement(config);expect(saved?.phase).toBe("creating");expect(machine.state).toBe("started");const body=JSON.parse(init.body as string);expect(body.skip_launch).toBe(true);expect(body.config).toEqual(saved!.plan.after);
   candidate={id:"def456",name:body.name,region:body.region,instance_id:"candidate-version",state:"created",config:body.config,image_ref:{registry:"registry.test",repository:"forwarder",digest:platformDigest}} as FlyMachine;
   if(lost)throw new TypeError("candidate create acknowledgement lost");return Response.json(candidate);
  }
  if(init?.method==="POST"){
   updates++;const pending=await readPendingFlyApply(config);if(!rollback){expect(pending).not.toBeNull();expect(fs.statSync(pendingFlyApplyPath(config)).mode&0o777).toBe(0o600);}
   const body=JSON.parse(init.body as string);expect(body.current_version).toBe(machine.instance_id);expect(body.skip_launch).toBe(rollback?undefined:true);expect(machine.state).toBe("stopped");if(rollback){expect(candidate!.state).toBe("stopped");expect(body.config).toEqual(readPrivateFlyReplacement(config)!.plan.rollback);}else expect(body.config).toEqual(pending!.plan.after);expect(init.headers).toMatchObject({"fly-machine-lease-nonce":"lease-secret"});
   machine={...machine,instance_id:"version2",config:body.config,image_ref:rollback?machine.image_ref:{registry:"registry.test",repository:"forwarder",digest:platformDigest}};
   if(lost)throw new TypeError("machine update acknowledgement lost");return Response.json(machine);
  }
  if(init?.method==="DELETE"){
   const p=await readPendingFlyCleanup(config);expect(p?.state.phase).toBe("deleting");expect(path).toBe(`/v1/apps/app/machines/${p!.state.plan.retired.id}`);expect(new URL(String(url)).search).toBe("");expect(init.headers).toMatchObject({"fly-machine-lease-nonce":"lease-secret"});cleanupDeletes++;if(path.endsWith("/abc123"))oldAbsent=true;else candidateAbsent=true;return new Response(null,{status:204});
  }
  if(path.endsWith("/machines"))return Response.json(extraMachine?[machine,...(candidate?[candidate]:[]),{...machine,id:"other"}]:[...(oldAbsent?[]:[machine]),...(candidate && !candidateAbsent?[candidate]:[])]);
  if(path.endsWith("/volumes"))return Response.json([{id:"vol_checkpoint",region:volumeRegion,state:"created",encrypted:true,attached_machine_id:(machine.config.mounts as unknown[]|undefined)?.length && !oldAbsent?machine.id:(!candidateAbsent?candidate?.id:null)??null}]);
  if(path.endsWith("/abc123"))return oldAbsent?Response.json({}, {status:404}):Response.json(machine);
  if(path.endsWith("/def456"))return candidateAbsent?Response.json({}, {status:404}):Response.json(candidate);
  return Response.json({name:"app",organization:{slug:org}});
 });
 const client=new LogturaServiceClient({url:"https://service.test",token:`lt_cli_${"a".repeat(43)}`,fetch:fetcher}),fly=new FlyMachinesClient({token:"private-fly-token",fetch:fetcher}),options={fly,image,imageFetch:fetcher,volume:"vol_checkpoint",waitMs:20,pollMs:1};
 return {root,config,link,result,client,fly,options,fetcher,get creates(){return creates;},get cleanup(){return cleanup;},get cleanupDeletes(){return cleanupDeletes;},get oldAbsent(){return oldAbsent;},set oldAbsent(value:boolean){oldAbsent=value;},get candidateAbsent(){return candidateAbsent;},get candidate(){return candidate;},get binding(){return binding;},get rollback(){return rollback;},get state(){return state;},get machine(){return machine;},set machine(value){machine=value;},get updates(){return updates;},get issuances(){return issuances;},set lost(value:boolean){lost=value;},set activationLost(value:boolean){activationLost=value;},set acknowledge(value:boolean){acknowledge=value;},set leaseFailure(value:boolean){leaseFailure=value;},set releaseFailure(value:boolean){releaseFailure=value;},set org(value:string){org=value;},set extraMachine(value:boolean){extraMachine=value;},set volumeRegion(value:string){volumeRegion=value;},set mutateOnWait(value:boolean){mutateOnWait=value;},set wrongAccount(value:boolean){wrongAccount=value;}};
}
it("applies the issued runtime and archives exact private rollback material only after acknowledgement",async()=>{
 const f=await fixture(),original=structuredClone(f.machine);expect(await readPendingFlyApply(f.config)).toBeNull();
 const applied=await applyLinkedFlyDeployment(f.client,f.config,f.options);expect(applied).toMatchObject({app:"app",machineId:"abc123",revision:f.link.revision,image});expect(f.updates).toBe(1);expect(f.issuances).toBe(1);expect(await readPendingActivation(f.config)).toBeNull();expect(await readPendingFlyApply(f.config)).toBeNull();
 const archive=JSON.parse(fs.readFileSync(applied.rollbackFile,"utf8"));expect(archive.machine).toEqual(original);expect(archive.rollback).toEqual({...original.config,image:`registry.test/old@${original.image_ref.digest}`});expect(fs.statSync(applied.rollbackFile).mode&0o777).toBe(0o600);expect(JSON.stringify(applied)).not.toMatch(/old-secret|private-report-token|private-fly-token|lt_cli/);
 expect(archive.plan.after).toMatchObject({mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}],stop_config:{timeout:"35s"}});
 const rendered=Buffer.from(archive.plan.after.files.find((file:{guest_path:string})=>file.guest_path.endsWith("logtura-runtime.json")).raw_value,"base64").toString();expect(JSON.parse(rendered).instance.instanceId).toBe(applied.instanceId);
 assertNoPendingPush(f.config);
});
it("replaces a mountless bound forwarder without attempting an impossible in-place volume attachment",async()=>{
 const f=await fixture();delete f.machine.config.mounts;const original=structuredClone(f.machine);
 const applied=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});
 expect(applied.machineId).toBe("def456");expect(f.creates).toBe(1);expect(f.machine.state).toBe("stopped");expect(f.machine.config).toEqual(original.config);expect(f.candidate!.state).toBe("started");
 const archive=JSON.parse(fs.readFileSync(applied.rollbackFile,"utf8"));expect(archive.machine).toEqual(original);expect(archive.completion.replacement.phase).toBe("installed");expect(readPrivateFlyReplacement(f.config)).toBeNull();expect(readPrivateFlyReplacementArchive(f.config,applied.instanceId)).toEqual(archive.completion.replacement);
 expect(await readDeploymentLink(f.config)).toMatchObject({configurationVersion:4,target:{imageDigest:platformDigest,fly:{machineId:"def456"}}});expect(f.binding.request.previousMachineId).toBe("abc123");expect(f.binding.configurationVersion).toBe(4);assertNoPendingPush(f.config);
 const writes=f.fetcher.mock.calls.filter(([url,init])=>String(url).startsWith("https://api.machines.dev") && init?.method==="POST" && !String(url).endsWith("/lease")).map(([url])=>new URL(String(url)).pathname);
 expect(writes).toEqual(["/v1/apps/app/machines","/v1/apps/app/machines/abc123/stop","/v1/apps/app/machines/def456/start"]);
});
it("resumes a lost candidate create response with one dispatch and the same runtime instance",async()=>{
 const f=await fixture();delete f.machine.config.mounts;f.lost=true;await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("candidate create acknowledgement lost");
 const pending=(await readPendingFlyApply(f.config))!;expect(readPrivateFlyReplacement(f.config)?.phase).toBe("creating");expect(f.machine.state).toBe("started");f.lost=false;
 const applied=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200});expect(applied.instanceId).toBe(pending.artifact.instance.instanceId);expect(f.creates).toBe(1);expect(f.issuances).toBe(1);
});
it("recovers binding response loss through its immutable receipt without another provider installation",async()=>{
 const f=await fixture();delete f.machine.config.mounts;const fetcher=f.fetcher.getMockImplementation()!;let lose=true;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).endsWith("/fly-bindings") && init?.method==="POST"){lose=false;throw new Error("binding response lost");}return response;});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("binding response lost");expect(f.binding).not.toBeNull();
 const applied=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200});expect(applied.machineId).toBe("def456");expect(f.creates).toBe(1);expect(f.issuances).toBe(1);
});
it("recovers local target projection after rename without repeating a handoff or clearing acknowledgement fences",async()=>{
 const f=await fixture();delete f.machine.config.mounts;let fail=true;
 vi.mocked(fs.renameSync).mockImplementation((from,to)=>{native.renameSync(from,to);if(fail && String(to).endsWith(".logtura-link.json")){fail=false;throw new Error("projection acknowledgement lost");}});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("projection acknowledgement lost");
 expect(await readDeploymentLink(f.config)).toMatchObject({target:{fly:{machineId:"def456"}}});expect((await readPendingFlyApply(f.config))!.completion).toBeDefined();expect(readPrivateFlyReplacement(f.config)?.phase).toBe("installed");
 const applied=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200});expect(applied.machineId).toBe("def456");expect(f.creates).toBe(1);assertNoPendingPush(f.config);
});
it("recovers lost machine responses with the same descriptor and one provider update",async()=>{
 const f=await fixture();f.lost=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("update acknowledgement lost");const pending=await readPendingFlyApply(f.config);expect(pending).not.toBeNull();expect(await deploymentStatus(f.config)).toMatchObject({pendingActivation:{phase:"issued"}});
 expect(()=>assertNoPendingPush(f.config)).toThrow("Pending apply");expect(()=>writeConfigDoc(f.config,{...f.link.document})).toThrow("Pending apply");await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("--resume");
 f.lost=false;const applied=await applyLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:20,pollMs:1});const archive=JSON.parse(fs.readFileSync(applied.rollbackFile,"utf8"));expect(archive).toMatchObject(pending!);expect(f.updates).toBe(1);expect(f.issuances).toBe(1);
});
it("recovers uncertain activation before installation and retains intent when waiting times out",async()=>{
 const f=await fixture();f.activationLost=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("activation acknowledgement lost");expect(await readPendingFlyApply(f.config)).toBeNull();expect(f.updates).toBe(0);
 f.activationLost=false;f.acknowledge=false;await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow("acknowledgement pending");expect(f.issuances).toBe(1);expect(f.updates).toBe(1);
 f.acknowledge=true;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true});expect(f.updates).toBe(1);
});
it("validates account, target, storage, image and wait settings before instance issuance",async()=>{
 const f=await fixture();for(const overrides of [{image:undefined},{image:"latest"},{volume:"vol_missing"},{machine:"other"},{app:"other"},{region:"iad"},{org:"other"},{waitMs:0},{waitMs:600_001},{pollMs:0},{pollMs:30_001},{resume:true}])await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,...overrides})).rejects.toThrow();
 f.org="other";await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("organization");f.org="personal";f.extraMachine=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("retained forwarder");f.extraMachine=false;f.volumeRegion="iad";await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("volume");f.volumeRegion="ord";f.wrongAccount=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("account");
 expect(f.issuances).toBe(0);expect(f.updates).toBe(0);expect(await readPendingActivation(f.config)).toBeNull();
});
it("retains issued state across provider failure, competing updates and changed resume options",async()=>{
 const f=await fixture();f.leaseFailure=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("HTTP 409");expect(f.updates).toBe(0);
 for(const overrides of [{image:image.replace(platformDigest,`sha256:${"c".repeat(64)}`)},{volume:"vol_other"},{machine:"other"},{app:"other"}])await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,...overrides})).rejects.toThrow();
 f.leaseFailure=false;f.machine.instance_id="external-version";await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow("changed after planning");expect(f.updates).toBe(0);expect(await readPendingFlyApply(f.config)).not.toBeNull();
});
it("never finishes an obsolete instance or a machine edited while waiting",async()=>{
 const f=await fixture();f.acknowledge=false;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("pending");f.state.activeInstanceId=randomUUID();await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow("no longer current");expect(await readPendingFlyApply(f.config)).not.toBeNull();
 const changed=await fixture();changed.mutateOnWait=true;await expect(applyLinkedFlyDeployment(changed.client,changed.config,changed.options)).rejects.toThrow("changed while awaiting");expect(await readPendingActivation(changed.config)).not.toBeNull();
});
it("recovers a failed archive flush after activation completion without repeating installation",async()=>{
 const f=await fixture(),original=native.fsyncSync;let failed=false;
 vi.spyOn(fs,"fsyncSync").mockImplementation(fd=>{if(!failed && !fs.existsSync(pendingActivationPath(f.config)) && fs.existsSync(pendingFlyApplyPath(f.config))){failed=true;throw new Error("archive directory flush failed");}return original(fd);});
 await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("flush failed");vi.restoreAllMocks();expect(await readPendingActivation(f.config)).toBeNull();expect(await readPendingFlyApply(f.config)).not.toBeNull();const result=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true});expect(fs.existsSync(result.rollbackFile)).toBe(true);expect(f.updates).toBe(1);
});
it("rejects unsafe and corrupt journals and descriptor/plan tampering without provider writes",async()=>{
 const f=await fixture();f.leaseFailure=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("409");const path=pendingFlyApplyPath(f.config),contents=fs.readFileSync(path,"utf8"),pending=JSON.parse(contents);
 for(const mutation of [{schemaVersion:2},{config:"elsewhere"},{extra:true},{link:{}},{machine:{...pending.machine,id:"bad/id"}},{volume:"bad"},{artifact:{...pending.artifact,deploymentId:"foreign"}},{plan:{...pending.plan,version:"other"}},{rollback:{image}}]){fs.writeFileSync(path,JSON.stringify({...pending,...mutation}));await expect(readPendingFlyApply(f.config)).rejects.toThrow("Invalid private apply state");}
 fs.writeFileSync(path,JSON.stringify({...pending,plan:{...pending.plan,after:{...pending.plan.after,env:{...pending.plan.after.env,LOGTURA_HEARTBEAT_TOKEN:"changed"}}}}));await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow("differs");expect(f.updates).toBe(0);
 fs.writeFileSync(path,contents);fs.chmodSync(path,0o644);await expect(readPendingFlyApply(f.config)).rejects.toThrow("Invalid private apply state");fs.chmodSync(path,0o600);fs.writeFileSync(path,"{");await expect(readPendingFlyApply(f.config)).rejects.toThrow("Invalid private apply state");fs.writeFileSync(path," ".repeat(16_777_217));await expect(readPendingFlyApply(f.config)).rejects.toThrow("Invalid private apply state");fs.rmSync(path);fs.mkdirSync(path);await expect(readPendingFlyApply(f.config)).rejects.toThrow("regular");fs.rmdirSync(path);fs.symlinkSync(f.config,path);await expect(readPendingFlyApply(f.config)).rejects.toThrow("regular");
});
it("keeps filesystem publication failures recoverable and fences reserved transaction destinations",async()=>{
 const f=await fixture();const original=native.linkSync;vi.spyOn(fs,"linkSync").mockImplementation((source,destination)=>{if(destination===pendingFlyApplyPath(f.config))throw new Error("publish failed");return original(source,destination);});await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("publish failed");expect(f.updates).toBe(0);expect(await readPendingActivation(f.config)).not.toBeNull();vi.mocked(fs.linkSync).mockImplementation(native.linkSync);await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true});
 expect(()=>commitFileTransaction(pendingFlyApplyPath(f.config),[])).toThrow("reserved");
});
it("interrupts waiting and recovers without changing the issued installation",async()=>{
 const f=await fixture(),stop=new AbortController();stop.abort();await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,signal:stop.signal})).rejects.toThrow("interrupted");expect(f.issuances).toBe(0);
 f.acknowledge=false;const stopWaiting=new AbortController(),fetchImpl=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(url,init)=>{if(String(url).endsWith("/state") && f.updates>0)stopWaiting.abort();return fetchImpl(url,init);});await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200,signal:stopWaiting.signal})).rejects.toThrow("resume");expect(await readPendingFlyApply(f.config)).not.toBeNull();f.acknowledge=true;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true});
});
it("dispatches linked CLI apply without leaking credentials and preserves standalone deploy flag boundaries",async()=>{
 const f=await fixture();vi.stubEnv("FLY_API_TOKEN","private-fly-token");vi.spyOn(globalThis,"fetch").mockImplementation(f.fetcher);const output=vi.spyOn(console,"log").mockImplementation(()=>{}),error=vi.spyOn(console,"error").mockImplementation(()=>{});
 vi.stubEnv("LOGT_AUTH_FILE",join(f.root,"missing-account.json"));vi.stubEnv("LOGT_SERVICE_TOKEN",`lt_cli_${"a".repeat(43)}`);
 expect(await main(["-c",f.config,"deploy","fly","--output",f.root])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("Unsupported linked");vi.stubEnv("LOGT_SERVICE_URL","https://other.test");expect(await main(["-c",f.config,"deploy","fly"])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("origin");expect(output).not.toHaveBeenCalled();
 vi.stubEnv("LOGT_SERVICE_URL","");f.lost=true;
 expect(await main(["-c",f.config,"deploy","fly","--image",image,"--volume","vol_checkpoint","--wait-seconds","1"])).toBe(1);
 expect(error.mock.calls.at(-1)![0]).toContain("acknowledgement lost");f.lost=false;
 expect(await main(["-c",f.config,"deploy","fly","--resume","--json"])).toBe(0);expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({app:"app",revision:f.link.revision});
 const second=await fixture();vi.spyOn(globalThis,"fetch").mockImplementation(second.fetcher);
 expect(await main(["-c",second.config,"deploy","fly","--image",image,"--volume","vol_checkpoint"])).toBe(0);expect(output.mock.calls.at(-1)![0]).toContain("Applied");
 expect(JSON.stringify(output.mock.calls)).not.toMatch(/private-report-token|private-fly-token|old-secret/);
});
it("handles apply-fence access errors and unsafe journal opens without discarding recovery files",async()=>{
 const f=await fixture(),original=native.lstatSync;
 vi.spyOn(fs,"lstatSync").mockImplementation(((path:fs.PathLike,options?:unknown)=>{if(String(path)===pendingFlyApplyPath(f.config))throw Object.assign(new Error("access denied"),{code:"EACCES"});return original(path,options as never);}) as typeof fs.lstatSync);
 expect(()=>assertNoPendingPush(f.config)).toThrow("access denied");await expect(readPendingFlyApply(f.config)).rejects.toThrow("regular");vi.mocked(fs.lstatSync).mockImplementation(native.lstatSync);
 f.leaseFailure=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("409");
 const originalOpen=native.openSync;vi.spyOn(fs,"openSync").mockImplementation(((path:fs.PathLike,...args:unknown[])=>{if(String(path)===pendingFlyApplyPath(f.config))throw new Error("unsafe open");return originalOpen(path,args[0] as never,args[1] as never);}) as typeof fs.openSync);
 await expect(readPendingFlyApply(f.config)).rejects.toThrow("regular");vi.mocked(fs.openSync).mockImplementation(native.openSync);
});
it("cancels the wait through an abort listener and preserves a pre-install cancellation",async()=>{
 const f=await fixture();f.acknowledge=false;const stop=new AbortController(),listen=stop.signal.addEventListener.bind(stop.signal);
 vi.spyOn(stop.signal,"addEventListener").mockImplementation((type,listener,options)=>{listen(type,listener,options);queueMicrotask(()=>stop.abort());});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:1000,pollMs:1000,signal:stop.signal})).rejects.toThrow("resume");expect(f.updates).toBe(1);
 const before=await fixture(),preStop=new AbortController(),beforeFetch=before.fetcher.getMockImplementation()!;
 before.fetcher.mockImplementation(async(url,init)=>{const response=await beforeFetch(url,init);if(String(url).endsWith("/state") && fs.existsSync(pendingFlyApplyPath(before.config)))preStop.abort();return response;});
 await expect(applyLinkedFlyDeployment(before.client,before.config,{...before.options,signal:preStop.signal})).rejects.toThrow("interrupted");expect(before.updates).toBe(0);expect(await readPendingFlyApply(before.config)).not.toBeNull();
});
it("rejects local edits during pending apply and retains conflicting completed archive files",async()=>{
 const f=await fixture();f.leaseFailure=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("409");
 fs.writeFileSync(f.config,JSON.stringify({...f.link.document,discoverMonitors:true}));await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow("Local configuration changed");fs.writeFileSync(f.config,JSON.stringify(f.link.document));
 const pending=(await readPendingFlyApply(f.config))!,archive=join(f.root,`.logtura-applied-${pending.artifact.instance.instanceId}.json`);fs.writeFileSync(archive,"unrelated recovery record",{mode:0o600});f.leaseFailure=false;
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow();expect(fs.readFileSync(archive,"utf8")).toBe("unrelated recovery record");expect(await readPendingFlyApply(f.config)).not.toBeNull();
});

it("archives only obsolete owned apply state and leaves current or unknown server outcomes recoverable",async()=>{
 const f=await fixture();await expect(abandonObsoleteFlyApply(f.client,f.config)).rejects.toThrow("No pending");f.leaseFailure=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("409");
 await expect(abandonObsoleteFlyApply(f.client,f.config)).rejects.toThrow("still current");f.wrongAccount=true;await expect(abandonObsoleteFlyApply(f.client,f.config)).rejects.toThrow("account");f.wrongAccount=false;
 const original=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/state")?Response.json({state:null}):original(url,init));await expect(abandonObsoleteFlyApply(f.client,f.config)).rejects.toThrow("still current");
 f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/state")?Response.json({error:"unavailable"},{status:503}):original(url,init));await expect(abandonObsoleteFlyApply(f.client,f.config)).rejects.toThrow();f.fetcher.mockImplementation(original);
 f.state.activeInstanceId=randomUUID();const before=f.updates,archive=await abandonObsoleteFlyApply(f.client,f.config);expect(JSON.parse(fs.readFileSync(archive,"utf8")).artifact.instance.instanceId).not.toBe(f.state.activeInstanceId);expect(f.updates).toBe(before);expect(await readPendingActivation(f.config)).toBeNull();expect(await readPendingFlyApply(f.config)).toBeNull();assertNoPendingPush(f.config);
 const deleted=await fixture();deleted.leaseFailure=true;await expect(applyLinkedFlyDeployment(deleted.client,deleted.config,deleted.options)).rejects.toThrow("409");const fetcher=deleted.fetcher.getMockImplementation()!;deleted.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/state")?Response.json({error:"not_found"},{status:404}):fetcher(url,init));expect(await abandonObsoleteFlyApply(deleted.client,deleted.config)).toContain("abandoned");
});
it("recovers interrupted obsolete-state archive publication and exposes explicit CLI recovery",async()=>{
 const f=await fixture();f.leaseFailure=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("409");f.state.activeInstanceId=randomUUID();
 let failed=false;vi.spyOn(fs,"fsyncSync").mockImplementation(fd=>{if(!failed && !fs.existsSync(pendingActivationPath(f.config))){failed=true;throw new Error("abandon flush failed");}return native.fsyncSync(fd);});await expect(abandonObsoleteFlyApply(f.client,f.config)).rejects.toThrow("flush failed");vi.mocked(fs.fsyncSync).mockImplementation(native.fsyncSync);
 vi.stubEnv("LOGT_AUTH_FILE",join(f.root,"missing-account.json"));vi.stubEnv("LOGT_SERVICE_TOKEN",`lt_cli_${"a".repeat(43)}`);vi.spyOn(globalThis,"fetch").mockImplementation(f.fetcher);const output=vi.spyOn(console,"log").mockImplementation(()=>{}),error=vi.spyOn(console,"error").mockImplementation(()=>{});
 expect(await main(["-c",f.config,"deploy","fly","--abandon","--resume"])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("combined");expect(await main(["-c",f.config,"deploy","fly","--abandon","--cancel-rejected"])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("Choose one");expect(await main(["-c",f.config,"deploy","fly","--abandon","--json"])).toBe(0);expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({abandoned:true});
});

it("resolves an OCI index before issuance and resumes its exact platform pin",async()=>{
 const f=await fixture();f.lost=true;
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,image:indexImage})).rejects.toThrow("acknowledgement lost");
 const saved=(await readPendingFlyApply(f.config))!;expect(saved.plan.after.image).toBe(image);expect(saved.plan.after.image).not.toContain(configDigest);
 f.lost=false;const applied=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,image:indexImage,resume:true});
 expect(applied.image).toBe(image);expect(f.issuances).toBe(1);expect(f.updates).toBe(1);expect(JSON.parse(fs.readFileSync(applied.rollbackFile,"utf8"))).toMatchObject(saved);
});
it("refuses unverifiable registry bytes before retiring the previous runtime",async()=>{
 const f=await fixture();const original=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>String(url).startsWith("https://registry.test/")?new Response("private-registry-body",{status:503}):original(url,init));
 await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("HTTP 503");
 expect(f.issuances).toBe(0);expect(f.updates).toBe(0);expect(await readPendingActivation(f.config)).toBeNull();expect(await readPendingFlyApply(f.config)).toBeNull();
});
it("recovers the saved platform pin without registry access and requires Fly's manifest identity",async()=>{
 const f=await fixture();f.acknowledge=false;
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,image:indexImage})).rejects.toThrow("pending");
 const original=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>{if(String(url).startsWith("https://registry.test/"))throw new Error("registry offline");return original(url,init);});
 f.acknowledge=true;f.machine.image_ref.digest=configDigest;
 await expect(applyLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:5,pollMs:1})).rejects.toThrow("changed while awaiting");
 expect(await readPendingFlyApply(f.config)).not.toBeNull();f.machine.image_ref.digest=platformDigest;
 expect((await applyLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:20,pollMs:1})).image).toBe(image);expect(f.updates).toBe(1);
});

it("passes explicit CLI pull credentials only to the registry",async()=>{
 const f=await fixture(),original=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>{if(String(url).startsWith("https://registry.test/")){expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-registry-token");return new Response(registryBody(new URL(String(url)).pathname));}expect(new Headers(init?.headers).get("authorization")).not.toBe("Bearer private-registry-token");return original(url,init);});
 vi.stubEnv("LOGT_REGISTRY_TOKEN","private-registry-token");vi.stubEnv("FLY_API_TOKEN","private-fly-token");vi.stubEnv("LOGT_AUTH_FILE",join(f.root,"missing-profile"));vi.stubEnv("LOGT_SERVICE_TOKEN",`lt_cli_${"a".repeat(43)}`);vi.stubEnv("LOGT_SERVICE_URL","");
 vi.spyOn(globalThis,"fetch").mockImplementation(f.fetcher);const output=vi.spyOn(console,"log").mockImplementation(()=>{}),error=vi.spyOn(console,"error").mockImplementation(()=>{});
 expect(await main(["-c",f.config,"deploy","fly","--image",indexImage,"--volume","vol_checkpoint","--json"])).toBe(0);
 expect(JSON.parse(output.mock.calls.at(-1)![0]).image).toBe(image);expect(JSON.stringify(output.mock.calls)+JSON.stringify(error.mock.calls)).not.toContain("private-registry-token");
 const archive=JSON.parse(fs.readFileSync(JSON.parse(output.mock.calls.at(-1)![0]).rollbackFile,"utf8"));expect(JSON.stringify(archive)).not.toContain("private-registry-token");
});

it("cancels read-only image preflight without issuing a replacement runtime",async()=>{
 const f=await fixture(),stop=new AbortController(),original=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>{const result=await original(url,init);if(String(url).startsWith("https://registry.test/"))stop.abort();return result;});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,signal:stop.signal})).rejects.toThrow("interrupted");
 expect(f.issuances).toBe(0);expect(f.updates).toBe(0);expect(await readPendingActivation(f.config)).toBeNull();expect(await readPendingFlyApply(f.config)).toBeNull();
});

it("rejects unsupported service capabilities before issuing an instance or touching the provider",async()=>{
 for(const value of [{schemaVersion:1,features:["replacement"]},{schemaVersion:2,features:["replacement","image-update","rollback","cleanup"]},{schemaVersion:1,features:null}]){
  const f=await fixture(),fetcher=f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/fly-capabilities")?Response.json(value):fetcher(url,init));
  await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("Update the service");
  expect(f.issuances).toBe(0);expect(f.updates).toBe(0);expect(f.creates).toBe(0);expect(await readPendingActivation(f.config)).toBeNull();
 }
});
it("preserves all journals when an obsolete apply has an uncertain candidate create",async()=>{
 const f=await fixture();delete f.machine.config.mounts;f.lost=true;
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("candidate create acknowledgement lost");
 const apply=fs.readFileSync(pendingFlyApplyPath(f.config),"utf8"),activation=await readPendingActivation(f.config),replacement=readPrivateFlyReplacement(f.config);
 f.state.activeInstanceId=randomUUID();await expect(abandonObsoleteFlyApply(f.client,f.config)).rejects.toThrow("reconciled or rolled back");
 expect(fs.readFileSync(pendingFlyApplyPath(f.config),"utf8")).toBe(apply);expect(await readPendingActivation(f.config)).toEqual(activation);expect(readPrivateFlyReplacement(f.config)).toEqual(replacement);expect(f.creates).toBe(1);expect(f.machine.state).toBe("started");
});
it("validates every private completion against its immutable intent before any recovery write",async()=>{
 const f=await fixture();delete f.machine.config.mounts;const applied=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});
 const completed=JSON.parse(fs.readFileSync(applied.rollbackFile,"utf8"));
 for(const mutate of [
  (v:any)=>{v.link.target.fly.machineId="abcdef";},
  (v:any)=>{v.completion={};},
  (v:any)=>{v.completion.binding.request.instanceId=randomUUID();},
  (v:any)=>{v.completion.link.configurationVersion++;},
  (v:any)=>{v.completion.replacement=null;},
  (v:any)=>{v.completion.replacement.phase="switching";},
 ]){
  const changed=structuredClone(completed);mutate(changed);fs.writeFileSync(pendingFlyApplyPath(f.config),JSON.stringify(changed),{mode:0o600});
  await expect(readPendingFlyApply(f.config)).rejects.toThrow("Invalid private apply state");
 }
 const inplace=await fixture(),updated=await applyLinkedFlyDeployment(inplace.client,inplace.config,inplace.options),value=JSON.parse(fs.readFileSync(updated.rollbackFile,"utf8"));value.completion.replacement=completed.completion.replacement;
 fs.writeFileSync(pendingFlyApplyPath(inplace.config),JSON.stringify(value),{mode:0o600});await expect(readPendingFlyApply(inplace.config)).rejects.toThrow("Invalid private apply state");
});
it("retains intent when graph state becomes stale while recovering a mounted installation",async()=>{
 const f=await fixture();f.leaseFailure=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("409");f.leaseFailure=false;f.state.stale=true;f.acknowledge=false;
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow("Configuration changed");expect(f.updates).toBe(0);expect(await readPendingFlyApply(f.config)).not.toBeNull();
});
it("refuses recovered binding receipts with a different intent or rollback identity",async()=>{
 for(const patch of [{machineId:"abcdef"},{previousConfigDigest:`sha256:${"e".repeat(64)}`}]){
  const f=await fixture();delete f.machine.config.mounts;const fetcher=f.fetcher.getMockImplementation()!;let lose=true;
  f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).endsWith("/fly-bindings") && init?.method==="POST"){lose=false;throw new Error("binding lost");}return response;});
  await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("binding lost");
  f.fetcher.mockImplementation(async(url,init)=>String(url).includes("/fly-bindings/")?Response.json({...f.binding,request:{...f.binding.request,...patch}}):fetcher(url,init));
  await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200})).rejects.toThrow("Binding receipt differs");expect(f.creates).toBe(1);
 }
});
it("preserves a bound candidate when its durable replacement journal is missing",async()=>{
 const f=await fixture();delete f.machine.config.mounts;const fetcher=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(String(url).endsWith("/fly-bindings") && init?.method==="POST")throw new Error("binding lost");return response;});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("binding lost");
 fs.rmSync(pendingFlyReplacementPath(f.config));f.fetcher.mockImplementation(fetcher);
 // The preflight inventory also rejects losing the receipt's owned candidate.
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200})).rejects.toThrow();expect(f.creates).toBe(1);expect(await readPendingFlyApply(f.config)).not.toBeNull();
});
it("resumes after replacement archive acknowledgement without repeating provider writes",async()=>{
 const f=await fixture();delete f.machine.config.mounts;let fail=true;
 vi.mocked(fs.linkSync).mockImplementation((from,to)=>{if(fail && String(to).includes(".logtura-applied-")){fail=false;throw new Error("apply archive lost");}return native.linkSync(from,to);});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("apply archive lost");
 expect(readPrivateFlyReplacement(f.config)).toBeNull();expect((await readPendingFlyApply(f.config))!.completion).toBeDefined();
 const applied=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200});expect(applied.machineId).toBe("def456");expect(f.creates).toBe(1);assertNoPendingPush(f.config);
});
it("retains apply state when the service export changes after accepted installation",async()=>{
 const f=await fixture(),fetcher=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(String(url).endsWith("/config")){const snapshot=await response.json();return Response.json({...snapshot,configurationVersion:99});}return response;});
 await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("Remote binding changed");expect(f.updates).toBe(1);expect(await readPendingFlyApply(f.config)).not.toBeNull();
});
it("retains a pending handoff while observing a slow stop and resumes without a second create",async()=>{
 const f=await fixture();delete f.machine.config.mounts;const fetcher=f.fetcher.getMockImplementation()!;let hold=true;
 f.fetcher.mockImplementation(async(url,init)=>hold && String(url).endsWith("/abc123/stop")?new Response(null,{status:204}):fetcher(url,init));
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:100,pollMs:2})).rejects.toThrow("Fly handoff pending");expect(f.creates).toBe(1);expect(f.machine.state).toBe("started");expect(readPrivateFlyReplacement(f.config)?.phase).toBe("switching");
 hold=false;const applied=await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200});expect(applied.machineId).toBe("def456");expect(f.creates).toBe(1);
});
it("responds to cancellation while waiting for acknowledgement and retains all intent",async()=>{
 const f=await fixture();f.acknowledge=false;const controller=new AbortController(),fetcher=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(f.updates && String(url).endsWith("/abc123"))setTimeout(()=>controller.abort(),5);return response;});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200,pollMs:50,signal:controller.signal})).rejects.toThrow("interrupted");expect(await readPendingFlyApply(f.config)).not.toBeNull();expect(f.updates).toBe(1);
});
it("refuses a changed provider organization during replacement recovery",async()=>{
 const f=await fixture();delete f.machine.config.mounts;f.lost=true;await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("candidate create acknowledgement lost");f.org="elsewhere";
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow("organization");expect(f.creates).toBe(1);
});
it("rejects a missing linked machine and a region mismatch before activation",async()=>{
 const missing=await fixture();missing.machine.id="abcdef";await expect(applyLinkedFlyDeployment(missing.client,missing.config,missing.options)).rejects.toThrow("bound existing");expect(missing.issuances).toBe(0);
 const region=await fixture();region.machine.region="iad";await expect(applyLinkedFlyDeployment(region.client,region.config,region.options)).rejects.toThrow("region");expect(region.issuances).toBe(0);
 const unlinked=await fixture();fs.rmSync(`${unlinked.config}.logtura-link.json`);await expect(applyLinkedFlyDeployment(unlinked.client,unlinked.config,unlinked.options)).rejects.toThrow("Pull a hosted");expect(unlinked.issuances).toBe(0);
});

it("refuses to archive success if the acknowledged candidate stops during local projection",async()=>{
 const f=await fixture();delete f.machine.config.mounts;let stop=true;
 vi.mocked(fs.renameSync).mockImplementation((from,to)=>{native.renameSync(from,to);if(stop && String(to).endsWith(".logtura-link.json")){stop=false;f.candidate!.state="stopped";}});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("Accepted runtime changed");
 expect(await readPendingFlyApply(f.config)).not.toBeNull();expect(readPrivateFlyReplacement(f.config)).not.toBeNull();f.candidate!.state="started";
 await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200});expect(f.creates).toBe(1);assertNoPendingPush(f.config);
});
it("refuses a missing private archive after the replacement journal was acknowledged",async()=>{
 const f=await fixture();delete f.machine.config.mounts;let fail=true;
 vi.mocked(fs.linkSync).mockImplementation((from,to)=>{if(fail && String(to).includes(".logtura-applied-")){fail=false;throw new Error("archive interrupted");}return native.linkSync(from,to);});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("archive interrupted");
 const pending=(await readPendingFlyApply(f.config))!;fs.rmSync(join(f.root,`.logtura-replaced-${pending.artifact.instance.instanceId}.json`));
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true,waitMs:200})).rejects.toThrow("Replacement archive is missing");expect(await readPendingFlyApply(f.config)).not.toBeNull();expect(f.creates).toBe(1);
});
it("rolls back a completed replacement with retired reports and exact immutable old settings",async()=>{
 const f=await fixture();delete f.machine.config.mounts;const old=structuredClone(f.machine);
 await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const result=await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1});
 expect(result).toMatchObject({machineId:"abc123",candidateMachineId:"def456",applied:null,needsPull:false});expect(f.machine.state).toBe("started");expect(f.candidate!.state).toBe("stopped");expect(f.machine.config).toEqual({...old.config,image:`registry.test/old@${old.image_ref.digest}`});
 expect(f.rollback.status).toBe("completed");expect(f.state.activeInstanceId).toBeNull();expect(f.state.applied).toBeNull();expect(await readPendingFlyRollback(f.config)).toBeNull();expect(readPrivateFlyReplacement(f.config)).toBeNull();expect(fs.statSync(result.rollbackFile).mode&0o777).toBe(0o600);
 expect(await readDeploymentLink(f.config)).toMatchObject({configurationVersion:5,target:{fly:{machineId:"abc123"},imageDigest:old.image_ref.digest}});assertNoPendingPush(f.config);expect(f.creates).toBe(1);
});
it("recovers a lost retirement acknowledgement before stopping either machine",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;let lose=true;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).endsWith("/fly-rollbacks") && init?.method==="POST"){lose=false;throw new Error("retirement acknowledgement lost");}return response;});
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1})).rejects.toThrow("retirement acknowledgement lost");expect(f.candidate!.state).toBe("started");expect(f.machine.state).toBe("stopped");expect(await readPendingFlyRollback(f.config)).not.toBeNull();expect((await deploymentStatus(f.config)).pendingRollback).toMatchObject({machineId:"abc123",candidateMachineId:"def456",completed:false});expect(()=>assertNoPendingPush(f.config)).toThrow("Pending Fly rollback");
 const result=await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1});expect(result.machineId).toBe("abc123");expect(f.creates).toBe(1);
});
it("recovers a lost completion response without starting the old machine twice",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;let lose=true;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).includes("/fly-rollbacks/") && String(url).endsWith("/complete")){lose=false;throw new Error("completion acknowledgement lost");}return response;});
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1})).rejects.toThrow("completion acknowledgement lost");const starts=f.fetcher.mock.calls.filter(([url,init])=>String(url).endsWith("/abc123/start") && init?.method==="POST").length;
 expect(f.rollback.status).toBe("completed");await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1});expect(f.fetcher.mock.calls.filter(([url,init])=>String(url).endsWith("/abc123/start") && init?.method==="POST")).toHaveLength(starts);
});
it("resumes local rollback projection after rename without repeating the provider handoff",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});let lose=true;
 vi.mocked(fs.renameSync).mockImplementation((from,to)=>{native.renameSync(from,to);if(lose && String(to).endsWith(".logtura-link.json")){lose=false;throw new Error("rollback projection lost");}});
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1})).rejects.toThrow("rollback projection lost");expect(readPrivateFlyReplacement(f.config)).toBeNull();expect((await readPendingFlyRollback(f.config))!.completion!.status).toBe("completed");expect((await deploymentStatus(f.config)).pendingRollback).toMatchObject({completed:true});
 const starts=f.fetcher.mock.calls.filter(([url])=>String(url).endsWith("/abc123/start")).length;
 await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1});expect(f.fetcher.mock.calls.filter(([url])=>String(url).endsWith("/abc123/start"))).toHaveLength(starts);assertNoPendingPush(f.config);
});
it("supports repeated explicit website rebases while an asynchronous rollback remains pending",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;let hold=true;
 f.fetcher.mockImplementation(async(url,init)=>{if(hold && String(url).endsWith("/abc123/start"))return new Response(null,{status:204});const response=await fetcher(url,init);if(String(url).endsWith("/config")){const snapshot=await response.json();return Response.json({...snapshot,configurationVersion:f.state.desired.configurationVersion,desiredSequence:f.state.desired.sequence,revision:f.state.desired.revision});}return response;});
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:100,pollMs:1})).rejects.toThrow("handoff pending");f.state.desired.configurationVersion++;
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:100,pollMs:1})).rejects.toThrow("--rebase");
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,rebase:true,waitMs:100,pollMs:1})).rejects.toThrow("handoff pending");const previous=(await readPendingFlyRollback(f.config))!.rebase!.requestId;
 f.state.desired.configurationVersion++;hold=false;
 const result=await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,rebase:true,waitMs:200,pollMs:1});const archived=JSON.parse(fs.readFileSync(result.rollbackFile,"utf8"));expect(archived.rebase.requestId).not.toBe(previous);expect(f.fetcher.mock.calls.filter(([url,init])=>String(url).endsWith("/rebases") && init?.method==="POST")).toHaveLength(2);expect(f.creates).toBe(1);expect(result.applied).toBeNull();
});
it("explicitly reconciles a completed rollback after a newer website edit without repeating lifecycle writes",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;let lose=true;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).includes("/fly-rollbacks/") && String(url).endsWith("/complete")){lose=false;throw new Error("completion lost");}if(String(url).endsWith("/config")){const snapshot=await response.json();return Response.json({...snapshot,configurationVersion:f.state.desired.configurationVersion});}return response;});
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1})).rejects.toThrow("completion lost");f.state.desired.configurationVersion++;
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1})).rejects.toThrow("--rebase");
 const writes=f.fetcher.mock.calls.filter(([url,init])=>String(url).startsWith("https://api.machines.dev") && init?.method==="POST").length;
 const result=await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,rebase:true,waitMs:200,pollMs:1});expect(result.applied).toBeNull();expect(f.fetcher.mock.calls.filter(([url,init])=>String(url).startsWith("https://api.machines.dev") && init?.method==="POST")).toHaveLength(writes);expect(await readDeploymentLink(f.config)).toMatchObject({configurationVersion:6,target:{fly:{machineId:"abc123"}}});
});
it("preserves and archives a bound apply interrupted before replacement acknowledgement",async()=>{
 const f=await fixture();delete f.machine.config.mounts;let lose=true;
 vi.mocked(fs.renameSync).mockImplementation((from,to)=>{native.renameSync(from,to);if(lose && String(to).endsWith(".logtura-link.json")){lose=false;throw new Error("apply projection lost");}});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("apply projection lost");expect(await readPendingFlyApply(f.config)).not.toBeNull();expect(readPrivateFlyReplacement(f.config)).not.toBeNull();
 const result=await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1});expect(result.machineId).toBe("abc123");expect(await readPendingFlyApply(f.config)).toBeNull();expect(await readPendingFlyRollback(f.config)).toBeNull();expect(fs.readdirSync(f.root).some(name=>name.startsWith(".logtura-abandoned-"))).toBe(true);assertNoPendingPush(f.config);
});
it("rejects unsafe rollback/archived-apply identities and retains explicit private write fences",async()=>{
 const f=await fixture();expect(await readPendingFlyRollback(f.config)).toBeNull();await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true})).rejects.toThrow("No pending");await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,rebase:true})).rejects.toThrow("Rebase requires");
 for(const waitMs of [0,NaN,600001])await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs})).rejects.toThrow("budget");
 const {readPrivateFlyApplyArchive,readPrivateFlyAbandonedApplyArchive}=await import("../src/fly-apply");for(const id of ["../private","bad"]){await expect(readPrivateFlyApplyArchive(f.config,id)).rejects.toThrow("identity");await expect(readPrivateFlyAbandonedApplyArchive(f.config,id)).rejects.toThrow("identity");}
 fs.writeFileSync(pendingFlyRollbackPath(f.config),"{}",{mode:0o600});await expect(readPendingFlyRollback(f.config)).rejects.toThrow("Invalid private");expect(()=>assertNoPendingPush(f.config)).toThrow("Pending Fly rollback");
 fs.chmodSync(pendingFlyRollbackPath(f.config),0o644);await expect(readPendingFlyRollback(f.config)).rejects.toThrow("Invalid private");fs.rmSync(pendingFlyRollbackPath(f.config));fs.symlinkSync(f.config,pendingFlyRollbackPath(f.config));await expect(readPendingFlyRollback(f.config)).rejects.toThrow("private regular");
});
it("dispatches explicit rollback CLI flags and rejects mixed deployment options",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});
 vi.stubEnv("FLY_API_TOKEN","private-fly-token");vi.stubEnv("LOGT_AUTH_FILE",join(f.root,"missing-profile"));vi.stubEnv("LOGT_SERVICE_TOKEN",`lt_cli_${"a".repeat(43)}`);vi.stubEnv("LOGT_SERVICE_URL","");vi.spyOn(globalThis,"fetch").mockImplementation(f.fetcher);const output=vi.spyOn(console,"log").mockImplementation(()=>{}),error=vi.spyOn(console,"error").mockImplementation(()=>{});
 expect(await main(["-c",f.config,"deploy","fly","--rollback","--image",image])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("combined");expect(await main(["-c",f.config,"deploy","fly","--rebase"])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("requires");
 expect(await main(["-c",f.config,"deploy","fly","--rollback","--json"])).toBe(0);expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({machineId:"abc123",applied:null});expect(JSON.stringify(output.mock.calls)+JSON.stringify(error.mock.calls)).not.toMatch(/private-fly-token|private-report-token|old-secret/);
});
it("recovers after abandoning the obsolete apply and losing rollback target projection",async()=>{
 const f=await fixture();delete f.machine.config.mounts;let failures=0;
 vi.mocked(fs.renameSync).mockImplementation((from,to)=>{native.renameSync(from,to);if(String(to).endsWith(".logtura-link.json") && ++failures<=2)throw new Error("projection acknowledgement lost");});
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200})).rejects.toThrow("projection acknowledgement lost");
 await expect(rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1})).rejects.toThrow("projection acknowledgement lost");expect(await readPendingFlyApply(f.config)).toBeNull();expect(await readPendingFlyRollback(f.config)).not.toBeNull();
 const result=await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1});expect(result.machineId).toBe("abc123");expect(f.creates).toBe(1);assertNoPendingPush(f.config);
});
it("explicitly deletes retained old or rolled-back candidate machines while preserving the running survivor/checkpoint",async()=>{
 for(const restored of [false,true]){
  const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});
  const rollback=restored?await rollbackLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1}):null,survivor=structuredClone(restored?f.machine:f.candidate),state=structuredClone(f.state),link=await readDeploymentLink(f.config);
  const result=await cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,rollbackId:rollback?.rollbackId,waitMs:200,pollMs:1});
  expect(result).toMatchObject({machineId:restored?"abc123":"def456",deletedMachineId:restored?"def456":"abc123",volume:"vol_checkpoint",needsPull:false});expect(restored?f.machine:f.candidate).toEqual(survivor);expect(f.state).toMatchObject({desired:state.desired,activeInstanceId:state.activeInstanceId,lastReportSequence:state.lastReportSequence,stale:state.stale,applied:state.applied?{sequence:state.applied.sequence,revision:state.applied.revision}:null});expect(await readDeploymentLink(f.config)).toEqual(link);expect(f.cleanupDeletes).toBe(1);expect(await readPendingFlyCleanup(f.config)).toBeNull();expect(fs.statSync(result.cleanupFile).mode&0o777).toBe(0o600);assertNoPendingPush(f.config);expect(JSON.stringify(result)).not.toMatch(/old-secret|private-fly-token|private-report-token/);
 }
});
it("recovers a lost reservation response before deletion and exposes only redacted pending identities",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;let lose=true;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).endsWith("/fly-cleanups") && init?.method==="POST"){lose=false;throw new Error("reservation response lost");}return response;});
 await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1})).rejects.toThrow("reservation response lost");expect(f.cleanupDeletes).toBe(0);const status=await deploymentStatus(f.config);expect(status.pendingCleanup).toMatchObject({machineId:"def456",retiredMachineId:"abc123",phase:"prepared",completed:false});expect(JSON.stringify(status)).not.toMatch(/old-secret|private-fly-token|private-report-token/);expect(()=>assertNoPendingPush(f.config)).toThrow("Pending Fly cleanup");
 await cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1});expect(f.cleanupDeletes).toBe(1);
});
it("observes a lost DELETE acknowledgement without dispatching another deletion",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;let lose=true;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).endsWith("/machines/abc123") && init?.method==="DELETE"){lose=false;throw new Error("delete response lost");}return response;});
 await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1})).rejects.toThrow("delete response lost");expect((await readPendingFlyCleanup(f.config))!.state.phase).toBe("deleting");expect(f.cleanupDeletes).toBe(1);
 await cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1});expect(f.cleanupDeletes).toBe(1);expect(f.candidate!.state).toBe("started");
});
it("resumes a lost owner completion and guarded archive acknowledgement without another DELETE",async()=>{
 for(const lostAt of ["complete","archive"]){
  const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});let lose=true;
  if(lostAt==="complete"){const fetcher=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).includes("/fly-cleanups/") && String(url).endsWith("/complete")){lose=false;throw new Error("completion lost");}return response;});}
  else vi.mocked(fs.linkSync).mockImplementation((from,to)=>{native.linkSync(from,to);if(lose && /\.logtura-cleanup-[a-f0-9-]+\.json$/.test(String(to))){lose=false;throw new Error("archive lost");}});
  await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:200,pollMs:1})).rejects.toThrow(lostAt==="complete"?"completion lost":"archive conflicts");expect(f.cleanupDeletes).toBe(1);expect((await readPendingFlyCleanup(f.config))!.state.phase).toBe("deleted");if(lostAt==="archive")expect((await deploymentStatus(f.config)).pendingCleanup!.completed).toBe(true);
  await cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1});expect(f.cleanupDeletes).toBe(1);
 }
});
it("retains uncertain deletion without blindly retrying and supports an explicit website rebase",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;let hold=true;
 f.fetcher.mockImplementation(async(url,init)=>{if(hold && String(url).endsWith("/machines/abc123") && init?.method==="DELETE")return new Response(null,{status:204});const response=await fetcher(url,init);if(String(url).endsWith("/config")){const snapshot=await response.json();return Response.json({...snapshot,configurationVersion:f.state.desired.configurationVersion,desiredSequence:f.state.desired.sequence,revision:f.state.desired.revision});}return response;});
 await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,waitMs:100,pollMs:1})).rejects.toThrow("outcome is pending");const deletes=f.fetcher.mock.calls.filter(([url,init])=>String(url).endsWith("/machines/abc123") && init?.method==="DELETE").length;f.state.desired.configurationVersion++;
 await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:100,pollMs:1})).rejects.toThrow("--rebase");
 await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,rebase:true,waitMs:100,pollMs:1})).rejects.toThrow("outcome is pending");expect((await readPendingFlyCleanup(f.config))!.rebase).not.toBeNull();expect(f.fetcher.mock.calls.filter(([url,init])=>String(url).endsWith("/machines/abc123") && init?.method==="DELETE")).toHaveLength(deletes);
 // The engine deliberately cannot guess whether dispatch happened. The owned
 // fixture now acknowledges provider absence, without sending another request.
 hold=false;f.oldAbsent=true;
 const result=await cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:200,pollMs:1});expect(result.needsPull).toBe(true);expect(f.fetcher.mock.calls.filter(([url,init])=>String(url).endsWith("/machines/abc123") && init?.method==="DELETE")).toHaveLength(deletes);
});
it("rejects unsafe cleanup budgets, modes and resumptions before creating provider intent",async()=>{
 const f=await fixture();expect(await readPendingFlyCleanup(f.config)).toBeNull();await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true})).rejects.toThrow("No pending");await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,rebase:true})).rejects.toThrow("requires --resume");await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,rollbackId:"bad"})).rejects.toThrow("identity");
 for(const options of [{waitMs:0},{waitMs:NaN},{waitMs:600001},{pollMs:0},{pollMs:30001}])await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,...options})).rejects.toThrow("budget");
 delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});f.wrongAccount=true;await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly})).rejects.toThrow("account");f.wrongAccount=false;
 const fetcher=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/fly-capabilities")?Response.json({schemaVersion:1,features:["replacement"]}):fetcher(url,init));await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly})).rejects.toThrow("Update the service");expect(await readPendingFlyCleanup(f.config)).toBeNull();expect(f.cleanupDeletes).toBe(0);
});
it("validates private cleanup identity, plan provenance and regular-file recovery without discarding corrupt intent",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>{if(String(url).endsWith("/fly-cleanups") && init?.method==="POST")throw new Error("before reservation");return fetcher(url,init);});await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly})).rejects.toThrow("before reservation");const file=pendingFlyCleanupPath(f.config),valid=JSON.parse(fs.readFileSync(file,"utf8"));
 const changes=[(p:any)=>p.schemaVersion=2,(p:any)=>p.config="elsewhere",(p:any)=>p.extra=true,(p:any)=>p.state.phase="unknown",(p:any)=>p.request.imageDigest=`sha256:${"e".repeat(64)}`,(p:any)=>p.link.target.fly.machineId="abcdef",(p:any)=>p.request.survivorConfigDigest=`sha256:${"e".repeat(64)}`,(p:any)=>p.state.plan.replacement.plan.rollback.env={changed:"private"},(p:any)=>p.finalization={configurationVersion:99,sequence:99,revision:p.request.revision},(p:any)=>p.rebase={requestId:"bad"}];
 for(const change of changes){const p=structuredClone(valid);change(p);fs.writeFileSync(file,JSON.stringify(p));await expect(readPendingFlyCleanup(f.config)).rejects.toThrow("Invalid private cleanup");expect(fs.existsSync(file)).toBe(true);}
 fs.writeFileSync(file,JSON.stringify(valid));fs.chmodSync(file,0o644);await expect(readPendingFlyCleanup(f.config)).rejects.toThrow("Invalid private cleanup");fs.rmSync(file);fs.symlinkSync(f.config,file);await expect(readPendingFlyCleanup(f.config)).rejects.toThrow("private regular file");expect(f.cleanupDeletes).toBe(0);
});
it("keeps cleanup CAS transitions and owner identity immutable under the private backend lock",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(url,init)=>{if(String(url).endsWith("/fly-cleanups") && init?.method==="POST")throw new Error("before reservation");return fetcher(url,init);});await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly})).rejects.toThrow("before reservation");const store=new PrivateFlyCleanupStore(f.config);await expect(store.archive(async()=>{})).rejects.toThrow("not acknowledged");
 await store.runExclusive(async tx=>{const state=await tx.read();expect(await tx.compareAndSwap(state,{...state,phase:"deleted"})).toBe(false);const p=(await readPendingFlyCleanup(f.config))!;p.request.requestId=randomUUID();fs.writeFileSync(pendingFlyCleanupPath(f.config),JSON.stringify(p));await expect(tx.read()).rejects.toThrow("owner intent changed");expect(await tx.compareAndSwap(state,{...state,phase:"deleting"})).toBe(false);});expect(f.cleanupDeletes).toBe(0);
});
it("refuses completed reservations without private deletion evidence and resumes completed graph reconciliation read-only",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});const fetcher=f.fetcher.getMockImplementation()!;let lose=true;
 f.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(lose && String(url).endsWith("/fly-cleanups") && init?.method==="POST"){lose=false;throw new Error("reservation lost");}if(String(url).endsWith("/config")){const value=await response.json();return Response.json({...value,configurationVersion:f.state.desired.configurationVersion});}return response;});
 await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly})).rejects.toThrow("reservation lost");f.cleanup.status="completed";await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true})).rejects.toThrow("deletion proof");expect(f.cleanupDeletes).toBe(0);f.cleanup.status="prepared";
 let archiveLost=true;vi.mocked(fs.linkSync).mockImplementation((from,to)=>{native.linkSync(from,to);if(archiveLost && /\.logtura-cleanup-[a-f0-9-]+\.json$/.test(String(to))){archiveLost=false;throw new Error("archive acknowledgement lost");}});
 await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true})).rejects.toThrow("archive conflicts");f.state.desired.configurationVersion++;
 await expect(cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true})).rejects.toThrow("--rebase");
 // Preserve the earlier acknowledged archive and append a deterministic private
 // finalization record for the explicit newer graph, without another DELETE.
 const result=await cleanupLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,rebase:true});expect(f.cleanupDeletes).toBe(1);expect(result.cleanupFile).toContain("-finalized-");expect(fs.readdirSync(f.root).filter(name=>name.startsWith(".logtura-cleanup-") && name.endsWith(".json"))).toHaveLength(2);expect(await readPendingFlyCleanup(f.config)).toBeNull();vi.mocked(fs.linkSync).mockImplementation(native.linkSync);
});
it("dispatches explicit cleanup flags with redacted results and refuses mixed or unlinked operations",async()=>{
 const f=await fixture();delete f.machine.config.mounts;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200});vi.stubEnv("FLY_API_TOKEN","private-fly-token");vi.stubEnv("LOGT_AUTH_FILE",join(f.root,"missing-profile"));vi.stubEnv("LOGT_SERVICE_TOKEN",`lt_cli_${"a".repeat(43)}`);vi.stubEnv("LOGT_SERVICE_URL","");vi.spyOn(globalThis,"fetch").mockImplementation(f.fetcher);const output=vi.spyOn(console,"log").mockImplementation(()=>{}),error=vi.spyOn(console,"error").mockImplementation(()=>{});
 expect(await main(["-c",f.config,"deploy","fly","--cleanup","--image",image])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("combined");expect(await main(["-c",f.config,"deploy","fly","--rollback-id",randomUUID()])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("requires");
 expect(await main(["-c",f.config,"deploy","fly","--cleanup","--json"])).toBe(0);expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({machineId:"def456",deletedMachineId:"abc123"});expect(JSON.stringify(output.mock.calls)+JSON.stringify(error.mock.calls)).not.toMatch(/private-fly-token|private-report-token|old-secret/);
 fs.rmSync(`${f.config}.logtura-link.json`);expect(await main(["-c",f.config,"deploy","fly","--cleanup"])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("requires a linked");
});
