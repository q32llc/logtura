import { hashConfigDocument } from "./config";
import { normalizeDeploymentManifest,type DeploymentManifest } from "./manifest";
export interface DeploymentConfigurationState {
 desired:{sequence:number;revision:string;document:DeploymentManifest;configurationVersion:number};
 applied:{sequence:number;revision:string;at:number}|null;
 activeInstanceId:string|null;lastReportSequence:number;stale:boolean;
}
export interface DeploymentInstanceActivation {requestId:string;expectedConfigurationVersion:number;expectedSequence:number;revision:string;expectedInstanceId:string|null;}
export interface DeploymentInstanceReceipt {requestId:string;instanceId:string;configurationVersion:number;sequence:number;revision:string;}
export interface DeploymentAppliedReport {instanceId:string;sequence:number;revision:string;reportSequence:number;}
export function isInstanceId(value:unknown):value is string{return typeof value==="string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);}
function record(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value && typeof value==="object" && !Array.isArray(value) && Object.keys(value).length===keys.length && Object.keys(value).every(key=>keys.includes(key));}
function counter(value:unknown,minimum=0):boolean{return Number.isSafeInteger(value) && (value as number)>=minimum;}
function revision(value:unknown):boolean{return typeof value==="string" && /^sha256:[a-f0-9]{64}$/.test(value);}
export function validateDeploymentActivation(value:unknown):DeploymentInstanceActivation {
 if(!record(value,["requestId","expectedConfigurationVersion","expectedSequence","revision","expectedInstanceId"]) || !isInstanceId(value.requestId) || !counter(value.expectedConfigurationVersion) || !counter(value.expectedSequence,1) || !revision(value.revision) || (value.expectedInstanceId!==null && !isInstanceId(value.expectedInstanceId)))throw new Error("Invalid deployment activation");
 return structuredClone(value) as unknown as DeploymentInstanceActivation;
}
export function validateDeploymentInstanceReceipt(value:unknown):DeploymentInstanceReceipt {
 if(!record(value,["requestId","instanceId","configurationVersion","sequence","revision"]) || !isInstanceId(value.requestId) || !isInstanceId(value.instanceId) || !counter(value.configurationVersion) || !counter(value.sequence,1) || !revision(value.revision))throw new Error("Invalid deployment instance receipt");
 return structuredClone(value) as unknown as DeploymentInstanceReceipt;
}
export function validateDeploymentAppliedReport(value:unknown):DeploymentAppliedReport {
 if(!record(value,["instanceId","sequence","revision","reportSequence"]) || !isInstanceId(value.instanceId) || !counter(value.sequence,1) || !revision(value.revision) || !counter(value.reportSequence,1))throw new Error("Invalid deployment applied report");
 return structuredClone(value) as unknown as DeploymentAppliedReport;
}
export async function validateDeploymentConfigurationState(value:unknown):Promise<DeploymentConfigurationState>{
 if(!record(value,["desired","applied","activeInstanceId","lastReportSequence","stale"]) || !record(value.desired,["sequence","revision","document","configurationVersion"]) || !counter(value.desired.sequence,1) || !counter(value.desired.configurationVersion) || !revision(value.desired.revision) || !counter(value.lastReportSequence) || typeof value.stale!=="boolean" || (value.activeInstanceId!==null && !isInstanceId(value.activeInstanceId)) || (value.activeInstanceId===null && value.lastReportSequence!==0))throw new Error("Invalid deployment configuration state");
 const doc=normalizeDeploymentManifest(value.desired.document);if(await hashConfigDocument(doc)!==value.desired.revision)throw new Error("Invalid deployment configuration state");
 if(value.applied===null && (value.lastReportSequence as number)>0)throw new Error("Invalid deployment configuration state");
 if(value.applied!==null && (!record(value.applied,["sequence","revision","at"]) || !counter(value.applied.sequence,1) || (value.applied.sequence as number)>(value.desired.sequence as number) || !revision(value.applied.revision) || (value.applied.sequence===value.desired.sequence && value.applied.revision!==value.desired.revision) || !counter(value.applied.at)))throw new Error("Invalid deployment configuration state");
 return structuredClone(value) as unknown as DeploymentConfigurationState;
}
