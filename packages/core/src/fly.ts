import { canonicalConfigJson } from "./config";

export type FlyMachineConfig = Record<string, unknown> & {image: string};
export interface FlyMachine {id:string;instance_id:string;state:string;region:string;config:FlyMachineConfig;image_ref:{registry:string;repository:string;digest:string};}
export interface FlyVolume {id:string;region:string;state:string;encrypted:boolean;attached_machine_id:string|null;name?:string;size_gb?:number;}
export interface FlyVolumeCreateOptions {name:string;region:string;sizeGb:number;compute:{cpu_kind:"shared"|"performance";cpus:number;memory_mb:number};}
export type FlyCreatedVolume = FlyVolume & {name:string;size_gb:number};
export interface FlyMachinePlan {app:string;machineId:string;version:string;before:FlyMachineConfig;after:FlyMachineConfig;}
export class FlyMachineError extends Error {
  constructor(public readonly status:number) {super(`Fly Machines request failed (HTTP ${status})`);this.name="FlyMachineError";}
}
function object(value:unknown):value is Record<string,unknown> {return !!value && typeof value==="object" && !Array.isArray(value);}
function identifier(value:string):string {if(!/^[a-zA-Z0-9_-]{1,128}$/.test(value))throw new Error("Invalid Fly resource identity");return encodeURIComponent(value);}
export function validateFlyMachine(value:unknown):FlyMachine {
  const machine=value as FlyMachine;
  if(!object(machine) || typeof machine.id!=="string" || typeof machine.instance_id!=="string" || !machine.instance_id || typeof machine.state!=="string" || !/^[a-z]{3}$/.test(machine.region) || !object(machine.config) || typeof machine.config.image!=="string" || !object(machine.image_ref) || typeof machine.image_ref.registry!=="string" || typeof machine.image_ref.repository!=="string" || !/^sha256:[a-f0-9]{64}$/.test(machine.image_ref.digest) || (machine as Record<string,unknown>).incomplete_config || ((machine as Record<string,unknown>).host_status!==undefined && (machine as Record<string,unknown>).host_status!=="ok"))throw new Error("Fly returned an incomplete machine configuration");
  identifier(machine.id);canonicalConfigJson(machine.config);return structuredClone(machine);
}
export function immutableFlyImage(image:string):string {
  if(!/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(image) || image.includes("..") || image.includes("//"))throw new Error("Fly runtime image must be pinned by sha256 digest");return image;
}
export function flyRollbackConfig(machine:FlyMachine):FlyMachineConfig {
  const checked=validateFlyMachine(machine);
  return {...checked.config,image:immutableFlyImage(`${checked.image_ref.registry}/${checked.image_ref.repository}@${checked.image_ref.digest}`)};
}
function validateFlyVolume(value:unknown):FlyVolume {
  if(!object(value) || typeof value.id!=="string" || !/^vol_[a-z0-9]+$/.test(value.id) || typeof value.region!=="string" || !/^[a-z]{3}$/.test(value.region) || typeof value.state!=="string" || typeof value.encrypted!=="boolean" || (value.attached_machine_id!==null && typeof value.attached_machine_id!=="string") || (value.name!==undefined && typeof value.name!=="string") || (value.size_gb!==undefined && (!Number.isSafeInteger(value.size_gb) || (value.size_gb as number)<1)))throw new Error("Invalid Fly volume inventory");
  return structuredClone(value) as unknown as FlyVolume;
}
/** Matches requested settings, including mount order/identity. Fly decorates mounts
 * with volume inventory metadata after creation; those additions are not settings.
 * Existing explicit metadata and all other requested fields still match exactly. */
export function matchesFlyConfig(actual:FlyMachineConfig,planned:FlyMachineConfig):boolean {
  return Object.entries(planned).every(([key,value])=>{
    if(!Object.hasOwn(actual,key))return false;
    if(key!=="mounts")return canonicalConfigJson(actual[key])===canonicalConfigJson(value);
    if(!Array.isArray(value)||!Array.isArray(actual.mounts)||actual.mounts.length!==value.length)return false;
    const mounts=actual.mounts;
    return value.every((mount,index)=>{
      const observed=mounts[index];if(!object(mount)||!object(observed))return false;
      if(!Object.entries(mount).every(([field,setting])=>Object.hasOwn(observed,field)&&canonicalConfigJson(observed[field])===canonicalConfigJson(setting)))return false;
      return Object.entries(observed).every(([field,metadata])=>{
        if(Object.hasOwn(mount,field))return true;
        if(field==="encrypted")return metadata===true;
        if(field==="size_gb")return Number.isSafeInteger(metadata)&&(metadata as number)>0;
        if(field==="name")return typeof metadata==="string"&&/^[a-z][a-z0-9_]{0,63}$/.test(metadata);
        return false;
      });
    });
  });
}
/** Portable, bounded HTTP transport. Tokens and provider response bodies never enter errors.
 * An injected fetch must retain the same origin/redirect rules (useful for local fixtures). */
export class FlyMachinesClient {
  private readonly authorization:string;
  constructor(options:{token:string;authorizationScheme?:"Bearer"|"FlyV1";fetch?:typeof fetch;timeoutMs?:number;signal?:AbortSignal}) {
    if(!options.token || /[\s\x00-\x1f\x7f]/.test(options.token) || options.token.length>65_536)throw new Error("Invalid Fly API token");
    if(options.authorizationScheme!==undefined && !["Bearer","FlyV1"].includes(options.authorizationScheme))throw new Error("Invalid Fly authorization scheme");
    this.signal=options.signal;
    this.authorization=`${options.authorizationScheme??(options.token.split(",").some(part=>/^(fm1r|fm2)_/.test(part))?"FlyV1":"Bearer")} ${options.token}`;
    this.fetcher=options.fetch??fetch;this.timeoutMs=options.timeoutMs??20_000;
    if(!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs<1 || this.timeoutMs>120_000)throw new Error("Invalid Fly request timeout");
  }
  private readonly signal:AbortSignal|undefined;
  private readonly fetcher:typeof fetch;private readonly timeoutMs:number;
  private async request(path:string,method="GET",body?:unknown,nonce?:string):Promise<unknown> {
    this.signal?.throwIfAborted();
    if(nonce!==undefined && (!nonce || /[\s\x00-\x1f\x7f]/.test(nonce)))throw new Error("Invalid Fly lease nonce");
    const response=await this.fetcher.call(globalThis,`https://api.machines.dev/v1/apps/${path}`,{method,redirect:"manual",credentials:"omit",signal:this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs),headers:{authorization:this.authorization,accept:"application/json",...(body===undefined?{}:{"content-type":"application/json"}),...(nonce===undefined?{}:{"fly-machine-lease-nonce":nonce})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok){await response.body?.cancel();throw new FlyMachineError(response.status);}
    if(response.status===204)return null;
    const reader=response.body?.getReader();if(!reader)throw new Error("Invalid Fly response");
    const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>4_194_304)throw new Error("Fly response exceeds size limit");chunks.push(result.value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    if(!size)return null;
    try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new Error("Invalid Fly response");}
  }
  async app(app:string):Promise<{name:string;organization:{slug:string}}> {
    const result=await this.request(identifier(app)) as {name:string;organization:{slug:string}};
    if(!object(result) || result.name!==app || !object(result.organization) || typeof result.organization.slug!=="string")throw new Error("Fly app identity does not match the linked target");return result;
  }
  async machines(app:string):Promise<FlyMachine[]> {const result=await this.request(`${identifier(app)}/machines`);if(!Array.isArray(result))throw new Error("Invalid Fly machine inventory");return result.map(validateFlyMachine);}
  async machine(app:string,id:string):Promise<FlyMachine> {const result=validateFlyMachine(await this.request(`${identifier(app)}/machines/${identifier(id)}`));if(result.id!==id)throw new Error("Fly machine identity mismatch");return result;}
  async volumes(app:string):Promise<FlyVolume[]> {
    const result=await this.request(`${identifier(app)}/volumes`);
    if(!Array.isArray(result))throw new Error("Invalid Fly volume inventory");return result.map(validateFlyVolume);
  }
  /** Persist a reservation before dispatch. Volume names are not unique, and a
   * lost response must be reconciled by the caller rather than retried here. */
  async createVolume(app:string,options:FlyVolumeCreateOptions):Promise<FlyCreatedVolume> {
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(options.name) || !/^[a-z]{3}$/.test(options.region) || !Number.isSafeInteger(options.sizeGb) || options.sizeGb<1 || !object(options.compute) || !["shared","performance"].includes(options.compute.cpu_kind) || !Number.isSafeInteger(options.compute.cpus) || options.compute.cpus<1 || !Number.isSafeInteger(options.compute.memory_mb) || options.compute.memory_mb<1)throw new Error("Invalid Fly checkpoint volume request");
    const body={name:options.name,region:options.region,size_gb:options.sizeGb,compute:{cpu_kind:options.compute.cpu_kind,cpus:options.compute.cpus,memory_mb:options.compute.memory_mb},encrypted:true,machines_only:true,require_unique_zone:true};
    const result=validateFlyVolume(await this.request(`${identifier(app)}/volumes`,"POST",body));
    if(result.name!==options.name || result.region!==options.region || result.size_gb!==options.sizeGb || !result.encrypted || result.state!=="created" || result.attached_machine_id!==null)throw new Error("Fly created a different checkpoint volume");
    return result as FlyCreatedVolume;
  }
  /** Caller persists intent before dispatch. Never automatically retries creation. */
  async create(app:string,options:{name:string;region:string;config:FlyMachineConfig;skipLaunch?:true}):Promise<FlyMachine> {
    identifier(options.name);if(!/^[a-z]{3}$/.test(options.region))throw new Error("Invalid Fly machine region");
    immutableFlyImage(options.config.image);canonicalConfigJson(options.config);
    if(options.skipLaunch!==undefined && options.skipLaunch!==true)throw new Error("Invalid Fly machine launch setting");
    const {skipLaunch,...body}=options;
    const result=validateFlyMachine(await this.request(`${identifier(app)}/machines`,"POST",skipLaunch?{...body,skip_launch:true}:body));
    if(result.region!==options.region || (result as FlyMachine & {name?:string}).name!==options.name || !matchesFlyConfig(result.config,options.config))throw new Error("Fly created a different machine configuration");return result;
  }
  async lease(app:string,id:string):Promise<string> {
    const result=await this.request(`${identifier(app)}/machines/${identifier(id)}/lease`,"POST",{ttl:120,description:"Logtura configuration apply"}) as {data:{nonce:string}};
    if(!object(result) || !object(result.data) || typeof result.data.nonce!=="string" || !result.data.nonce || /[\s\x00-\x1f\x7f]/.test(result.data.nonce))throw new Error("Invalid Fly machine lease");return result.data.nonce;
  }
  async release(app:string,id:string,nonce:string):Promise<void> {await this.request(`${identifier(app)}/machines/${identifier(id)}/lease`,"DELETE",undefined,nonce);}
  async update(app:string,id:string,config:FlyMachineConfig,version:string,nonce:string):Promise<void> {identifier(version);await this.request(`${identifier(app)}/machines/${identifier(id)}`,"POST",{config,current_version:version},nonce);}
  async stop(app:string,id:string,nonce:string):Promise<void> {await this.request(`${identifier(app)}/machines/${identifier(id)}/stop`,"POST",{signal:"SIGTERM",timeout:"35s"},nonce);}
  async start(app:string,id:string,nonce:string):Promise<void> {await this.request(`${identifier(app)}/machines/${identifier(id)}/start`,"POST",{},nonce);}
  /** No force flag: callers must prove the saved machine is quiescent under a
   * provider lease and persist deletion intent before dispatch. */
  async destroy(app:string,id:string,nonce:string):Promise<void> {await this.request(`${identifier(app)}/machines/${identifier(id)}`,"DELETE",undefined,nonce);}
}
/** Intent must already be durable. A lost update response is recovered by reading
 * the complete planned configuration, never by blindly repeating a write. */
export async function applyFlyMachine(client:FlyMachinesClient,plan:FlyMachinePlan):Promise<void> {
  const nonce=await client.lease(plan.app,plan.machineId);let failure:unknown;
  try {
    const current=await client.machine(plan.app,plan.machineId);
    if(!matchesFlyConfig(current.config,plan.after)) {
      if(current.instance_id!==plan.version || !matchesFlyConfig(current.config,plan.before) || Object.keys(current.config).length!==Object.keys(plan.before).length)throw new Error("Fly machine changed after planning; retain apply state for recovery");
      await client.update(plan.app,plan.machineId,plan.after,current.instance_id,nonce);
    }
    const updated=await client.machine(plan.app,plan.machineId);
    if(!matchesFlyConfig(updated.config,plan.after))throw new Error("Fly did not install the planned configuration");
    if(["created","stopped","suspended"].includes(updated.state))await client.start(plan.app,plan.machineId,nonce);
  } catch(error){failure=error;throw error;}
  finally {try{await client.release(plan.app,plan.machineId,nonce);}catch(error){if(failure===undefined)throw error;}}
}
