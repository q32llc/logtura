import {isInstanceId} from "./deployment-state";
import {validateFlyBindingReceipt,type FlyBindingReceipt} from "./fly-binding";
/** Public fences/physical identities only; resolved rollback payloads stay local. */
export interface FlyRollbackRequest {
 requestId:string;bindingRequestId:string;expectedConfigurationVersion:number;
 expectedSequence:number;revision:string;expectedInstanceId:string|null;
 expectedImageDigest:string;candidateConfigDigest:string;
}
export interface FlyRollbackFence {configurationVersion:number;sequence:number;revision:string;}
export interface FlyRollbackRebaseRequest extends FlyRollbackFence {requestId:string;}
export interface FlyRollbackReceipt {
 request:FlyRollbackRequest;binding:FlyBindingReceipt;
 status:"prepared"|"completed";configurationVersion:number;fence:FlyRollbackFence;
}
const keys=["requestId","bindingRequestId","expectedConfigurationVersion","expectedSequence","revision","expectedInstanceId","expectedImageDigest","candidateConfigDigest"];
const hash=(v:unknown):v is string=>typeof v==="string" && /^sha256:[a-f0-9]{64}$/.test(v);
export function validateFlyRollbackRequest(value:unknown):FlyRollbackRequest {
 const r=value as FlyRollbackRequest;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==keys.length || Object.keys(r).some(k=>!keys.includes(k)) || !isInstanceId(r.requestId) || !isInstanceId(r.bindingRequestId) || !Number.isSafeInteger(r.expectedConfigurationVersion) || r.expectedConfigurationVersion<0 || r.expectedConfigurationVersion>=Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(r.expectedSequence) || r.expectedSequence<1 || !hash(r.revision) || (r.expectedInstanceId!==null && !isInstanceId(r.expectedInstanceId)) || !hash(r.expectedImageDigest) || !hash(r.candidateConfigDigest))throw new Error("Invalid Fly rollback request");
 return structuredClone(r);
}
export function validateFlyRollbackReceipt(value:unknown):FlyRollbackReceipt {
 const r=value as FlyRollbackReceipt;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==5 || Object.keys(r).some(k=>!["request","binding","status","configurationVersion","fence"].includes(k)) || !["prepared","completed"].includes(r.status))throw new Error("Invalid Fly rollback receipt");
 const request=validateFlyRollbackRequest(r.request),binding=validateFlyBindingReceipt(r.binding);
 const fence=validateFlyRollbackFence(r.fence);
 if(binding.request.requestId!==request.bindingRequestId || binding.request.previousMachineId===binding.request.machineId || r.configurationVersion!==fence.configurationVersion+(r.status==="completed"?1:0) || fence.configurationVersion<request.expectedConfigurationVersion || fence.sequence<request.expectedSequence || (fence.sequence===request.expectedSequence && fence.revision!==request.revision) || binding.configurationVersion>request.expectedConfigurationVersion)throw new Error("Invalid Fly rollback receipt");
 return {request,binding,status:r.status,configurationVersion:r.configurationVersion,fence};
}

export function validateFlyRollbackFence(value:unknown):FlyRollbackFence {
 const f=value as FlyRollbackFence;
 if(!f || typeof f!=="object" || Array.isArray(f) || Object.keys(f).length!==3 || Object.keys(f).some(k=>!["configurationVersion","sequence","revision"].includes(k)) || !Number.isSafeInteger(f.configurationVersion) || f.configurationVersion<0 || f.configurationVersion>=Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(f.sequence) || f.sequence<1 || !hash(f.revision))throw new Error("Invalid Fly rollback fence");
 return structuredClone(f);
}
export function validateFlyRollbackRebaseRequest(value:unknown):FlyRollbackRebaseRequest {
 const r=value as FlyRollbackRebaseRequest;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==4 || Object.keys(r).some(k=>!["requestId","configurationVersion","sequence","revision"].includes(k)) || !isInstanceId(r.requestId))throw new Error("Invalid Fly rollback rebase request");
 return {requestId:r.requestId,...validateFlyRollbackFence({configurationVersion:r.configurationVersion,sequence:r.sequence,revision:r.revision})};
}
export interface FlyRollbackRebaseReceipt {rollbackId:string;request:FlyRollbackRebaseRequest;}
export function validateFlyRollbackRebaseReceipt(value:unknown):FlyRollbackRebaseReceipt {
 const r=value as FlyRollbackRebaseReceipt;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==2 || Object.keys(r).some(k=>!["rollbackId","request"].includes(k)) || !isInstanceId(r.rollbackId))throw new Error("Invalid Fly rollback rebase receipt");
 return {rollbackId:r.rollbackId,request:validateFlyRollbackRebaseRequest(r.request)};
}
