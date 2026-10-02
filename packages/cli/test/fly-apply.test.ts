import {afterEach,expect,it,vi} from "vitest";
import * as fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {exportDeploymentManifest,createSecretVersioner,hashConfigDocument,LogturaServiceClient,FlyMachinesClient,type FlyMachine,type DeploymentConfigurationState,type DeploymentInstanceReceipt} from "@logtura/core";
import {applyLinkedFlyDeployment,readPendingFlyApply,abandonObsoleteFlyApply} from "../src/fly-apply";
import {readPendingActivation} from "../src/activation";
import {createDeploymentLink,deploymentStatus} from "../src/deployment-link";
import {writePulledConfig} from "../src/pull";
import {pendingFlyApplyPath,pendingActivationPath,assertNoPendingPush,commitFileTransaction} from "../src/file-transaction";
import {writeConfigDoc} from "../src/config";
import {main} from "../src/main";

vi.mock("node:fs",{spy:true});
const native=await vi.importActual<typeof fs>("node:fs"),roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.mocked(fs.linkSync).mockImplementation(native.linkSync);vi.mocked(fs.fsyncSync).mockImplementation(native.fsyncSync);vi.mocked(fs.lstatSync).mockImplementation(native.lstatSync);vi.mocked(fs.openSync).mockImplementation(native.openSync);vi.unstubAllEnvs();for(const root of roots.splice(0))native.rmSync(root,{recursive:true,force:true});});
import {image,indexImage,platformDigest,configDigest,registryBody} from "./oci-fixture";
async function fixture(){
 const root=fs.mkdtempSync(join(tmpdir(),"logt-fly-apply-"));roots.push(root);const config=join(root,"logt.yaml");
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[{connection:{id:"con_site",provider:"cloudflare-worker-tail",displayName:"Site",externalAccountId:"account"},credentials:{apiToken:"private-source-token"},selectedSources:[]}],monitors:[],heartbeat:{kind:"logtura",deploymentId:"dep_site",appUrl:"https://service.test"},runtimeEnv:{LOGTURA_HEARTBEAT_TOKEN:"private-report-token"}},await createSecretVersioner("service-private"));
 const revision=await hashConfigDocument(exported.document),result={...exported,revision,configurationVersion:3,desiredSequence:1,deployment:{id:"dep_site",displayName:"Site"},target:{kind:"fly" as const,managed:false,imageDigest:null,fly:{appName:"app",region:"ord",orgSlug:"personal"}}};
 const link=await createDeploymentLink("https://service.test","usr_site",result);await writePulledConfig(result,config,false,link);
 let state:DeploymentConfigurationState={desired:{sequence:1,revision,document:exported.document,configurationVersion:3},applied:null,activeInstanceId:null,lastReportSequence:0,stale:true},receipt:DeploymentInstanceReceipt|null=null;
 let machine:FlyMachine={id:"machine123",instance_id:"version1",state:"started",region:"ord",config:{image:"registry.test/old:latest",env:{PREVIOUS_PRIVATE:"old-secret"},guest:{memory_mb:512}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};
 let lost=false,activationLost=false,acknowledge=true,updates=0,issuances=0,leaseFailure=false,releaseFailure=false,org="personal",extraMachine=false,volumeRegion="ord",mutateOnWait=false,wrongAccount=false;
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(new URL(String(url)).origin==="https://registry.test"){expect(new Headers(init?.headers).has("authorization")).toBe(false);const body=registryBody(path);return body===null?new Response(null,{status:404}):new Response(body);}
  if(String(url).startsWith("https://service.test")){
   if(path.endsWith("/me"))return Response.json({user:{id:wrongAccount?"usr_other":"usr_site",githubLogin:"site"}});
   if(path.endsWith("/state")){if(acknowledge && updates && receipt){state.lastReportSequence=1;state.applied={sequence:1,revision,at:Date.now()};state.stale=false;if(mutateOnWait)machine.config.env={changed:"outside"};}return Response.json({state});}
   if(init?.method==="POST"){const request=JSON.parse(init.body as string);issuances++;receipt={requestId:request.requestId,instanceId:randomUUID(),configurationVersion:3,sequence:1,revision};state.activeInstanceId=receipt.instanceId;expect(fs.existsSync(pendingActivationPath(config))).toBe(true);if(activationLost)throw new TypeError("activation acknowledgement lost");return Response.json(receipt);}
   return receipt?Response.json(receipt):Response.json({error:"receipt_not_found"},{status:404});
  }
  expect(new URL(String(url)).origin).toBe("https://api.machines.dev");
  if(path.endsWith("/lease")){expect(fs.existsSync(pendingFlyApplyPath(config))).toBe(true);if(init!.method==="DELETE")return new Response(null,{status:releaseFailure?500:204});if(leaseFailure)return new Response(null,{status:409});return Response.json({data:{nonce:"lease-secret"}});}
  if(path.endsWith("/start")){machine.state="started";return new Response(null,{status:204});}
  if(init?.method==="POST"){
   updates++;const pending=await readPendingFlyApply(config);expect(pending).not.toBeNull();expect(fs.statSync(pendingFlyApplyPath(config)).mode&0o777).toBe(0o600);
   const body=JSON.parse(init.body as string);expect(body.current_version).toBe("version1");expect(body.config).toEqual(pending!.plan.after);expect(init.headers).toMatchObject({"fly-machine-lease-nonce":"lease-secret"});
   machine={...machine,instance_id:"version2",config:body.config,image_ref:{registry:"registry.test",repository:"forwarder",digest:platformDigest}};
   if(lost)throw new TypeError("machine update acknowledgement lost");return Response.json(machine);
  }
  if(path.endsWith("/machines"))return Response.json(extraMachine?[machine,{...machine,id:"other"}]:[machine]);
  if(path.endsWith("/volumes"))return Response.json([{id:"vol_checkpoint",region:volumeRegion,state:"created",encrypted:true,attached_machine_id:updates?machine.id:null}]);
  if(path.endsWith("/machine123"))return Response.json(machine);
  return Response.json({name:"app",organization:{slug:org}});
 });
 const client=new LogturaServiceClient({url:"https://service.test",token:`lt_cli_${"a".repeat(43)}`,fetch:fetcher}),fly=new FlyMachinesClient({token:"private-fly-token",fetch:fetcher}),options={fly,image,imageFetch:fetcher,volume:"vol_checkpoint",waitMs:20,pollMs:1};
 return {root,config,link,result,client,fly,options,fetcher,get state(){return state;},get machine(){return machine;},set machine(value){machine=value;},get updates(){return updates;},get issuances(){return issuances;},set lost(value:boolean){lost=value;},set activationLost(value:boolean){activationLost=value;},set acknowledge(value:boolean){acknowledge=value;},set leaseFailure(value:boolean){leaseFailure=value;},set releaseFailure(value:boolean){releaseFailure=value;},set org(value:string){org=value;},set extraMachine(value:boolean){extraMachine=value;},set volumeRegion(value:string){volumeRegion=value;},set mutateOnWait(value:boolean){mutateOnWait=value;},set wrongAccount(value:boolean){wrongAccount=value;}};
}
it("applies the issued runtime and archives exact private rollback material only after acknowledgement",async()=>{
 const f=await fixture(),original=structuredClone(f.machine);expect(await readPendingFlyApply(f.config)).toBeNull();
 const applied=await applyLinkedFlyDeployment(f.client,f.config,f.options);expect(applied).toMatchObject({app:"app",machineId:"machine123",revision:f.link.revision,image});expect(f.updates).toBe(1);expect(f.issuances).toBe(1);expect(await readPendingActivation(f.config)).toBeNull();expect(await readPendingFlyApply(f.config)).toBeNull();
 const archive=JSON.parse(fs.readFileSync(applied.rollbackFile,"utf8"));expect(archive.machine).toEqual(original);expect(archive.rollback).toEqual({...original.config,image:`registry.test/old@${original.image_ref.digest}`});expect(fs.statSync(applied.rollbackFile).mode&0o777).toBe(0o600);expect(JSON.stringify(applied)).not.toMatch(/old-secret|private-report-token|private-fly-token|lt_cli/);
 expect(archive.plan.after).toMatchObject({mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}],stop_config:{timeout:"35s"}});
 const rendered=Buffer.from(archive.plan.after.files.find((file:{guest_path:string})=>file.guest_path.endsWith("logtura-runtime.json")).raw_value,"base64").toString();expect(JSON.parse(rendered).instance.instanceId).toBe(applied.instanceId);
 assertNoPendingPush(f.config);
});
it("recovers lost machine responses with the same descriptor and one provider update",async()=>{
 const f=await fixture();f.lost=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("update acknowledgement lost");const pending=await readPendingFlyApply(f.config);expect(pending).not.toBeNull();expect(await deploymentStatus(f.config)).toMatchObject({pendingActivation:{phase:"issued"}});
 expect(()=>assertNoPendingPush(f.config)).toThrow("Pending apply");expect(()=>writeConfigDoc(f.config,{...f.link.document})).toThrow("Pending apply");await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("--resume");
 f.lost=false;const applied=await applyLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:20,pollMs:1});const archive=JSON.parse(fs.readFileSync(applied.rollbackFile,"utf8"));expect(archive).toEqual(pending);expect(f.updates).toBe(1);expect(f.issuances).toBe(1);
});
it("recovers uncertain activation before installation and retains intent when waiting times out",async()=>{
 const f=await fixture();f.activationLost=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("activation acknowledgement lost");expect(await readPendingFlyApply(f.config)).toBeNull();expect(f.updates).toBe(0);
 f.activationLost=false;f.acknowledge=false;await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true})).rejects.toThrow("acknowledgement pending");expect(f.issuances).toBe(1);expect(f.updates).toBe(1);
 f.acknowledge=true;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true});expect(f.updates).toBe(1);
});
it("validates account, target, storage, image and wait settings before instance issuance",async()=>{
 const f=await fixture();for(const overrides of [{image:undefined},{image:"latest"},{volume:"vol_missing"},{machine:"other"},{app:"other"},{region:"iad"},{org:"other"},{waitMs:0},{waitMs:600_001},{pollMs:0},{pollMs:30_001},{resume:true}])await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,...overrides})).rejects.toThrow();
 f.org="other";await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("organization");f.org="personal";f.extraMachine=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("one existing");f.extraMachine=false;f.volumeRegion="iad";await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("volume");f.volumeRegion="ord";f.wrongAccount=true;await expect(applyLinkedFlyDeployment(f.client,f.config,f.options)).rejects.toThrow("account");
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
 f.acknowledge=false;const stopWaiting=new AbortController(),fetchImpl=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(url,init)=>{if(String(url).endsWith("/state") && f.updates>0)stopWaiting.abort();return fetchImpl(url,init);});await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:200,signal:stopWaiting.signal})).rejects.toThrow("pending");expect(await readPendingFlyApply(f.config)).not.toBeNull();f.acknowledge=true;await applyLinkedFlyDeployment(f.client,f.config,{...f.options,resume:true});
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
 await expect(applyLinkedFlyDeployment(f.client,f.config,{...f.options,waitMs:1000,pollMs:1000,signal:stop.signal})).rejects.toThrow("pending");expect(f.updates).toBe(1);
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
 expect(applied.image).toBe(image);expect(f.issuances).toBe(1);expect(f.updates).toBe(1);expect(JSON.parse(fs.readFileSync(applied.rollbackFile,"utf8"))).toEqual(saved);
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
 await expect(applyLinkedFlyDeployment(f.client,f.config,{fly:f.fly,resume:true,waitMs:5,pollMs:1})).rejects.toThrow("pending");
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
