import {canonicalConfigJson} from './config';
import {isInstanceId} from './deployment-state';
import {validateDeploymentTarget} from './deployment-target';
/** Optional hosted creation uses existing owned inventory; no provider resource
 * or credential is created/uploaded. Standalone generation never uses it. */
export interface DeploymentCreationRequest {
 requestId:string;connectionId:string;displayName:string;targetKind:string;
 sourceIds:string[]|null;monitorIds:string[]|null;fly:{appName:string;machineId:string}|null;
}
export interface DeploymentCreationReceipt {
 schemaVersion:1;request:DeploymentCreationRequest;deployment:{id:string;displayName:string};status:'created'|'deleted';
}
export function validateDeploymentCreationRequest(value:unknown):DeploymentCreationRequest {
 try {
  const r=value as DeploymentCreationRequest;
  if(!r || typeof r!=='object' || Array.isArray(r) || Object.keys(r).length!==7 || Object.keys(r).some(k=>!['requestId','connectionId','displayName','targetKind','sourceIds','monitorIds','fly'].includes(k)) || !isInstanceId(r.requestId))throw new Error();
  for(const text of [r.connectionId,r.displayName])if(typeof text!=='string' || !text.trim() || text.length>256 || /[\x00-\x1f\x7f]/.test(text))throw new Error();
  validateDeploymentTarget({kind:r.targetKind,managed:false,imageDigest:null,fly:r.fly});
  if(r.fly!==null && (!r.fly.machineId || Object.keys(r.fly).length!==2))throw new Error();
  for(const selection of [r.sourceIds,r.monitorIds])if(selection!==null && (!Array.isArray(selection) || selection.length>1000 || new Set(selection).size!==selection.length || selection.some(id=>typeof id!=='string' || !id.trim() || id.length>256 || /[\x00-\x1f\x7f]/.test(id))))throw new Error();
  return structuredClone(r);
 }catch{throw new Error('Invalid deployment creation request');}
}
export function validateDeploymentCreationReceipt(value:unknown):DeploymentCreationReceipt {
 try {
  const r=value as DeploymentCreationReceipt;
  if(!r || typeof r!=='object' || Array.isArray(r) || Object.keys(r).length!==4 || Object.keys(r).some(k=>!['schemaVersion','request','deployment','status'].includes(k)) || r.schemaVersion!==1 || !['created','deleted'].includes(r.status))throw new Error();
  validateDeploymentCreationRequest(r.request);
  if(!r.deployment || typeof r.deployment!=='object' || Array.isArray(r.deployment) || Object.keys(r.deployment).length!==2 || Object.keys(r.deployment).some(k=>!['id','displayName'].includes(k)) || typeof r.deployment.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.deployment.id) || r.deployment.displayName!==r.request.displayName)throw new Error();
  return structuredClone(r);
 }catch{throw new Error('Invalid deployment creation receipt');}
}
export function matchesDeploymentCreation(receipt:DeploymentCreationReceipt,request:DeploymentCreationRequest):boolean {
 return canonicalConfigJson(receipt.request)===canonicalConfigJson(request);
}
