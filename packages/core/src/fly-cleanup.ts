import {canonicalConfigJson} from "./config";
import {isInstanceId} from "./deployment-state";
import {validateFlyBindingReceipt,type FlyBindingReceipt} from "./fly-binding";
import {validateFlyRollbackReceipt,validateFlyRollbackFence,validateFlyRollbackRebaseRequest,type FlyRollbackRebaseRequest,type FlyRollbackReceipt,type FlyRollbackFence} from "./fly-rollback";
/** Public reservation only. Resolved survivor/retired settings remain private. */
export interface FlyCleanupRequest {
 requestId:string;bindingRequestId:string;rollbackRequestId:string|null;
 expectedConfigurationVersion:number;expectedSequence:number;revision:string;
 expectedInstanceId:string|null;imageDigest:string;survivorConfigDigest:string;retiredConfigDigest:string;
}
export interface FlyCleanupReceipt {
 request:FlyCleanupRequest;binding:FlyBindingReceipt;rollback:FlyRollbackReceipt|null;
 status:"prepared"|"completed";fence:FlyRollbackFence;
}
const keys=["requestId","bindingRequestId","rollbackRequestId","expectedConfigurationVersion","expectedSequence","revision","expectedInstanceId","imageDigest","survivorConfigDigest","retiredConfigDigest"];
const hash=(v:unknown):v is string=>typeof v==="string" && /^sha256:[a-f0-9]{64}$/.test(v);
export function validateFlyCleanupRequest(value:unknown):FlyCleanupRequest {
 const r=value as FlyCleanupRequest;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==keys.length || Object.keys(r).some(k=>!keys.includes(k)) || !isInstanceId(r.requestId) || !isInstanceId(r.bindingRequestId) || (r.rollbackRequestId!==null && !isInstanceId(r.rollbackRequestId)) || !Number.isSafeInteger(r.expectedConfigurationVersion) || r.expectedConfigurationVersion<0 || r.expectedConfigurationVersion>=Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(r.expectedSequence) || r.expectedSequence<1 || !hash(r.revision) || !hash(r.imageDigest) || !hash(r.survivorConfigDigest) || !hash(r.retiredConfigDigest) || (r.rollbackRequestId===null?!isInstanceId(r.expectedInstanceId):r.expectedInstanceId!==null))throw new Error("Invalid Fly cleanup request");
 return structuredClone(r);
}
export function validateFlyCleanupReceipt(value:unknown):FlyCleanupReceipt {
 const r=value as FlyCleanupReceipt;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==5 || Object.keys(r).some(k=>!["request","binding","rollback","status","fence"].includes(k)) || !["prepared","completed"].includes(r.status))throw new Error("Invalid Fly cleanup receipt");
 const request=validateFlyCleanupRequest(r.request),binding=validateFlyBindingReceipt(r.binding),fence=validateFlyRollbackFence(r.fence),rollback=r.rollback===null?null:validateFlyRollbackReceipt(r.rollback);
 if(binding.request.requestId!==request.bindingRequestId || binding.request.previousMachineId===binding.request.machineId || binding.configurationVersion>request.expectedConfigurationVersion || fence.configurationVersion<request.expectedConfigurationVersion || fence.sequence<request.expectedSequence || (fence.sequence===request.expectedSequence && fence.revision!==request.revision) || (request.rollbackRequestId===null?rollback!==null:!rollback || rollback.status!=="completed" || rollback.request.requestId!==request.rollbackRequestId || rollback.request.bindingRequestId!==request.bindingRequestId || canonicalConfigJson(rollback.binding)!==canonicalConfigJson(binding) || rollback.configurationVersion>request.expectedConfigurationVersion || request.imageDigest!==binding.request.previousImageDigest))throw new Error("Invalid Fly cleanup receipt");
 return {request,binding,rollback,status:r.status,fence};
}

export interface FlyCleanupRebaseReceipt {cleanupId:string;request:FlyRollbackRebaseRequest;}
export function validateFlyCleanupRebaseReceipt(value:unknown):FlyCleanupRebaseReceipt {
 const r=value as FlyCleanupRebaseReceipt;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==2 || Object.keys(r).some(k=>!["cleanupId","request"].includes(k)) || !isInstanceId(r.cleanupId))throw new Error("Invalid Fly cleanup rebase receipt");
 return {cleanupId:r.cleanupId,request:validateFlyRollbackRebaseRequest(r.request)};
}
