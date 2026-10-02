import { type FlyMachinesClient, type FlyVolume, type FlyVolumeCreateOptions } from "@logtura/core";
import { commitConfiguration, readConfigurationVersion } from "./config-version";
import type { Env } from "./env";

export interface ManagedCheckpoint {
 id:string;deploymentId:string;userId:string;app:string;org:string;
 configurationVersion:number;phase:"prepared"|"dispatched"|"ready"|"obsolete";
 volumeId:string|null;options:FlyVolumeCreateOptions;
}
interface Row {
 id:string;deployment_id:string;user_id:string;app_name:string;org_slug:string;region:string;
 configuration_version:number;volume_name:string;size_gb:number;cpu_kind:"shared"|"performance";
 cpus:number;memory_mb:number;phase:ManagedCheckpoint["phase"];volume_id:string|null;
}
function volumeName(id:string):string {return `lt_${id.replaceAll("-","").slice(0,24)}`;}
function decode(row:Row):ManagedCheckpoint {
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.id) || row.volume_name!==volumeName(row.id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.app_name) || !/^[a-z0-9-]{1,63}$/.test(row.org_slug) || !/^[a-z]{3}$/.test(row.region) || !Number.isSafeInteger(row.configuration_version) || row.configuration_version<0 || !["shared","performance"].includes(row.cpu_kind) || [row.size_gb,row.cpus,row.memory_mb].some(value=>!Number.isSafeInteger(value) || value<1) || (row.volume_id!==null && !/^vol_[a-z0-9]+$/.test(row.volume_id)) || (row.phase==="ready" && row.volume_id===null))throw new Error("Invalid managed checkpoint reservation; retain it for recovery");
 return {id:row.id,deploymentId:row.deployment_id,userId:row.user_id,app:row.app_name,org:row.org_slug,configurationVersion:row.configuration_version,phase:row.phase,volumeId:row.volume_id,options:{name:row.volume_name,region:row.region,sizeGb:row.size_gb,compute:{cpu_kind:row.cpu_kind,cpus:row.cpus,memory_mb:row.memory_mb}}};
}
/** Identity-only private state: credentials and generated runtime bytes do not
 * belong here. Deployment ownership is rechecked on every lookup. */
export async function readManagedCheckpoint(env:Env,userId:string,deploymentId:string,id?:string):Promise<ManagedCheckpoint|null> {
 const row=await env.DB.prepare(`SELECT c.* FROM managed_checkpoints c JOIN deployments d ON d.id=c.deployment_id AND d.user_id=c.user_id
  WHERE c.deployment_id=? AND c.user_id=? AND ${id===undefined?"c.phase IN ('prepared','dispatched','ready')":"c.id=?"}`)
  .bind(deploymentId,userId,...(id===undefined?[]:[id])).first<Row>();
 return row?decode(row):null;
}
/** New storage reservations capture the machine's intended compute envelope.
 * A ready reservation is reusable across later configuration revisions; its
 * stable provider identity, target and placement never change. */
export async function prepareManagedCheckpoint(env:Env,input:{userId:string;deploymentId:string;app:string;org:string;region:string;configurationVersion:number}):Promise<ManagedCheckpoint> {
 const prior=await readManagedCheckpoint(env,input.userId,input.deploymentId);
 if(prior){sameTarget(prior,input);return prior;}
 const id=crypto.randomUUID(),now=Date.now();
 const row:Row={id,deployment_id:input.deploymentId,user_id:input.userId,app_name:input.app,org_slug:input.org,region:input.region,configuration_version:input.configurationVersion,volume_name:volumeName(id),size_gb:1,cpu_kind:"shared",cpus:2,memory_mb:4096,phase:"prepared",volume_id:null};
 decode(row);
 try {
  const result=await commitConfiguration(env.DB,input.userId,input.configurationVersion,[env.DB.prepare(`INSERT INTO managed_checkpoints(id,deployment_id,user_id,app_name,org_slug,region,configuration_version,volume_name,size_gb,cpu_kind,cpus,memory_mb,phase,created_at,updated_at)
   SELECT ?,id,user_id,?,?,?,?,?,1,'shared',2,4096,'prepared',?,? FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'`)
   .bind(id,input.app,input.org,input.region,input.configurationVersion,row.volume_name,now,now,input.deploymentId,input.userId)]);
  if(result.results[0]!.meta.changes!==1)throw new Error("Managed deployment not found");
 } catch(error) {const recovered=await readManagedCheckpoint(env,input.userId,input.deploymentId);if(recovered){sameTarget(recovered,input);return recovered;}throw error;}
 return (await readManagedCheckpoint(env,input.userId,input.deploymentId,id))!;
}
function sameTarget(reservation:ManagedCheckpoint,input:{app:string;org:string;region:string}):void {
 if(reservation.app!==input.app || reservation.org!==input.org || reservation.options.region!==input.region)throw new Error("Managed checkpoint target changed; retain reservation for recovery");
}
async function current(env:Env,reservation:ManagedCheckpoint,signal:AbortSignal):Promise<void> {
 signal.throwIfAborted();
 if(!await env.DB.prepare("SELECT id FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'").bind(reservation.deploymentId,reservation.userId).first())throw new Error("Managed checkpoint no longer owned; retain reservation for recovery");
 if(reservation.phase!=="ready" && await readConfigurationVersion(env.DB,reservation.userId)!==reservation.configurationVersion)throw new Error("Managed configuration changed; retain checkpoint reservation for recovery");
}
function matchesVolume(volume:FlyVolume,reservation:ManagedCheckpoint,stable:boolean):boolean {
 return volume.name===reservation.options.name && volume.region===reservation.options.region && volume.encrypted && volume.state==="created" && typeof volume.size_gb==="number" && (stable?volume.size_gb>=reservation.options.sizeGb:volume.size_gb===reservation.options.sizeGb) && (stable || volume.attached_machine_id===null);
}
/** Durable dispatch marker precedes the one provider POST. Unknown outcomes are
 * observed without repeat creation. Ready references do not imply availability:
 * the machine planner must separately validate attachment and mount ownership. */
export async function executeManagedCheckpoint(env:Env,reservation:ManagedCheckpoint,client:FlyMachinesClient,signal:AbortSignal):Promise<FlyVolume> {
 const token=crypto.randomUUID(),now=Date.now();
 const claimed=await env.DB.prepare(`UPDATE managed_checkpoints SET lease_token=?,lease_until=?,updated_at=?
  WHERE id=? AND user_id=? AND phase IN ('prepared','dispatched','ready') AND (lease_until IS NULL OR lease_until<=?) RETURNING id`)
  .bind(token,now+60_000,now,reservation.id,reservation.userId,now).first();
 if(!claimed)throw new Error("Managed checkpoint is busy or terminal; retry recovery");
 try {
  const stored=await readManagedCheckpoint(env,reservation.userId,reservation.deploymentId,reservation.id);
  if(!stored)throw new Error("Managed checkpoint no longer owned; retain reservation for recovery");reservation=stored;
  await current(env,reservation,signal);
  if((await client.app(reservation.app)).organization.slug!==reservation.org)throw new Error("Managed Fly organization does not match the checkpoint reservation");
  const inventory=await client.volumes(reservation.app);
  const candidates=inventory.filter(volume=>reservation.volumeId===null?volume.name===reservation.options.name:volume.id===reservation.volumeId);
  if(candidates.length>1)throw new Error("Managed checkpoint observation is ambiguous; retain reservation for recovery");
  let volume:FlyVolume;
  if(reservation.phase==="ready") {
   if(candidates.length!==1 || !matchesVolume(candidates[0]!,reservation,true))throw new Error("Managed checkpoint differs from its saved identity; retain reservation for recovery");
   await current(env,reservation,signal);
   const confirmed=await env.DB.prepare("UPDATE managed_checkpoints SET updated_at=? WHERE id=? AND lease_token=? AND lease_until>? AND phase='ready' AND volume_id=? AND EXISTS (SELECT 1 FROM deployments d WHERE d.id=managed_checkpoints.deployment_id AND d.user_id=managed_checkpoints.user_id AND d.managed=1 AND d.target_kind='fly') RETURNING id")
    .bind(Date.now(),reservation.id,token,Date.now(),reservation.volumeId).first();
   if(!confirmed)throw new Error("Managed checkpoint lease expired; retain reservation for recovery");return candidates[0]!;
  }
  if(candidates.length) {
   if(reservation.phase!=="dispatched" || !matchesVolume(candidates[0]!,reservation,false))throw new Error("Managed volume does not match the dispatched reservation");
   volume=candidates[0]!;
  } else {
   if(reservation.phase!=="prepared")throw new Error("Managed checkpoint create outcome is unknown; retain reservation for recovery");
   await current(env,reservation,signal);
   const marked=await commitConfiguration(env.DB,reservation.userId,reservation.configurationVersion,[env.DB.prepare(`UPDATE managed_checkpoints SET phase='dispatched',updated_at=? WHERE id=? AND lease_token=? AND lease_until>? AND phase='prepared'`)
    .bind(Date.now(),reservation.id,token,Date.now())]);
   if(marked.results[0]!.meta.changes!==1)throw new Error("Managed checkpoint lease expired; retain reservation for recovery");
   signal.throwIfAborted();volume=await client.createVolume(reservation.app,reservation.options);
  }
  await current(env,reservation,signal);
  const saved=await commitConfiguration(env.DB,reservation.userId,reservation.configurationVersion,[env.DB.prepare(`UPDATE managed_checkpoints SET phase='ready',volume_id=?,updated_at=? WHERE id=? AND lease_token=? AND lease_until>? AND phase='dispatched' AND volume_id IS NULL`)
   .bind(volume.id,Date.now(),reservation.id,token,Date.now())]);
  if(saved.results[0]!.meta.changes!==1)throw new Error("Managed checkpoint lease expired; retain reservation for recovery");return volume;
 } finally {await env.DB.prepare("UPDATE managed_checkpoints SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(reservation.id,token).run();}
}
