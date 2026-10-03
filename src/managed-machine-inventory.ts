import {canonicalConfigJson,type FlyMachine} from "@logtura/core";
import {readManagedInstall,type ManagedInstall} from "./managed-installations";
import type {Env} from "./env";

/** Only the deployment's journal can authorize a retained quiescent rollback VM.
 * A familiar name/prefix/metadata is never enough to ignore foreign inventory. */
export async function selectManagedForwarder(env:Env,userId:string,deploymentId:string,app:string,machines:FlyMachine[]):Promise<FlyMachine|null>{
 const deployment=await env.DB.prepare("SELECT external_id FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'")
  .bind(deploymentId,userId).first<{external_id:string|null}>();
 if(!deployment)throw new Error("Managed deployment no longer owned");
 const rows=await env.DB.prepare("SELECT id FROM managed_installations WHERE deployment_id=? AND user_id=? AND phase='completed' AND replacement_phase='installed' ORDER BY created_at DESC LIMIT 2")
  .bind(deploymentId,userId).all<{id:string}>();
 if(rows.results.length>1)throw new Error("Managed rollback inventory is ambiguous; retain journals for recovery");
 const replacement=rows.results[0]?await readManagedInstall(env,userId,deploymentId,rows.results[0].id):null;
 const retained=replacement?.payload.before;
 let inventory=machines;
 if(retained){
  const rollback=machines.filter(machine=>machine.id===retained.id);
  if(rollback.length!==1 || !["created","stopped"].includes(rollback[0]!.state) || rollback[0]!.region!==retained.region || rollback[0]!.image_ref.digest!==retained.image_ref.digest || canonicalConfigJson(rollback[0]!.config)!==canonicalConfigJson(retained.config))throw new Error("Managed retained rollback machine changed; retain installation for recovery");
  inventory=machines.filter(machine=>machine.id!==retained.id);
 }
 if(inventory.length>1)throw new Error("Managed apply requires one owned forwarder machine");
 const machine=inventory[0];
 if(!machine){if(deployment.external_id || replacement)throw new Error("Managed bound forwarder is missing; retain installation for recovery");return null;}
 const binding=`fly:${app}:${machine.id}`;
 if(deployment.external_id && deployment.external_id!==binding)throw new Error("Managed forwarder physical binding changed");
 if(replacement){
  if(replacement.app!==app || (machine as FlyMachine & {name?:string}).name!==replacement.payload.name || machine.id!==replacement.machineId || (machine.config.metadata as Record<string,unknown>)?.["logtura.replacement"]!==replacement.id)throw new Error("Managed replacement identity differs from its journal");
 }else if((machine as FlyMachine & {name?:string}).name!=="forwarder")throw new Error("Managed apply requires one owned forwarder machine");
 return machine;
}


/** An accepted candidate report cannot excuse a concurrently running old VM. */
export function assertManagedReplacementStandby(install:ManagedInstall,machines:FlyMachine[]):void {
 if(install.payload.schemaVersion!==3)return;
 const before=install.payload.before!,old=machines.filter(machine=>machine.id===before.id);
 if(old.length!==1 || !["created","stopped"].includes(old[0]!.state) || old[0]!.region!==before.region || old[0]!.image_ref.digest!==before.image_ref.digest || canonicalConfigJson(old[0]!.config)!==canonicalConfigJson(before.config))throw new Error("Managed retained rollback machine changed; retain installation for recovery");
 if(machines.length!==2 || !machines.some(machine=>machine.id===install.machineId))throw new Error("Managed replacement inventory differs from its journal");
}
