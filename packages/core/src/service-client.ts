import type { DeploymentManifest } from "./manifest";
import { normalizeDeploymentManifest } from "./manifest";
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
export interface DeploymentConfigExport {configurationVersion?:number;document:DeploymentManifest;revision:string;deployment:{id:string;displayName:string};secretValues?:Record<string,string>;}
export class LogturaServiceClient {
  readonly url:string;
  constructor(private readonly options:ServiceClientOptions){
    this.url=normalizeServiceUrl(options.url);
    if(options.token!==undefined && !/^lt_cli_[A-Za-z0-9_-]{43}$/.test(options.token))throw new ServiceError(401,"invalid_account_token");
  }
  private async response(path:string,init:RequestInit={}) {
    if(!path.startsWith("/") || path.startsWith("//"))throw new Error("Invalid service API path");
    const url=new URL(`/api${path}`,this.url);
    if(url.origin!==this.url || !url.pathname.startsWith("/api/"))throw new Error("Invalid service API path");
    const headers=new Headers(init.headers);headers.set("accept","application/json");
    if(init.body)headers.set("content-type","application/json");
    if(this.options.token)headers.set("authorization",`Bearer ${this.options.token}`);
    return this.options.fetch(url.toString(),{...init,headers,redirect:"manual",credentials:"omit",signal:init.signal??AbortSignal.timeout(20_000)});
  }
  async request<T>(path:string,init:RequestInit={}):Promise<T>{
    const response=await this.response(path,init);const body=await response.json().catch(()=>null) as {error?:unknown}|null;
    if(!response.ok)throw new ServiceError(response.status,typeof body?.error==="string"?body.error:"request_failed");
    if(body===null)throw new ServiceError(response.status,"invalid_response");
    return body as T;
  }
  async startDevice(label:string):Promise<DeviceAuthorization>{
    const device=await this.request<DeviceAuthorization>("/cli/device/start",{method:"POST",body:JSON.stringify({label})});
    if(!/^[A-Za-z0-9_-]{43}$/.test(device.deviceCode) || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(device.userCode) ||
      !Number.isFinite(device.expiresIn) || device.expiresIn<=0 || device.expiresIn>3600 || !Number.isFinite(device.interval) || device.interval<1 || device.interval>60 ||
      typeof device.verificationUri!=="string" || new URL(device.verificationUri).origin!==this.url || !new URL(device.verificationUri).pathname.startsWith("/app/cli"))throw new ServiceError(200,"invalid_device_response");
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
    if((result.configurationVersion!==undefined && (!Number.isSafeInteger(result.configurationVersion) || result.configurationVersion<0)) || !/^sha256:[a-f0-9]{64}$/.test(result.revision) || result.deployment?.id!==id || typeof result.deployment.displayName!=="string" ||
      (includeSecrets && (!result.secretValues || typeof result.secretValues!=="object" || Array.isArray(result.secretValues) || Object.values(result.secretValues).some(value=>typeof value!=="string"))))throw new ServiceError(200,"invalid_config_response");
    return result;
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
