import { expect,it,vi } from "vitest";
import { compileForwarderRuntime,verifyLoadedForwarder,validateForwarderRuntimeArtifact,reportLoadedForwarder,GENERATOR_VERSION,VECTOR_VERSION,type ForwarderReportCheckpoint,type LoadedForwarderObservation } from "../src/runtime";
import { createSecretVersioner,exportDeploymentManifest } from "../src/manifest";
import { hashConfigDocument } from "../src/config";
import { mockProvider } from "./_fixtures";
import type { ProviderDriver } from "../src/types";
const provider:ProviderDriver={...mockProvider,id:"runtime-fixture",displayName:"Runtime",capabilities:{selection:"list"},generatePipeline(){return {components:[{key:"runtime_input",kind:"source",yaml:"    type: stdin\n"}],outputKey:"runtime_input",envVars:[{name:"PRIVATE_TOKEN",description:"Private fixture",source:"manual"}],dockerfileDeps:[],runtimeAssets:[{path:"helper.bin",content:new Uint8Array([0,255,1])}]};}};
async function fixture(){
 const exported=await exportDeploymentManifest({providers:[provider],destinations:[],connections:[{connection:{id:"con_runtime",provider:provider.id,displayName:"Runtime",externalAccountId:null},selectedSources:[]}],monitors:[]},await createSecretVersioner("key"));
 const instance={requestId:"00000000-0000-4000-8000-000000000001",instanceId:"00000000-0000-4000-8000-000000000002",configurationVersion:4,sequence:1,revision:await hashConfigDocument(exported.document)};
 const options={service:"https://service.test",deploymentId:"dep_runtime",document:exported.document,instance,env:exported.secretValues,providers:[provider],destinations:[],runtimeEnv:{PRIVATE_TOKEN:"private-token-value"}};
 const {artifact,bundle}=await compileForwarderRuntime(options),observed:LoadedForwarderObservation={files:{"vector.yaml":bundle.vectorYaml,"assets/runtime-fixture/helper.bin":new Uint8Array([0,255,1])},environment:{PRIVATE_TOKEN:"private-token-value"},generatorVersion:GENERATOR_VERSION,vectorVersion:VECTOR_VERSION,ready:true};
 let saved:unknown=null;const save=vi.fn(async(state:ForwarderReportCheckpoint)=>{saved=structuredClone(state);}),store={load:async()=>structuredClone(saved),save};
 return {artifact,bundle,options,observed,store,save,get saved(){return saved;},set saved(value:unknown){saved=value;}};
}
it("renders the issued manifest into a private artifact and binds exact files, runtime versions and environment",async()=>{
 const f=await fixture();expect(await verifyLoadedForwarder(f.artifact,f.observed)).toEqual(f.artifact);expect(f.artifact.generatorVersion).toBe(GENERATOR_VERSION);expect(f.artifact.vectorVersion).toBe(VECTOR_VERSION);expect(f.bundle.dockerfile).toContain(`vector:${VECTOR_VERSION}-debian`);expect(JSON.stringify(f.artifact)).not.toContain("private-token-value");
 const second=await compileForwarderRuntime(f.options);expect(second.artifact.privateKey).not.toBe(f.artifact.privateKey);expect(second.artifact.files).not.toEqual(f.artifact.files);
 await expect(compileForwarderRuntime({...f.options,instance:{...f.options.instance,revision:`sha256:${"f".repeat(64)}`}})).rejects.toThrow("Issued revision");
 const secret=await exportDeploymentManifest({providers:[provider],destinations:[],connections:[{connection:{id:"con_runtime",provider:provider.id,displayName:"Runtime",externalAccountId:null},credentials:{apiToken:"private-credential"},selectedSources:[]}],monitors:[]},await createSecretVersioner("key"));
 await expect(compileForwarderRuntime({...f.options,document:secret.document,instance:{...f.options.instance,revision:await hashConfigDocument(secret.document)},env:{}})).rejects.toThrow("referenced private payloads");
 const known:ProviderDriver={...provider,generatePipeline(input){const pipeline=provider.generatePipeline(input);return {...pipeline,envVars:pipeline.envVars.map(variable=>({...variable,source:"credential" as const,credentialPath:"apiToken"}))};}};
 const bound=await compileForwarderRuntime({...f.options,document:secret.document,instance:{...f.options.instance,revision:await hashConfigDocument(secret.document)},env:secret.secretValues,providers:[known],runtimeEnv:undefined});await expect(verifyLoadedForwarder(bound.artifact,{...f.observed,files:{...f.observed.files,"vector.yaml":bound.bundle.vectorYaml},environment:{PRIVATE_TOKEN:"private-credential",UNRELATED:"ambient-private-value"}})).resolves.toEqual(bound.artifact);
 await expect(compileForwarderRuntime({...f.options,runtimeEnv:{}})).rejects.toThrow("generated environment");await expect(compileForwarderRuntime({...f.options,runtimeEnv:{PRIVATE_TOKEN:""}})).rejects.toThrow("generated environment");
});
it("rejects malformed artifacts and mismatched loaded observations without exposing values",async()=>{
 const f=await fixture(),a=f.artifact;
 for(const value of [null,[],{},Object.create(a),{...a,extra:true},{...a,extra:true,files:undefined},{...a,schemaVersion:2},{...a,service:2},{...a,service:"https://service.test/"},{...a,deploymentId:2},{...a,deploymentId:""},{...a,generatorVersion:2},{...a,generatorVersion:"bad"},{...a,vectorVersion:2},{...a,vectorVersion:"bad"},{...a,privateKey:2},{...a,privateKey:"bad"},{...a,files:[]},{...a,files:null},{...a,files:{}},{...a,files:{"vector.yaml":2}},{...a,files:{"vector.yaml":"bad"}},{...a,environment:[]},{...a,environment:{"bad/name":"a".repeat(64)}},{...a,instance:{}},{...a,document:{}},{...a,instance:{...a.instance,revision:`sha256:${"f".repeat(64)}`}}])await expect(validateForwarderRuntimeArtifact(value)).rejects.toThrow("Invalid private forwarder runtime artifact");
 for(const name of ["/etc/vector.yaml","assets/runtime-fixture/../private","assets/runtime-fixture/./private","assets/runtime-fixture/a//b","assets/runtime-fixture/","assets/runtime-fixture/a/..","assets/runtime-fixture/a/.","assets/runtime-fixture/private/", "bad"])await expect(validateForwarderRuntimeArtifact({...a,files:{...a.files,[name]:"a".repeat(64)}})).rejects.toThrow();
 for(const observed of [{...f.observed,ready:false},{...f.observed,generatorVersion:"other"},{...f.observed,vectorVersion:"0.1.0"},{...f.observed,files:{}},{...f.observed,files:{...f.observed.files,extra:"file"}}])await expect(verifyLoadedForwarder(a,observed)).rejects.toThrow("not the issued artifact");
 for(const value of [undefined,"changed-private-content",2])await expect(verifyLoadedForwarder(a,{...f.observed,files:{...f.observed.files,"vector.yaml":value}} as unknown as LoadedForwarderObservation)).rejects.toThrow();
 for(const value of [undefined,"changed-private-token"])await expect(verifyLoadedForwarder(a,{...f.observed,environment:{PRIVATE_TOKEN:value}})).rejects.toThrow("environment differs");
});
it("saves report intent before transport and advances durable counters only after delivery",async()=>{
 const f=await fixture(),report=vi.fn(async(body)=>{expect(f.saved).toMatchObject({lastReportSequence:body.reportSequence-1,pending:body});return true;});
 expect(await reportLoadedForwarder({...f,report})).toEqual({reportSequence:1,accepted:true});expect(f.saved).toMatchObject({lastReportSequence:1,pending:null,lastAccepted:true});
 expect(await reportLoadedForwarder({...f,report})).toEqual({reportSequence:2,accepted:true});expect(f.save).toHaveBeenCalledTimes(4);
});
it("retries uncertain reports and completion-save failures using the same durable report sequence",async()=>{
 const f=await fixture(),report=vi.fn(async()=>{throw new Error("response lost");});await expect(reportLoadedForwarder({...f,report})).rejects.toThrow("response lost");expect(f.saved).toMatchObject({lastReportSequence:0,pending:{reportSequence:1}});
 const ignored=vi.fn(async()=>false);expect(await reportLoadedForwarder({...f,report:ignored})).toEqual({reportSequence:1,accepted:false});expect(f.saved).toMatchObject({lastReportSequence:1,pending:null,lastAccepted:false});
 const originalSave=f.store.save;f.store.save=async(value)=>{if(value.pending===null)throw new Error("completion disk failure");await originalSave(value);};await expect(reportLoadedForwarder({...f,report:async()=>true})).rejects.toThrow("completion disk failure");expect(f.saved).toMatchObject({lastReportSequence:1,pending:{reportSequence:2}});
 f.store.save=originalSave;expect(await reportLoadedForwarder({...f,report:async()=>false})).toEqual({reportSequence:2,accepted:false});
});
it("never sends an unverified artifact or an unpersisted intent",async()=>{
 const f=await fixture(),report=vi.fn(async()=>true);
 await expect(reportLoadedForwarder({...f,observed:{...f.observed,ready:false},report})).rejects.toThrow();expect(f.save).not.toHaveBeenCalled();expect(report).not.toHaveBeenCalled();
 f.store.save=async()=>{throw new Error("intent disk failure");};await expect(reportLoadedForwarder({...f,report})).rejects.toThrow("intent disk failure");expect(report).not.toHaveBeenCalled();
 const good=await fixture();await expect(reportLoadedForwarder({...good,report:async()=>"bad" as unknown as boolean})).rejects.toThrow("transport result");expect(good.saved).toMatchObject({lastReportSequence:0,pending:{reportSequence:1}});
});
it("rejects foreign/corrupt checkpoints and exhausted counters before transport",async()=>{
 const f=await fixture(),report=vi.fn(async()=>true);await reportLoadedForwarder({...f,report});const state=structuredClone(f.saved) as ForwarderReportCheckpoint;
 const pending={instanceId:state.instanceId,sequence:state.sequence,revision:state.revision,reportSequence:2};
 for(const value of [[],{}, {...state,extra:true},{...state,schemaVersion:2},{...state,deploymentId:"foreign"},{...state,instanceId:"foreign"},{...state,sequence:2},{...state,revision:"bad"},{...state,lastReportSequence:-1},{...state,lastReportSequence:1.5},{...state,lastAccepted:"yes"},{...state,lastAccepted:null},{...state,lastReportSequence:0,lastAccepted:true},{...state,pending:{}},{...state,pending:{...pending,instanceId:"00000000-0000-4000-8000-000000000003"}},{...state,pending:{...pending,sequence:2}},{...state,pending:{...pending,revision:`sha256:${"f".repeat(64)}`}},{...state,pending:{...pending,reportSequence:3}}]){f.saved=value;await expect(reportLoadedForwarder({...f,report})).rejects.toThrow("checkpoint");}
 f.saved={...state,lastReportSequence:Number.MAX_SAFE_INTEGER};await expect(reportLoadedForwarder({...f,report})).rejects.toThrow("exhausted");expect(report).toHaveBeenCalledTimes(1);
});
