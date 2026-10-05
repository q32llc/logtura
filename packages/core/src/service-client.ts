import {validateDeploymentCreationRequest,validateDeploymentCreationReceipt,matchesDeploymentCreation,type DeploymentCreationRequest,type DeploymentCreationReceipt} from './deployment-creation';
import {validateFlyCleanupRequest,validateFlyCleanupReceipt,validateFlyCleanupRebaseReceipt,type FlyCleanupRequest,type FlyCleanupReceipt,type FlyCleanupRebaseReceipt} from "./fly-cleanup";
import {validateFlyRollbackRequest,validateFlyRollbackReceipt,validateFlyRollbackRebaseRequest,validateFlyRollbackRebaseReceipt,type FlyRollbackRequest,type FlyRollbackReceipt,type FlyRollbackRebaseRequest,type FlyRollbackRebaseReceipt} from "./fly-rollback";
import { isInstanceId,validateDeploymentActivation,validateDeploymentInstanceReceipt,validateDeploymentConfigurationState,type DeploymentConfigurationState,type DeploymentInstanceActivation,type DeploymentInstanceReceipt } from "./deployment-state";
import { validateDeploymentTarget,type DeploymentTarget } from "./deployment-target";
import {validateFlyBindingRequest,validateFlyBindingReceipt,type FlyBindingRequest,type FlyBindingReceipt} from "./fly-binding";
import type { DeploymentManifest } from "./manifest";
import { normalizeDeploymentManifest,parseDeploymentManifest } from "./manifest";
import { hashConfigDocument } from "./config";
import {canonicalConfigJson} from "./config";
/** Optional hosted-account transport. Callers supply fetch; standalone rendering
 * never constructs this client or contacts a service. */
export interface ServiceClientOptions {url:string;token?:string;fetch:typeof fetch;}
export interface DeviceAuthorization {deviceCode:string;userCode:string;verificationUri:string;expiresIn:number;interval:number;}
export interface AccountCredential {token:string;expiresAt:number;scope:string;}
export type DevicePoll = {state:"pending"|"slow_down"} | {state:"authorized";credential:AccountCredential};
export interface ServiceUser {id:string;githubLogin:string;name:string|null;email:string|null;avatarUrl:string|null;}
export class ServiceError extends Error {
  constructor(public readonly status:number,public readonly code:string) {super(`Logtura service: ${code} (HTTP ${status})`);this.name="ServiceError";}
}
export function normalizeServiceUrl(value:string):string {
  const url=new URL(value);
  if(url.username || url.password || url.search || url.hash || (url.pathname!=="/" && url.pathname!==""))throw new Error("Service URL must be an origin without credentials, path or query");
  if(url.protocol!=="https:" && !(url.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)))throw new Error("Service URL requires HTTPS (loopback HTTP is allowed)");
  return url.origin;
}
export interface DeploymentConfigExport {target?:DeploymentTarget;configurationVersion?:number;desiredSequence?:number;document:DeploymentManifest;revision:string;deployment:{id:string;displayName:string};secretValues?:Record<string,string>;}
export interface DeploymentConfigPush {document:DeploymentManifest;expectedConfigurationVersion:number;expectedSequence:number;uploadSecrets?:boolean;secretValues?:Record<string,string>;requestId?:string;}
export interface DeploymentConfigCommit {configurationVersion:number;sequence:number;revision:string;document:DeploymentManifest;sourceAliases:Record<string,string>;}
export interface DeploymentPushReceipt {requestId:string;result:DeploymentConfigCommit;}
export function isDeploymentPushRequestId(value:unknown):value is string {return typeof value==="string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);}
export async function validateDeploymentConfigCommit(value:unknown):Promise<DeploymentConfigCommit>{
  try{
    const result=value as DeploymentConfigCommit;
    if(!result || typeof result!=="object" || Array.isArray(result) || Object.keys(result).some(key=>!["configurationVersion","sequence","revision","document","sourceAliases"].includes(key)))throw new Error();
    normalizeDeploymentManifest(result.document);
    if(!Number.isSafeInteger(result.configurationVersion) || result.configurationVersion<0 || !Number.isSafeInteger(result.sequence) || result.sequence<=0 || result.revision!==await hashConfigDocument(result.document) || !result.sourceAliases || typeof result.sourceAliases!=="object" || Array.isArray(result.sourceAliases) || Object.values(result.sourceAliases).some(v=>typeof v!=="string" || !v))throw new Error();
    return result;
  }catch{throw new ServiceError(200,"invalid_config_commit");}
}
export class LogturaServiceClient {
  readonly url:string;
  async rebaseFlyRollback(id:string,rollbackId:string,input:FlyRollbackRebaseRequest):Promise<FlyRollbackRebaseReceipt>{
    if(!id || !isInstanceId(rollbackId))throw new Error("Invalid Fly rollback identity");const request=validateFlyRollbackRebaseRequest(input);
    const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-rollbacks/${encodeURIComponent(rollbackId)}/rebases`,{method:"POST",body:JSON.stringify(request)});
    try{const receipt=validateFlyRollbackRebaseReceipt(result);if(receipt.rollbackId!==rollbackId || canonicalConfigJson(receipt.request)!==canonicalConfigJson(request))throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_rollback_rebase_receipt");}
  }
  async getFlyRollbackRebase(id:string,rollbackId:string,requestId:string):Promise<FlyRollbackRebaseReceipt|null>{
    if(!id || !isInstanceId(rollbackId) || !isInstanceId(requestId))throw new Error("Invalid Fly rollback rebase identity");
    try{const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-rollbacks/${encodeURIComponent(rollbackId)}/rebases/${encodeURIComponent(requestId)}`,{method:"GET"});
      try{const receipt=validateFlyRollbackRebaseReceipt(result);if(receipt.rollbackId!==rollbackId || receipt.request.requestId!==requestId)throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_rollback_rebase_receipt");}
    }catch(error){if(error instanceof ServiceError && error.status===404 && error.code==="receipt_not_found")return null;throw error;}
  }
  async prepareFlyCleanup(id:string,input:FlyCleanupRequest):Promise<FlyCleanupReceipt>{
    if(!id)throw new Error("Deployment identity is required");const request=validateFlyCleanupRequest(input);
    const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-cleanups`,{method:"POST",body:JSON.stringify(request)});
    try{const receipt=validateFlyCleanupReceipt(result);if(canonicalConfigJson(receipt.request)!==canonicalConfigJson(request))throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_cleanup_receipt");}
  }
  async getFlyCleanup(id:string,requestId:string):Promise<FlyCleanupReceipt|null>{
    if(!id || !isInstanceId(requestId))throw new Error("Invalid Fly cleanup identity");
    try{const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-cleanups/${encodeURIComponent(requestId)}`,{method:"GET"});
      try{const receipt=validateFlyCleanupReceipt(result);if(receipt.request.requestId!==requestId)throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_cleanup_receipt");}
    }catch(error){if(error instanceof ServiceError && error.status===404 && error.code==="receipt_not_found")return null;throw error;}
  }
  async completeFlyCleanup(id:string,requestId:string):Promise<FlyCleanupReceipt>{
    if(!id || !isInstanceId(requestId))throw new Error("Invalid Fly cleanup identity");
    const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-cleanups/${encodeURIComponent(requestId)}/complete`,{method:"POST"});
    try{const receipt=validateFlyCleanupReceipt(result);if(receipt.request.requestId!==requestId || receipt.status!=="completed")throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_cleanup_receipt");}
  }
  async rebaseFlyCleanup(id:string,cleanupId:string,input:FlyRollbackRebaseRequest):Promise<FlyCleanupRebaseReceipt>{
    if(!id || !isInstanceId(cleanupId))throw new Error("Invalid Fly cleanup identity");const request=validateFlyRollbackRebaseRequest(input);
    const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-cleanups/${encodeURIComponent(cleanupId)}/rebases`,{method:"POST",body:JSON.stringify(request)});
    try{const receipt=validateFlyCleanupRebaseReceipt(result);if(receipt.cleanupId!==cleanupId || canonicalConfigJson(receipt.request)!==canonicalConfigJson(request))throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_cleanup_rebase_receipt");}
  }
  async getFlyCleanupRebase(id:string,cleanupId:string,requestId:string):Promise<FlyCleanupRebaseReceipt|null>{
    if(!id || !isInstanceId(cleanupId) || !isInstanceId(requestId))throw new Error("Invalid Fly cleanup identity");
    try{const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-cleanups/${encodeURIComponent(cleanupId)}/rebases/${encodeURIComponent(requestId)}`,{method:"GET"});
      try{const receipt=validateFlyCleanupRebaseReceipt(result);if(receipt.cleanupId!==cleanupId || receipt.request.requestId!==requestId)throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_cleanup_rebase_receipt");}
    }catch(error){if(error instanceof ServiceError && error.status===404 && error.code==="receipt_not_found")return null;throw error;}
  }

  async prepareFlyRollback(id:string,input:FlyRollbackRequest):Promise<FlyRollbackReceipt>{
    if(!id)throw new Error("Deployment identity is required");const request=validateFlyRollbackRequest(input);
    const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-rollbacks`,{method:"POST",body:JSON.stringify(request)});
    try{const receipt=validateFlyRollbackReceipt(result);if(canonicalConfigJson(receipt.request)!==canonicalConfigJson(request))throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_rollback_receipt");}
  }
  async getFlyRollback(id:string,requestId:string):Promise<FlyRollbackReceipt|null>{
    if(!id || !isInstanceId(requestId))throw new Error("Invalid Fly rollback identity");
    try{const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-rollbacks/${encodeURIComponent(requestId)}`,{method:"GET"});
      try{const receipt=validateFlyRollbackReceipt(result);if(receipt.request.requestId!==requestId)throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_rollback_receipt");}
    }catch(error){if(error instanceof ServiceError && error.status===404 && error.code==="receipt_not_found")return null;throw error;}
  }
  async completeFlyRollback(id:string,requestId:string):Promise<FlyRollbackReceipt>{
    if(!id || !isInstanceId(requestId))throw new Error("Invalid Fly rollback identity");
    const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-rollbacks/${encodeURIComponent(requestId)}/complete`,{method:"POST"});
    try{const receipt=validateFlyRollbackReceipt(result);if(receipt.request.requestId!==requestId || receipt.status!=="completed")throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_rollback_receipt");}
  }

  async bindFlyReplacement(id:string,input:FlyBindingRequest):Promise<FlyBindingReceipt>{
    if(!id)throw new Error("Deployment identity is required");
    const request=validateFlyBindingRequest(input);
    const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-bindings`,{method:"POST",body:JSON.stringify(request)});
    try{const receipt=validateFlyBindingReceipt(result);if(canonicalConfigJson(receipt.request)!==canonicalConfigJson(request))throw new Error();return receipt;}
    catch{throw new ServiceError(200,"invalid_binding_receipt");}
  }
  async getFlyBindingReceipt(id:string,requestId:string):Promise<FlyBindingReceipt|null>{
    if(!id || !isInstanceId(requestId))throw new Error("Invalid Fly binding identity");
    try{
      const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-bindings/${encodeURIComponent(requestId)}`,{method:"GET"});
      try{const receipt=validateFlyBindingReceipt(result);if(receipt.request.requestId!==requestId)throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_binding_receipt");}
    }catch(error){if(error instanceof ServiceError && error.status===404 && error.code==="receipt_not_found")return null;throw error;}
  }
  async getFlyBinding(id:string):Promise<FlyBindingReceipt|null>{
    if(!id)throw new Error("Deployment identity is required");
    const result=await this.request(`/deployments/${encodeURIComponent(id)}/config/fly-binding`,{method:"GET"}) as {binding:unknown};
    if(!result || typeof result!=="object" || Array.isArray(result) || Object.keys(result).length!==1 || !Object.hasOwn(result,"binding"))throw new ServiceError(200,"invalid_binding_receipt");
    try{return result.binding===null?null:validateFlyBindingReceipt(result.binding);}catch{throw new ServiceError(200,"invalid_binding_receipt");}
  }
  constructor(private readonly options:ServiceClientOptions){
    this.url=normalizeServiceUrl(options.url);
    if(options.token!==undefined && !/^lt_cli_[A-Za-z0-9_-]{43}$/.test(options.token))throw new ServiceError(401,"invalid_account_token");
  }
  private async response(path:string,init:RequestInit) {
    if(!path.startsWith("/") || path.startsWith("//"))throw new Error("Invalid service API path");
    const url=new URL(`/api${path}`,this.url);
    if(url.origin!==this.url || !url.pathname.startsWith("/api/"))throw new Error("Invalid service API path");
    const headers=new Headers(init.headers);headers.set("accept","application/json");
    if(init.body)headers.set("content-type","application/json");
    if(this.options.token)headers.set("authorization",`Bearer ${this.options.token}`);
    return this.options.fetch.call(globalThis,url.toString(),{...init,headers,redirect:"manual",credentials:"omit",signal:init.signal??AbortSignal.timeout(20_000)});
  }
  async request<T>(path:string,init:RequestInit={}):Promise<T>{
    const response=await this.response(path,init);const body=await response.json().catch(()=>null) as {error?:unknown}|null;
    if(!response.ok)throw new ServiceError(response.status,typeof body?.error==="string"?body.error:"request_failed");
    if(body===null)throw new ServiceError(response.status,"invalid_response");
    return body as T;
  }
  async startDevice(label:string):Promise<DeviceAuthorization>{
    const device=await this.request<DeviceAuthorization>("/cli/device/start",{method:"POST",body:JSON.stringify({label})});
    if(typeof device.verificationUri!=="string")throw new ServiceError(200,"invalid_device_response");
    let verification:URL;try{verification=new URL(device.verificationUri);}catch{throw new ServiceError(200,"invalid_device_response");}
    if(!/^[A-Za-z0-9_-]{43}$/.test(device.deviceCode) || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(device.userCode) ||
      !Number.isFinite(device.expiresIn) || device.expiresIn<=0 || device.expiresIn>3600 || !Number.isFinite(device.interval) || device.interval<1 || device.interval>60 ||
      verification.origin!==this.url || verification.pathname!=="/app/cli")throw new ServiceError(200,"invalid_device_response");
    return device;
  }
  async pollDevice(deviceCode:string):Promise<DevicePoll>{
    const response=await this.response("/cli/device/poll",{method:"POST",body:JSON.stringify({deviceCode})});
    const body=await response.json().catch(()=>null) as any;
    if(response.status===202 && body?.error==="authorization_pending")return {state:"pending"};
    if(response.status===429 && body?.error==="slow_down")return {state:"slow_down"};
    if(!response.ok)throw new ServiceError(response.status,typeof body?.error==="string"?body.error:"request_failed");
    if(!body || !/^lt_cli_[A-Za-z0-9_-]{43}$/.test(body.token) || !Number.isFinite(body.expiresAt) || body.expiresAt<=Date.now() || body.scope!=="account:read account:write")throw new ServiceError(response.status,"invalid_credential_response");
    return {state:"authorized",credential:{token:body.token,expiresAt:body.expiresAt,scope:body.scope}};
  }
  async whoami():Promise<ServiceUser>{
    const response=await this.request<{user:ServiceUser|null}>("/me");
    if(!response.user || typeof response.user.id!=="string" || !response.user.id || typeof response.user.githubLogin!=="string" || !response.user.githubLogin)throw new ServiceError(401,"auth_required");
    return response.user;
  }
  async pullDeploymentConfig(id:string,includeSecrets=false):Promise<DeploymentConfigExport> {
    if(!id)throw new Error("Deployment identity is required");
    const result=await this.request<DeploymentConfigExport>(`/deployments/${encodeURIComponent(id)}/config${includeSecrets?"?includeSecrets=1":""}`);
    normalizeDeploymentManifest(result.document);
    if((result.desiredSequence!==undefined && (!Number.isSafeInteger(result.desiredSequence) || result.desiredSequence<0)) || (result.configurationVersion!==undefined && (!Number.isSafeInteger(result.configurationVersion) || result.configurationVersion<0)) || !/^sha256:[a-f0-9]{64}$/.test(result.revision) || result.deployment?.id!==id || typeof result.deployment.displayName!=="string" ||
      (includeSecrets && (!result.secretValues || typeof result.secretValues!=="object" || Array.isArray(result.secretValues) || Object.values(result.secretValues).some(value=>typeof value!=="string"))))throw new ServiceError(200,"invalid_config_response");
    if(result.target!==undefined)try{result.target=validateDeploymentTarget(result.target);}catch{throw new ServiceError(200,"invalid_config_response");}
    return result;
  }
  async getDeploymentConfigurationState(id:string):Promise<DeploymentConfigurationState|null>{
    if(!id)throw new Error("Deployment identity is required");
    const response=await this.request<{state:unknown}>(`/deployments/${encodeURIComponent(id)}/config/state`);
    try{if(!response || typeof response!=="object" || Array.isArray(response) || Object.keys(response).some(key=>key!=="state") || !("state" in response))throw new Error();return response.state===null?null:await validateDeploymentConfigurationState(response.state);}catch{throw new ServiceError(200,"invalid_config_state");}
  }
  async activateDeploymentInstance(id:string,input:DeploymentInstanceActivation):Promise<DeploymentInstanceReceipt>{
    if(!id)throw new Error("Deployment identity is required");const intent=validateDeploymentActivation(input);
    const result=await this.request<DeploymentInstanceReceipt>(`/deployments/${encodeURIComponent(id)}/config/instances`,{method:"POST",body:JSON.stringify(intent)});
    try{const receipt=validateDeploymentInstanceReceipt(result);if(receipt.requestId!==intent.requestId || receipt.configurationVersion!==intent.expectedConfigurationVersion || receipt.sequence!==intent.expectedSequence || receipt.revision!==intent.revision)throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_instance_receipt");}
  }
  async getDeploymentInstanceReceipt(id:string,requestId:string):Promise<DeploymentInstanceReceipt|null>{
    if(!id || !isInstanceId(requestId))throw new Error("Deployment and activation request identities are required");
    let result:unknown;try{result=await this.request(`/deployments/${encodeURIComponent(id)}/config/instances/${requestId}`);}catch(error){if(error instanceof ServiceError && error.status===404 && error.code==="receipt_not_found")return null;throw error;}
    try{const receipt=validateDeploymentInstanceReceipt(result);if(receipt.requestId!==requestId)throw new Error();return receipt;}catch{throw new ServiceError(200,"invalid_instance_receipt");}
  }
  async pushDeploymentConfig(id:string,input:DeploymentConfigPush):Promise<DeploymentConfigCommit>{
    if(!id)throw new Error("Deployment identity is required");
    normalizeDeploymentManifest(input.document);
    if(input.requestId!==undefined && !isDeploymentPushRequestId(input.requestId))throw new Error("Invalid push request identity");
    if(!Number.isSafeInteger(input.expectedConfigurationVersion) || input.expectedConfigurationVersion<0 || !Number.isSafeInteger(input.expectedSequence) || input.expectedSequence<0 || input.expectedSequence>=Number.MAX_SAFE_INTEGER || (input.uploadSecrets!==undefined && typeof input.uploadSecrets!=="boolean"))throw new Error("Invalid push baseline");
    if(input.secretValues!==undefined && !input.uploadSecrets)throw new Error("Secret upload must be explicitly authorized");
    if(input.secretValues!==undefined){
      const required=new Set(parseDeploymentManifest(input.document).requiredEnv);
      if(!input.secretValues || typeof input.secretValues!=="object" || Array.isArray(input.secretValues) || Object.values(input.secretValues).some(v=>typeof v!=="string" || !v) || Object.keys(input.secretValues).some(name=>!required.has(name)))throw new Error("Invalid secret upload");
      try{parseDeploymentManifest(input.document,{env:input.secretValues});}catch{throw new Error("Invalid secret upload");}
    }
    const result=await this.request<DeploymentConfigCommit>(`/deployments/${encodeURIComponent(id)}/config`,{method:"PUT",body:JSON.stringify(input)});
    await validateDeploymentConfigCommit(result);
    if(result.configurationVersion<input.expectedConfigurationVersion || result.sequence<input.expectedSequence || result.sequence>input.expectedSequence+1)throw new ServiceError(200,"invalid_config_commit");
    return result;
  }
  async getDeploymentPushReceipt(id:string,requestId:string):Promise<DeploymentPushReceipt|null>{
    if(!id || !isDeploymentPushRequestId(requestId))throw new Error("Deployment and push request identities are required");
    let receipt:DeploymentPushReceipt;
    try{receipt=await this.request<DeploymentPushReceipt>(`/deployments/${encodeURIComponent(id)}/config/receipts/${requestId}`);}
    catch(error){if(error instanceof ServiceError && error.status===404 && error.code==="receipt_not_found")return null;throw error;}
    if(!receipt || receipt.requestId!==requestId || Object.keys(receipt).some(key=>!["requestId","result"].includes(key)))throw new ServiceError(200,"invalid_push_receipt");
    return {requestId,result:await validateDeploymentConfigCommit(receipt.result)};
  }
  async createDeployment(input:DeploymentCreationRequest):Promise<DeploymentCreationReceipt>{
    const request=validateDeploymentCreationRequest(input);
    const value=await this.request('/deployments/creations',{method:'POST',body:JSON.stringify(request)});
    try{const receipt=validateDeploymentCreationReceipt(value);if(!matchesDeploymentCreation(receipt,request))throw new Error();return receipt;}catch{throw new ServiceError(200,'invalid_creation_receipt');}
  }
  async getDeploymentCreation(requestId:string):Promise<DeploymentCreationReceipt|null>{
    if(!isInstanceId(requestId))throw new Error('Invalid deployment creation identity');
    try{const value=await this.request(`/deployments/creations/${requestId}`);
      try{const receipt=validateDeploymentCreationReceipt(value);if(receipt.request.requestId!==requestId)throw new Error();return receipt;}catch{throw new ServiceError(200,'invalid_creation_receipt');}
    }catch(error){if(error instanceof ServiceError && error.status===404 && error.code==='receipt_not_found')return null;throw error;}
  }
  async logout():Promise<void>{await this.request("/cli/logout",{method:"POST",body:"{}"});}
}

/** Browser and timing adapters allow the same login protocol to be exercised
 * without launching a browser or sleeping in automated tests. */
export async function authorizeCliDevice(client:LogturaServiceClient,label:string,adapters:{
  show:(device:DeviceAuthorization)=>void|Promise<void>;sleep:(milliseconds:number)=>Promise<void>;now?:()=>number;
}):Promise<AccountCredential>{
  const now=adapters.now??Date.now;const device=await client.startDevice(label);
  const deadline=now()+device.expiresIn*1000;let interval=device.interval*1000;await adapters.show(device);
  while(now()<deadline){
    const poll=await client.pollDevice(device.deviceCode);
    if(poll.state==="authorized")return poll.credential;
    if(poll.state==="slow_down")interval=Math.min(interval+5_000,60_000);
    await adapters.sleep(Math.min(interval,Math.max(0,deadline-now())));
  }
  throw new ServiceError(410,"authorization_expired");
}
