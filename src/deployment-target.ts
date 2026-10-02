import { validateDeploymentTarget,type DeploymentTarget } from "@logtura/core";
import type { DeploymentRow } from "./db";
/** Read only known identity fields. Legacy self-deploy rows without an app
 * binding remain unresolved; deriving from a renamed display label is unsafe. */
export function exportDeploymentTarget(row:DeploymentRow):DeploymentTarget {
 let metadata:Record<string,unknown>={};try{const parsed=JSON.parse(row.metadata_json??"{}");if(parsed && typeof parsed==="object" && !Array.isArray(parsed))metadata=parsed;}catch{}
 const external=row.external_id?.match(/^fly:([a-z0-9][a-z0-9-]{0,62}):([a-f0-9]{1,32})$/);
 let fly:DeploymentTarget["fly"]=null;
 if(row.target_kind==="fly"){
  const app=external?.[1]??metadata.appName;
  if(typeof app==="string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(app) && (!external || metadata.appName===undefined || metadata.appName===app)){
   fly={appName:app};const machine=external?.[2]??metadata.machineId;
   if(typeof machine==="string" && /^[a-f0-9]{1,32}$/.test(machine))fly.machineId=machine;
   if(typeof metadata.region==="string" && /^[a-z]{3}$/.test(metadata.region))fly.region=metadata.region;
   if(typeof metadata.orgSlug==="string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(metadata.orgSlug))fly.orgSlug=metadata.orgSlug;
  }
 }
 return validateDeploymentTarget({kind:row.target_kind,managed:row.managed===1,imageDigest:row.image_digest,fly});
}
