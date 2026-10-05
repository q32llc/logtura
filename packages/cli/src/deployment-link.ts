import { validateDeploymentTarget,type DeploymentTarget } from "@logtura/core";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { canonicalConfigJson, normalizeServiceUrl, normalizeDeploymentManifest, parseDeploymentManifest, hashConfigDocument, diffDeploymentManifests, type DeploymentManifest, type DeploymentConfigExport, type SecretReference } from "@logtura/core";
import { assertTransactionClear, deploymentLinkPath } from "./file-transaction";
import { readConfigDoc, readConfigEnvironment } from "./config";

/** Private baseline, never embedded in the portable manifest or sent to the service. */
export interface DeploymentLink {
 target?:DeploymentTarget;schemaVersion:1;service:string;accountId:string;deployment:{id:string;displayName:string};
 configurationVersion:number;desiredSequence:number;document:DeploymentManifest;revision:string;
 privateKey:string;fingerprints:Record<string,string>;
}
export function manifestReferences(document:DeploymentManifest):Map<string,SecretReference>{
 parseDeploymentManifest(document);const refs=new Map<string,SecretReference>();
 const add=(ref:SecretReference|null)=>{if(ref)refs.set(ref.env,ref);};
 for(const connection of document.connections){add(connection.credentials);for(const source of connection.selectedSources)add(source.metadata);}
 for(const monitor of document.monitors)for(const sink of monitor.sinks)add(sink.destinationConfig);
 if(document.metrics?.kind==="destination")add(document.metrics.destinationConfig);
 add(document.runtimeEnv);return refs;
}
export function privateFingerprint(key:string,name:string,value:string):string {
 let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new Error("Referenced private payload must be JSON");}
 return createHmac("sha256",key).update(name+"\0"+canonicalConfigJson(parsed)).digest("hex");
}
function invalid():never {throw new Error("Invalid deployment link; pull again or retain it for recovery");}
export async function validateDeploymentLink(value:unknown):Promise<DeploymentLink>{
 try{
 const link=value as DeploymentLink;
 if(!link || typeof link!=="object" || Array.isArray(link) || Object.keys(link).some(key=>!["schemaVersion","service","accountId","deployment","configurationVersion","desiredSequence","document","revision","privateKey","fingerprints","target"].includes(key)) || link.schemaVersion!==1 || typeof link.service!=="string" || normalizeServiceUrl(link.service)!==link.service || typeof link.accountId!=="string" || !link.accountId || !link.deployment || typeof link.deployment.id!=="string" || !link.deployment.id || typeof link.deployment.displayName!=="string" || Object.keys(link.deployment).some(key=>!["id","displayName"].includes(key)) || !Number.isSafeInteger(link.configurationVersion) || link.configurationVersion<0 || !Number.isSafeInteger(link.desiredSequence) || link.desiredSequence<0 || typeof link.privateKey!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(link.privateKey) || !link.fingerprints || typeof link.fingerprints!=="object" || Array.isArray(link.fingerprints))invalid();
 if(link.target!==undefined)link.target=validateDeploymentTarget(link.target);
 normalizeDeploymentManifest(link.document);
 if(await hashConfigDocument(link.document)!==link.revision)invalid();
 const required=parseDeploymentManifest(link.document).requiredEnv;
 if(Object.keys(link.fingerprints).length!==required.length || required.some(name=>!Object.hasOwn(link.fingerprints,name) || !/^[a-f0-9]{64}$/.test(link.fingerprints[name]!)))invalid();
 return JSON.parse(canonicalConfigJson(link)) as DeploymentLink;
 }catch{invalid();}
}
export async function createDeploymentLink(service:string,accountId:string,result:DeploymentConfigExport):Promise<DeploymentLink>{
 const parsed=parseDeploymentManifest(result.document,{env:result.secretValues});
 if(parsed.missingEnv.length)throw new Error("Deployment link requires all referenced private payloads");
 if(result.configurationVersion===undefined || result.desiredSequence===undefined)throw new Error("Service must provide configuration and desired revision baselines; update the service before linking");
 const privateKey=randomBytes(32).toString("base64url");
 return validateDeploymentLink({schemaVersion:1,...(result.target!==undefined?{target:result.target}:{}),service:normalizeServiceUrl(service),accountId,deployment:result.deployment,configurationVersion:result.configurationVersion,desiredSequence:result.desiredSequence,document:result.document,revision:result.revision,privateKey,fingerprints:Object.fromEntries(parsed.requiredEnv.map(name=>[name,privateFingerprint(privateKey,name,result.secretValues![name]!)]))});
}
export async function readDeploymentLink(path:string):Promise<DeploymentLink|null>{
 assertTransactionClear(path);const file=deploymentLinkPath(path);if(!existsSync(file))return null;
 if(!lstatSync(file).isFile())throw new Error("Deployment link must be a regular private file");
 let value:unknown;try{value=JSON.parse(readFileSync(file,"utf8"));}catch{invalid();}
 return validateDeploymentLink(value);
}
export async function deploymentStatus(path:string){
 const replacement=(await import("./fly-replacement-store")).readPrivateFlyReplacement(path);
 const replacementRecovery=replacement?{pendingReplacement:{app:replacement.plan.app,replacementId:replacement.plan.id,phase:replacement.phase,previousMachineId:replacement.plan.before.id,machineId:replacement.machineId}}:{};
 const apply=await (await import("./fly-apply")).readPendingFlyApply(path);
 const appliedRecovery=apply?{pendingApply:{app:apply.plan.app,machineId:apply.machine.id,instanceId:apply.artifact.instance.instanceId,revision:apply.link.revision,image:apply.plan.after.image}}:{};
 const pending=await (await import("./activation")).readPendingActivation(path);
 const activationRecovery=pending?{pendingActivation:{phase:pending.receipt?"issued" as const:pending.rejected?"rejected" as const:"pending" as const,requestId:pending.request.requestId,instanceId:pending.receipt?.instanceId??null,sequence:pending.request.expectedSequence,revision:pending.request.revision}}:{};
 const rollback=await (await import("./fly-rollback")).readPendingFlyRollback(path);
 const rollbackRecovery=rollback?{pendingRollback:{requestId:rollback.request.requestId,app:rollback.replacement.plan.app,machineId:rollback.replacement.plan.before.id,candidateMachineId:rollback.replacement.machineId,completed:rollback.completion!==null}}:{};
 const cleanup=await (await import("./fly-cleanup")).readPendingFlyCleanup(path);
 const cleanupRecovery=cleanup?{pendingCleanup:{requestId:cleanup.request.requestId,app:cleanup.state.plan.replacement.plan.app,machineId:cleanup.state.plan.survivor.id,retiredMachineId:cleanup.state.plan.retired.id,phase:cleanup.state.phase,completed:cleanup.completion!==null}}:{};
 const recovery={...cleanupRecovery,...activationRecovery,...appliedRecovery,...replacementRecovery,...rollbackRecovery};
 const link=await readDeploymentLink(path);if(!link)return {linked:false as const,...recovery};
 const document=normalizeDeploymentManifest(readConfigDoc(path)) as unknown as DeploymentManifest;
 const refs=manifestReferences(document),baseline=manifestReferences(link.document),env=readConfigEnvironment(path);
 const privateChanges:Array<{env:string;kind:"added"|"removed"|"changed"|"missing";requiresVersionUpdate:boolean}>=[];
 for(const [name,ref] of refs){
 const prior=baseline.get(name),value=env[name];
 if(value===undefined || value===""){privateChanges.push({env:name,kind:"missing",requiresVersionUpdate:false});continue;}
 if(!prior || privateFingerprint(link.privateKey,name,value)!==link.fingerprints[name])privateChanges.push({env:name,kind:prior?"changed":"added",requiresVersionUpdate:prior?.version===ref.version});
 }
 for(const name of baseline.keys())if(!refs.has(name))privateChanges.push({env:name,kind:"removed",requiresVersionUpdate:false});
 return {linked:true as const,...recovery,service:link.service,accountId:link.accountId,deployment:link.deployment,configurationVersion:link.configurationVersion,desiredSequence:link.desiredSequence,target:link.target,baselineRevision:link.revision,revision:await hashConfigDocument(document),changes:(await diffDeploymentManifests(link.document,document)).changes,privateChanges};
}
