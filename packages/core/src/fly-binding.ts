import {isInstanceId} from "./deployment-state";

/** Public physical identities only. Generated configuration and credentials stay
 * in the caller's private replacement journal, never in this receipt. */
export interface FlyBindingRequest {
 requestId:string;instanceId:string;expectedConfigurationVersion:number;expectedSequence:number;revision:string;
 appName:string;orgSlug:string;region:string;previousMachineId:string;expectedImageDigest:string|null;
 previousImageDigest:string;previousConfigDigest:string;machineId:string;imageDigest:string;
}
export interface FlyBindingReceipt {request:FlyBindingRequest;configurationVersion:number;}
const keys=["requestId","instanceId","expectedConfigurationVersion","expectedSequence","revision","appName","orgSlug","region","previousMachineId","expectedImageDigest","previousImageDigest","previousConfigDigest","machineId","imageDigest"];
const digest=(v:unknown):v is string=>typeof v==="string" && /^sha256:[a-f0-9]{64}$/.test(v);
const machine=(v:unknown):v is string=>typeof v==="string" && /^[a-f0-9]{1,32}$/.test(v);
export function validateFlyBindingRequest(value:unknown):FlyBindingRequest {
 const r=value as FlyBindingRequest;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==keys.length || Object.keys(r).some(k=>!keys.includes(k)) || !isInstanceId(r.requestId) || !isInstanceId(r.instanceId) || !Number.isSafeInteger(r.expectedConfigurationVersion) || r.expectedConfigurationVersion<0 || r.expectedConfigurationVersion>=Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(r.expectedSequence) || r.expectedSequence<1 || !digest(r.revision) || typeof r.appName!=="string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(r.appName) || typeof r.orgSlug!=="string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(r.orgSlug) || typeof r.region!=="string" || !/^[a-z]{3}$/.test(r.region) || !machine(r.previousMachineId) || !machine(r.machineId) || (r.expectedImageDigest!==null && !digest(r.expectedImageDigest)) || !digest(r.previousImageDigest) || !digest(r.previousConfigDigest) || !digest(r.imageDigest))throw new Error("Invalid Fly binding request");
 return structuredClone(r);
}
export function validateFlyBindingReceipt(value:unknown):FlyBindingReceipt {
 const r=value as FlyBindingReceipt;
 if(!r || typeof r!=="object" || Array.isArray(r) || Object.keys(r).length!==2 || Object.keys(r).some(k=>!["request","configurationVersion"].includes(k)))throw new Error("Invalid Fly binding receipt");
 const request=validateFlyBindingRequest(r.request);
 if(r.configurationVersion!==flyBindingConfigurationVersion(request))throw new Error("Invalid Fly binding receipt");
 return {request,configurationVersion:r.configurationVersion};
}
/** A physical identity change advances the graph clock; an image-only update
 * retains the same graph and still has an immutable instance-fenced receipt. */
export function flyBindingConfigurationVersion(request:FlyBindingRequest):number{return request.expectedConfigurationVersion+(request.machineId===request.previousMachineId?0:1);}
