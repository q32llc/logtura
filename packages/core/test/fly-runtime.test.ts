import {expect,it} from "vitest";
import {planFlyRuntime,validateFlyRuntimeVolume} from "../src/fly-runtime";
import {compileForwarderRuntime} from "../src/runtime";
import {exportDeploymentManifest,createSecretVersioner} from "../src/manifest";
import {hashConfigDocument} from "../src/config";
import type {FlyMachine,FlyVolume} from "../src/fly";
import {mockProvider} from "./_fixtures";
const image=`registry.test/forwarder@sha256:${"a".repeat(64)}`;
function machine():FlyMachine{return {id:"machine123",instance_id:"version1",state:"started",region:"ord",config:{image:"registry.test/old:latest",guest:{memory_mb:512},env:{UNRELATED:"keep",NODE_OPTIONS:"old-preload"},files:[{guest_path:"/etc/other",raw_value:"a2VlcA=="},{guest_path:"/etc/vector/vector.yaml",raw_value:"b2xk"},{guest_path:"/etc/vector/logtura-runtime.json",raw_value:"b2xk"},{guest_path:"/opt/logtura/assets/old/helper",raw_value:"b2xk"}],mounts:[{path:"/unrelated",volume:"vol_unrelated"}],metadata:{user:"keep"}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};}
function volume():FlyVolume{return {id:"vol_checkpoint",region:"ord",encrypted:true,state:"created",attached_machine_id:null};}
async function fixture(){
 const provider={...mockProvider,id:"runtime-fixture",generatePipeline(){return {components:[{key:"fixture",kind:"source" as const,yaml:"    type: stdin\n"}],outputKey:"fixture",envVars:[],dockerfileDeps:[],runtimeAssets:[{path:"helper.bin",content:new Uint8Array([0,255,1]),mode:0o755},{path:"other.txt",content:"héllo"}]};}};
 const exported=await exportDeploymentManifest({providers:[provider],destinations:[],connections:[{connection:{id:"con_fixture",provider:provider.id,displayName:"Fixture",externalAccountId:null},selectedSources:[]}],monitors:[],heartbeat:{kind:"logtura",deploymentId:"dep_fixture",appUrl:"https://service.test"},runtimeEnv:{LOGTURA_HEARTBEAT_TOKEN:"private-report-token"}},await createSecretVersioner("fixture"));
 const instance={requestId:"00000000-0000-4000-8000-000000000001",instanceId:"00000000-0000-4000-8000-000000000002",configurationVersion:3,sequence:1,revision:await hashConfigDocument(exported.document)};
 const compiled=await compileForwarderRuntime({service:"https://service.test",deploymentId:"dep_fixture",document:exported.document,instance,env:exported.secretValues,providers:[provider],destinations:[]});
 return {app:"app",machine:machine(),volume:"vol_checkpoint",image,...compiled};
}
it("renders private issued files, preserves unrelated settings, binds a persistent mount and uses graceful supervised startup",async()=>{
 const f=await fixture(),before=structuredClone(f.machine);const plan=await planFlyRuntime(f);
 expect(f.machine).toEqual(before);expect(plan).toMatchObject({app:"app",machineId:"machine123",version:"version1",before:before.config,after:{image,guest:{memory_mb:512},env:{UNRELATED:"keep",LOGTURA_HEARTBEAT_TOKEN:"private-report-token"},init:{entrypoint:["/opt/logtura/runtime/entrypoint.sh"],cmd:["--config","/etc/vector/vector.yaml"]},stop_config:{signal:"SIGTERM",timeout:"35s"},restart:{policy:"always"},metadata:{user:"keep","logtura.instance":f.artifact.instance.instanceId},mounts:[{path:"/unrelated",volume:"vol_unrelated"},{path:"/var/lib/logtura",volume:"vol_checkpoint"}]}});
 expect((plan.after.env as Record<string,string>).NODE_OPTIONS).toBeUndefined();
 const files=plan.after.files as Array<{guest_path:string;raw_value:string;mode?:number}>;
 expect(files).toHaveLength(5);expect(files[0]).toEqual((before.config.files as unknown[])[0]);expect(files.find(file=>file.guest_path.endsWith("helper.bin"))).toMatchObject({raw_value:"AP8B",mode:0o755});expect(files.find(file=>file.guest_path.endsWith("other.txt"))).toMatchObject({mode:0o644});
 expect(JSON.parse(Buffer.from(files.find(file=>file.guest_path.endsWith("logtura-runtime.json"))!.raw_value,"base64").toString())).toEqual(f.artifact);expect(Buffer.from(files.find(file=>file.guest_path.endsWith("vector.yaml"))!.raw_value,"base64").toString()).toBe(f.bundle.vectorYaml);
 const minimal={...f,machine:{...f.machine,config:{image:f.machine.config.image}}};expect(await planFlyRuntime(minimal)).toMatchObject({after:{mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}]}});
 const mounted={...minimal,machine:{...minimal.machine,config:{...minimal.machine.config,mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint",size_gb:1}]}}};expect((await planFlyRuntime(mounted)).after.mounts).toEqual(mounted.machine.config.mounts);
});
it("requires encrypted, compatible, uniquely owned checkpoint storage and rejects overlapping mounts",()=>{
 const m=machine(),v=volume();expect(validateFlyRuntimeVolume(m,[v],v.id)).toBe(v.id);expect(validateFlyRuntimeVolume(m,[{...v,attached_machine_id:m.id}],v.id)).toBe(v.id);
 const mounted={...m,config:{...m.config,mounts:[{path:"/var/lib/logtura",volume:v.id}]}};expect(validateFlyRuntimeVolume(mounted,[v])).toBe(v.id);
 expect(()=>validateFlyRuntimeVolume(m,[v])).toThrow("--volume");expect(()=>validateFlyRuntimeVolume(mounted,[v],"vol_other")).toThrow("conflicts");
 for(const volumes of [[],[v,v],[{...v,encrypted:false}],[{...v,state:"deleting"}],[{...v,region:"iad"}],[{...v,attached_machine_id:"other"}]])expect(()=>validateFlyRuntimeVolume(m,volumes,v.id)).toThrow("unavailable");
 for(const mounts of [[{path:"/",volume:v.id}],[{path:"/var",volume:v.id}],[{path:"/var/lib/logtura/sub",volume:v.id}],[{path:"/var/lib/logtura",volume:2}],[{path:"/var/lib/logtura",volume:v.id},{path:"/var/lib/logtura",volume:v.id}],[{}]])expect(()=>validateFlyRuntimeVolume({...m,config:{...m.config,mounts}},[v],v.id)).toThrow("conflicts");
 expect(()=>validateFlyRuntimeVolume({...m,config:{...m.config,mounts:[{path:"/other",volume:v.id}]}},[v],v.id)).toThrow("unavailable");expect(()=>validateFlyRuntimeVolume({...m,config:{...m.config,mounts:{}}},[v],v.id)).toThrow("settings");expect(()=>validateFlyRuntimeVolume({...m,config:{...m.config,mounts:[null]}},[v],v.id)).toThrow("settings");
 expect(validateFlyRuntimeVolume({...m,config:{image:m.config.image}},[v],v.id)).toBe(v.id);
});
it("rejects mismatched artifacts, missing values, unsafe file settings and unsupported machine lifecycles",async()=>{
 const f=await fixture();await expect(planFlyRuntime({...f,volume:"bad"})).rejects.toThrow("volume");await expect(planFlyRuntime({...f,bundle:{...f.bundle,vectorYaml:"unrelated"}})).rejects.toThrow("file differs");
 const manual={...f.bundle,envVars:f.bundle.envVars.map(variable=>variable.name==="LOGTURA_HEARTBEAT_TOKEN"?{...variable,value:null}:variable)};await expect(planFlyRuntime({...f,bundle:manual})).rejects.toThrow("environment values");expect(await planFlyRuntime({...f,bundle:manual,environment:{LOGTURA_HEARTBEAT_TOKEN:"private-report-token"}})).toBeTruthy();
 for(const setting of [{containers:[{}]},{processes:[{}]},{volumes:[{}]},{standbys:["other"]},{standbys:{}},{schedule:"daily"},{auto_destroy:true}])await expect(planFlyRuntime({...f,machine:{...f.machine,config:{...f.machine.config,...setting}}})).rejects.toThrow("continuously");
 expect(await planFlyRuntime({...f,machine:{...f.machine,config:{...f.machine.config,containers:[],processes:[],volumes:[],standbys:[],schedule:"",auto_destroy:false}}})).toBeTruthy();
 for(const setting of [{env:[]},{files:[{}]},{metadata:[]},{files:[null]}])await expect(planFlyRuntime({...f,machine:{...f.machine,config:{...f.machine.config,...setting}}})).rejects.toThrow("Invalid Fly");
});

it("rejects foreign reporting identities and artifacts larger than the installed reader",async()=>{
 const f=await fixture();for(const change of [{service:"https://other.test"},{deploymentId:"dep_other"}])await expect(planFlyRuntime({...f,artifact:{...f.artifact,...change}})).rejects.toThrow("reporting must match");
 const enlarged=structuredClone(f.artifact);enlarged.document.connections[0]!.connection.displayName="x".repeat(1_048_577);enlarged.instance.revision=await hashConfigDocument(enlarged.document);
 await expect(planFlyRuntime({...f,artifact:enlarged})).rejects.toThrow("reader limit");
});

it("rejects private environment settings that conflict with the supervised launch",async()=>{
 const f=await fixture(),version=await createSecretVersioner(f.artifact.privateKey);
 for(const name of ["NODE_OPTIONS","VECTOR_CONFIG","VECTOR_LOG"]){const value="conflicting-setting",artifact={...f.artifact,environment:{...f.artifact.environment,[name]:await version(`runtime-env:${name}`,value)}},bundle={...f.bundle,envVars:[...f.bundle.envVars,{name,value,description:"Conflict",source:"manual" as const}]};await expect(planFlyRuntime({...f,artifact,bundle})).rejects.toThrow("reserved launch setting");}
 const name="VECTOR_LOG",value="info",artifact={...f.artifact,environment:{...f.artifact.environment,[name]:await version(`runtime-env:${name}`,value)}},bundle={...f.bundle,envVars:[...f.bundle.envVars,{name,value,description:"Controlled log",source:"manual" as const}]};expect(await planFlyRuntime({...f,artifact,bundle})).toBeTruthy();
});

it("shares exact binary/Unicode asset bytes and modes between hosted and issued Fly file preparation",async()=>{
 const {flyBundleFiles}=await import("../src/index"),f=await fixture(),before=structuredClone(f.bundle),files=flyBundleFiles(f.bundle);
 expect(files.map(file=>file.guest_path)).toEqual(["/etc/vector/vector.yaml","/opt/logtura/assets/runtime-fixture/helper.bin","/opt/logtura/assets/runtime-fixture/other.txt"]);
 expect(files[0]!.mode).toBe(0o400);expect(files[1]).toMatchObject({raw_value:"AP8B",mode:0o755});expect(files[2]).toMatchObject({raw_value:Buffer.from("héllo").toString("base64"),mode:0o644});expect(f.bundle).toEqual(before);
 const asset=f.bundle.runtimeAssets[0]!;
 for(const change of [{driverId:"../escape"},{path:""},{path:"/absolute"},{path:"a/../b"},{path:"a/./b"},{path:"a\\b"},{path:"a\u0000b"},{mode:-1},{mode:0o1000},{mode:1.5},{content:[] as unknown as Uint8Array}])expect(()=>flyBundleFiles({...f.bundle,runtimeAssets:[{...asset,...change}]})).toThrow("Invalid Fly runtime asset");
 expect(()=>flyBundleFiles({...f.bundle,runtimeAssets:[asset,asset]})).toThrow("Invalid Fly runtime asset");
 expect(flyBundleFiles({...f.bundle,runtimeAssets:[]})).toHaveLength(1);
});
