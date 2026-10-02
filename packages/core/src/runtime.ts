import { generateBundle } from "./render";
import { hashConfigDocument,canonicalConfigJson } from "./config";
import { normalizeDeploymentManifest,parseDeploymentManifest,createSecretVersioner,type DeploymentManifest } from "./manifest";
import { normalizeServiceUrl } from "./service-client";
import { validateDeploymentInstanceReceipt,validateDeploymentAppliedReport,type DeploymentInstanceReceipt,type DeploymentAppliedReport } from "./deployment-state";
import type { GenerateInput,GeneratedBundle } from "./types";
import { GENERATOR_VERSION,VECTOR_VERSION } from "./versions";
export { GENERATOR_VERSION,VECTOR_VERSION } from "./versions";
/** Private integrity descriptor. Keep with the private install bundle; send only
 * its public revision identity in reports, never its key or integrity proofs. */
export interface ForwarderRuntimeArtifact {
 schemaVersion:1;service:string;deploymentId:string;instance:DeploymentInstanceReceipt;document:DeploymentManifest;
 generatorVersion:string;vectorVersion:string;privateKey:string;files:Record<string,string>;environment:Record<string,string>;
}
function fileBytes(value:string|Uint8Array):string {if(typeof value!=="string" && !(value instanceof Uint8Array))throw new Error("Invalid loaded forwarder file");return [...(typeof value==="string"?new TextEncoder().encode(value):value)].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function fileName(name:string):boolean{const parts=name.split("/");return name==="vector.yaml" || parts.length>=3 && parts[0]==="assets" && /^[a-zA-Z0-9_-]+$/.test(parts[1]!) && !name.includes("\\") && !/[\u0000-\u001f\u007f]/.test(name) && parts.every(part=>part!=="" && part!=="." && part!=="..");}
function proofMap(value:unknown,files=false):value is Record<string,string>{return !!value && typeof value==="object" && !Array.isArray(value) && Object.entries(value).every(([name,proof])=>(files?fileName(name):/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) && typeof proof==="string" && /^[a-f0-9]{64}$/.test(proof));}
export async function validateForwarderRuntimeArtifact(value:unknown):Promise<ForwarderRuntimeArtifact>{
 try{
  const artifact=value as ForwarderRuntimeArtifact;
  if(!artifact || typeof artifact!=="object" || Array.isArray(artifact) || Object.keys(artifact).length!==10 || Object.keys(artifact).some(k=>!["schemaVersion","service","deploymentId","instance","document","generatorVersion","vectorVersion","privateKey","files","environment"].includes(k)) || artifact.schemaVersion!==1 || typeof artifact.service!=="string" || normalizeServiceUrl(artifact.service)!==artifact.service || typeof artifact.deploymentId!=="string" || !artifact.deploymentId || typeof artifact.generatorVersion!=="string" || !/^(development|\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.test(artifact.generatorVersion) || typeof artifact.vectorVersion!=="string" || !/^\d+\.\d+\.\d+$/.test(artifact.vectorVersion) || typeof artifact.privateKey!=="string" || !/^[a-f0-9]{64}$/.test(artifact.privateKey) || !proofMap(artifact.files,true) || !Object.hasOwn(artifact.files,"vector.yaml") || !proofMap(artifact.environment))throw new Error();
  const instance=validateDeploymentInstanceReceipt(artifact.instance),document=normalizeDeploymentManifest(artifact.document) as unknown as DeploymentManifest;
  if(instance.revision!==await hashConfigDocument(document))throw new Error();
  return structuredClone({...artifact,instance,document});
 }catch{throw new Error("Invalid private forwarder runtime artifact");}
}
/** Render the artifact from the actual issued manifest, not a caller's unrelated
 * YAML. Resolve every payload before binding generated files and environment. */
export async function compileForwarderRuntime(options:{service:string;deploymentId:string;document:DeploymentManifest;instance:DeploymentInstanceReceipt;env:Record<string,string|undefined>;providers:GenerateInput["providers"];destinations:GenerateInput["destinations"];runtimeEnv?:Record<string,string>}):Promise<{artifact:ForwarderRuntimeArtifact;bundle:GeneratedBundle}>{
 const instance=validateDeploymentInstanceReceipt(options.instance),document=normalizeDeploymentManifest(options.document) as unknown as DeploymentManifest;
 if(instance.revision!==await hashConfigDocument(document))throw new Error("Issued revision does not match the runtime manifest");
 const parsed=parseDeploymentManifest(document,{env:options.env,providers:options.providers,destinations:options.destinations});
 if(parsed.missingEnv.length)throw new Error("Runtime requires all referenced private payloads");
 const bundle=generateBundle(parsed.input),keyBytes=crypto.getRandomValues(new Uint8Array(32)),privateKey=[...keyBytes].map(byte=>byte.toString(16).padStart(2,"0")).join(""),version=await createSecretVersioner(privateKey);
 const files:Record<string,string>={"vector.yaml":await version("runtime-file:vector.yaml",fileBytes(bundle.vectorYaml))};
 for(const asset of bundle.runtimeAssets){const name=`assets/${asset.driverId}/${asset.path}`;files[name]=await version(`runtime-file:${name}`,fileBytes(asset.content));}
 const environment:Record<string,string>={};
 for(const variable of bundle.envVars){const value=variable.value??options.runtimeEnv?.[variable.name];if(value===undefined || value==="")throw new Error("Runtime requires all generated environment values");environment[variable.name]=await version(`runtime-env:${variable.name}`,value);}
 const artifact=await validateForwarderRuntimeArtifact({schemaVersion:1,service:normalizeServiceUrl(options.service),deploymentId:options.deploymentId,instance,document,generatorVersion:GENERATOR_VERSION,vectorVersion:VECTOR_VERSION,privateKey,files,environment});
 return {artifact,bundle};
}
export interface LoadedForwarderObservation {files:Record<string,string|Uint8Array>;environment:Record<string,string|undefined>;generatorVersion:string;vectorVersion:string;ready:boolean;}
/** The process adapter supplies files/env actually passed to its own immutable
 * Vector process and probes that process's readiness. No proof values are logged. */
export async function verifyLoadedForwarder(value:unknown,observed:LoadedForwarderObservation):Promise<ForwarderRuntimeArtifact>{
 const artifact=await validateForwarderRuntimeArtifact(value);
 if(!observed.ready || observed.generatorVersion!==artifact.generatorVersion || observed.vectorVersion!==artifact.vectorVersion || canonicalConfigJson(Object.keys(observed.files).sort())!==canonicalConfigJson(Object.keys(artifact.files).sort()))throw new Error("Forwarder runtime is not the issued artifact");
 const version=await createSecretVersioner(artifact.privateKey);
 for(const [name,proof] of Object.entries(artifact.files))if(observed.files[name]===undefined || await version(`runtime-file:${name}`,fileBytes(observed.files[name]!))!==proof)throw new Error("Loaded forwarder file differs from the issued artifact");
 for(const [name,proof] of Object.entries(artifact.environment)){const value=observed.environment[name];if(typeof value!=="string" || await version(`runtime-env:${name}`,value)!==proof)throw new Error("Loaded forwarder environment differs from the issued artifact");}
 return artifact;
}
export interface ForwarderReportCheckpoint {schemaVersion:1;deploymentId:string;instanceId:string;sequence:number;revision:string;lastReportSequence:number;pending:DeploymentAppliedReport|null;lastAccepted:boolean|null;}
export interface ForwarderReportStore {load():Promise<unknown|null>;save(value:ForwarderReportCheckpoint):Promise<void>;}
function validateCheckpoint(value:unknown,artifact:ForwarderRuntimeArtifact):ForwarderReportCheckpoint {
 try{const state=value as ForwarderReportCheckpoint;
 if(!state || typeof state!=="object" || Array.isArray(state) || Object.keys(state).length!==8 || Object.keys(state).some(k=>!["schemaVersion","deploymentId","instanceId","sequence","revision","lastReportSequence","pending","lastAccepted"].includes(k)) || state.schemaVersion!==1 || state.deploymentId!==artifact.deploymentId || state.instanceId!==artifact.instance.instanceId || state.sequence!==artifact.instance.sequence || state.revision!==artifact.instance.revision || !Number.isSafeInteger(state.lastReportSequence) || state.lastReportSequence<0 || (state.lastAccepted!==null && typeof state.lastAccepted!=="boolean") || (state.lastReportSequence===0)!==(state.lastAccepted===null))throw new Error();
 if(state.pending!==null){const pending=validateDeploymentAppliedReport(state.pending);if(pending.instanceId!==state.instanceId || pending.sequence!==state.sequence || pending.revision!==state.revision || pending.reportSequence!==state.lastReportSequence+1)throw new Error();}
 return structuredClone(state);
 }catch{throw new Error("Invalid private forwarder report checkpoint");}
}
/** Caller serializes one instance's store. Save intent before transport and save
 * completion afterwards; an uncertain write retries the same report sequence. */
export async function reportLoadedForwarder(options:{artifact:unknown;observed:LoadedForwarderObservation;store:ForwarderReportStore;report:(report:DeploymentAppliedReport)=>Promise<boolean>}):Promise<{reportSequence:number;accepted:boolean}>{
 const artifact=await verifyLoadedForwarder(options.artifact,options.observed),loaded=await options.store.load();
 let state:ForwarderReportCheckpoint=loaded===null?{schemaVersion:1 as const,deploymentId:artifact.deploymentId,instanceId:artifact.instance.instanceId,sequence:artifact.instance.sequence,revision:artifact.instance.revision,lastReportSequence:0,pending:null,lastAccepted:null}:validateCheckpoint(loaded,artifact);
 if(!state.pending){if(state.lastReportSequence>=Number.MAX_SAFE_INTEGER)throw new Error("Forwarder report sequence is exhausted");state={...state,pending:{instanceId:state.instanceId,sequence:state.sequence,revision:state.revision,reportSequence:state.lastReportSequence+1}};await options.store.save(structuredClone(state));}
 const pending=state.pending!,accepted=await options.report(structuredClone(pending));if(typeof accepted!=="boolean")throw new Error("Invalid applied report transport result");
 await options.store.save({...state,lastReportSequence:pending.reportSequence,pending:null,lastAccepted:accepted});
 return {reportSequence:pending.reportSequence,accepted};
}
