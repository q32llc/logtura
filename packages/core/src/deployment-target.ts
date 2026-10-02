/** Public deployment target identity. Never includes provider credentials. */
export interface DeploymentTarget {
 kind:string;managed:boolean;imageDigest:string|null;
 fly:{appName:string;machineId?:string;region?:string;orgSlug?:string}|null;
}
export function validateDeploymentTarget(value:unknown):DeploymentTarget {
 const target=value as DeploymentTarget;
 if(!target || typeof target!=="object" || Array.isArray(target) || Object.keys(target).some(k=>!["kind","managed","imageDigest","fly"].includes(k)) || typeof target.kind!=="string" || !/^[a-z][a-z0-9-]{0,63}$/.test(target.kind) || typeof target.managed!=="boolean" || (target.imageDigest!==null && (typeof target.imageDigest!=="string" || !/^sha256:[a-f0-9]{64}$/.test(target.imageDigest))))throw new Error("Invalid deployment target");
 if(target.fly!==null){const fly=target.fly;
  if(target.kind!=="fly" || !fly || typeof fly!=="object" || Array.isArray(fly) || Object.keys(fly).some(k=>!["appName","machineId","region","orgSlug"].includes(k)) || typeof fly.appName!=="string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(fly.appName) || (fly.machineId!==undefined && (typeof fly.machineId!=="string" || !/^[a-f0-9]{1,32}$/.test(fly.machineId))) || (fly.region!==undefined && (typeof fly.region!=="string" || !/^[a-z]{3}$/.test(fly.region))) || (fly.orgSlug!==undefined && (typeof fly.orgSlug!=="string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(fly.orgSlug))))throw new Error("Invalid deployment target");
 }
 return structuredClone(target);
}
