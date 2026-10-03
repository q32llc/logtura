import {canonicalConfigJson,executeFlyReplacementCleanup,isInstanceId,planFlyReplacementCleanup,validateFlyReplacementCleanupState,validateFlyReplacementState,type FlyMachinesClient,type FlyReplacementState,type FlyReplacementCleanupState} from "@logtura/core";
import {decryptSecret,encryptSecret} from "./crypto";
import {commitConfiguration,readConfigurationVersion} from "./config-version";
import {readDeploymentConfiguration} from "./deployment-configuration";
import {readManagedInstall,type ManagedInstall} from "./managed-installations";
import {readManagedRollback} from "./managed-rollbacks";
import type {Env} from "./env";
interface Row {id:string;deployment_id:string;user_id:string;replacement_id:string;installation_id:string;rollback_id:string|null;app_name:string;survivor_id:string;retired_id:string;instance_id:string|null;external_id:string;payload_encrypted:ArrayBuffer|number[];phase:FlyReplacementCleanupState["phase"];status:"pending"|"completed";fence_version:number;fence_sequence:number;fence_revision:string;}
export interface ManagedCleanup {id:string;userId:string;deploymentId:string;replacementId:string;installationId:string;rollbackId:string|null;instanceId:string|null;externalId:string;configurationVersion:number;sequence:number;revision:string;status:"pending"|"completed";state:FlyReplacementCleanupState;}
export class ManagedCleanupError extends Error {constructor(public readonly code:string){super(code);}}
function fail(code:string):never{throw new ManagedCleanupError(code);}
/** Internal only: encrypted complete machine payloads never enter API/job output. */
export async function readManagedCleanup(env:Env,userId:string,deploymentId:string,id?:string):Promise<ManagedCleanup|null>{
 const row=await env.DB.prepare(`SELECT c.* FROM managed_cleanups c JOIN deployments d ON d.id=c.deployment_id AND d.user_id=c.user_id WHERE c.user_id=? AND c.deployment_id=? ${id===undefined?"ORDER BY c.created_at DESC,c.id DESC LIMIT 1":"AND c.id=?"}`)
  .bind(userId,deploymentId,...(id===undefined?[]:[id])).first<Row>();if(!row)return null;
 try{
  const bytes=Array.isArray(row.payload_encrypted)?Uint8Array.from(row.payload_encrypted):new Uint8Array(row.payload_encrypted);if(bytes.byteLength>1_900_028)throw new Error();
  const payload=validateFlyReplacementCleanupState(JSON.parse(await decryptSecret(bytes,env.CREDENTIAL_ENCRYPTION_KEY)) as FlyReplacementCleanupState);
  const state=validateFlyReplacementCleanupState({...payload,phase:row.phase}),plan=state.plan;
  if(payload.phase!=="prepared" || !isInstanceId(row.id) || plan.replacement.plan.id!==row.replacement_id || plan.replacement.plan.app!==row.app_name || plan.survivor.id!==row.survivor_id || plan.retired.id!==row.retired_id || row.external_id!==`fly:${row.app_name}:${row.survivor_id}` || !Number.isSafeInteger(row.fence_version) || row.fence_version<0 || !Number.isSafeInteger(row.fence_sequence) || row.fence_sequence<1 || !/^sha256:[a-f0-9]{64}$/.test(row.fence_revision) || row.status==="completed" && row.phase!=="deleted" || (row.rollback_id===null)!==(plan.replacement.phase==="installed") || (row.instance_id===null)!==(row.rollback_id!==null) || row.instance_id!==null && !isInstanceId(row.instance_id))throw new Error();
  return {id:row.id,userId:row.user_id,deploymentId:row.deployment_id,replacementId:row.replacement_id,installationId:row.installation_id,rollbackId:row.rollback_id,instanceId:row.instance_id,externalId:row.external_id,configurationVersion:row.fence_version,sequence:row.fence_sequence,revision:row.fence_revision,status:row.status,state};
 }catch{fail("invalid_encrypted_cleanup");}
}
const sqlFence=`EXISTS (SELECT 1 FROM deployments d JOIN deployment_configuration_state s ON s.deployment_id=d.id JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
 WHERE d.id=managed_cleanups.deployment_id AND d.user_id=managed_cleanups.user_id AND d.managed=1 AND d.target_kind='fly' AND d.external_id=managed_cleanups.external_id
 AND s.active_instance_id IS managed_cleanups.instance_id AND s.desired_sequence=managed_cleanups.fence_sequence AND r.revision=managed_cleanups.fence_revision
 AND (managed_cleanups.instance_id IS NULL OR (s.last_report_sequence>0 AND s.applied_sequence=managed_cleanups.fence_sequence)))`;
function replacement(original:ManagedInstall,current:ManagedInstall):FlyReplacementState{
 const mounts=current.payload.after.mounts;if(original.payload.schemaVersion!==3 || !original.payload.before || !original.payload.rollback || !Array.isArray(mounts) || mounts.length!==1 || typeof mounts[0]?.volume!=="string")fail("cleanup_not_available");
 return validateFlyReplacementState({plan:{schemaVersion:1,id:original.id,app:original.app,org:original.org,name:original.payload.name,before:original.payload.before,rollback:original.payload.rollback,after:current.payload.after,volume:mounts[0].volume},phase:"installed",machineId:original.machineId});
}
async function fence(env:Env,cleanup:ManagedCleanup,signal:AbortSignal){
 signal.throwIfAborted();const state=await readDeploymentConfiguration(env.DB,cleanup.userId,cleanup.deploymentId),deployment=await env.DB.prepare("SELECT external_id FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'").bind(cleanup.deploymentId,cleanup.userId).first<{external_id:string|null}>();
 if(!state || !deployment || deployment.external_id!==cleanup.externalId || state.activeInstanceId!==cleanup.instanceId || state.desired.sequence!==cleanup.sequence || state.desired.revision!==cleanup.revision || cleanup.instanceId!==null && (state.lastReportSequence<1 || state.applied?.sequence!==cleanup.sequence || state.applied.revision!==cleanup.revision))fail("cleanup_fence_changed");
 return state;
}
/** Explicit owner review captures provider snapshots before immutable reservation.
 * Rebase changes only the account fence, never the machine plan or issuance. */
export async function prepareManagedCleanup(env:Env,input:{userId:string;deploymentId:string;replacementId:string;configurationVersion:number;client:FlyMachinesClient;signal:AbortSignal}):Promise<ManagedCleanup>{
 const {userId,deploymentId,replacementId,configurationVersion,client,signal}=input;
 if(!Number.isSafeInteger(configurationVersion) || configurationVersion<0)fail("invalid_configuration_version");signal.throwIfAborted();
 const priorRow=await env.DB.prepare("SELECT id FROM managed_cleanups WHERE user_id=? AND deployment_id=? AND replacement_id=?").bind(userId,deploymentId,replacementId).first<{id:string}>(),prior=priorRow?await readManagedCleanup(env,userId,deploymentId,priorRow.id):null;
 if(prior){
  if(prior.status==="completed")return prior;
  await fence(env,prior,signal);
  const result=await commitConfiguration(env.DB,userId,configurationVersion,[env.DB.prepare(`UPDATE managed_cleanups SET fence_version=?,updated_at=? WHERE id=? AND status='pending' AND (lease_until IS NULL OR lease_until<=?) AND ${sqlFence}`).bind(configurationVersion,Date.now(),prior.id,Date.now())]);
  if(result.results[0]!.meta.changes!==1)fail("cleanup_busy");return (await readManagedCleanup(env,userId,deploymentId,prior.id))!;
 }
 const state=await readDeploymentConfiguration(env.DB,userId,deploymentId),original=await readManagedInstall(env,userId,deploymentId,replacementId);if(!state || !original || original.payload.schemaVersion!==3)fail("cleanup_not_available");
 const rollback=await readManagedRollback(env,userId,deploymentId);
 let saved:FlyReplacementState,installationId:string,rollbackId:string|null=null;
 if(rollback?.replacementId===original.id && rollback.status==="completed"){
  saved=rollback.state;installationId=rollback.installationId;rollbackId=rollback.id;
 }else{
  if(original.phase!=="completed" || original.replacementPhase!=="installed" || state.activeInstanceId===null || state.lastReportSequence<1 || state.applied?.sequence!==state.desired.sequence || state.applied.revision!==state.desired.revision)fail("cleanup_not_available");
  const rows=await env.DB.prepare("SELECT id FROM managed_installations WHERE user_id=? AND deployment_id=? AND phase='completed' ORDER BY created_at DESC,id DESC LIMIT 32").bind(userId,deploymentId).all<{id:string}>();let current:ManagedInstall|undefined;
  for(const row of rows.results){const install=await readManagedInstall(env,userId,deploymentId,row.id);if(install?.runtime?.instance.instanceId===state.activeInstanceId){current=install;break;}}
  if(!current || current.machineId!==original.machineId || current.app!==original.app || current.org!==original.org || current.region!==original.region)fail("cleanup_instance_changed");saved=replacement(original,current);installationId=current.id;
 }
 if((await client.app(saved.plan.app)).organization.slug!==saved.plan.org)fail("cleanup_target_changed");signal.throwIfAborted();
 const plan=planFlyReplacementCleanup({replacement:saved,machines:await client.machines(saved.plan.app)}),privateState:FlyReplacementCleanupState={plan,phase:"prepared"},externalId=`fly:${saved.plan.app}:${plan.survivor.id}`;
 const id=crypto.randomUUID(),now=Date.now(),text=canonicalConfigJson(privateState);if(new TextEncoder().encode(text).length>1_900_000)fail("cleanup_too_large");
 const encrypted=await encryptSecret(text,env.CREDENTIAL_ENCRYPTION_KEY);
 await commitConfiguration(env.DB,userId,configurationVersion,[env.DB.prepare(`INSERT INTO managed_cleanups(id,deployment_id,user_id,replacement_id,installation_id,rollback_id,app_name,survivor_id,retired_id,instance_id,external_id,payload_encrypted,phase,status,fence_version,fence_sequence,fence_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'prepared','pending',?,?,?,?,?)`)
  .bind(id,deploymentId,userId,replacementId,installationId,rollbackId,saved.plan.app,plan.survivor.id,plan.retired.id,state.activeInstanceId,externalId,encrypted,configurationVersion,state.desired.sequence,state.desired.revision,now,now)]);
 return (await readManagedCleanup(env,userId,deploymentId,id))!;
}
/** Same public operation under a durable D1 claim. No plan/secret enters results. */
export async function executeManagedCleanup(env:Env,cleanup:ManagedCleanup,client:FlyMachinesClient,signal:AbortSignal):Promise<{survivorId:string;retiredId:string}>{
 const authoritative=await readManagedCleanup(env,cleanup.userId,cleanup.deploymentId,cleanup.id);if(!authoritative)fail("cleanup_not_found");cleanup=authoritative;
 const token=crypto.randomUUID(),now=Date.now();
 if(!await env.DB.prepare("UPDATE managed_cleanups SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND user_id=? AND (lease_until IS NULL OR lease_until<=?) RETURNING id").bind(token,now+60000,now,cleanup.id,cleanup.userId,now).first())fail("cleanup_busy");
 try{
  const read=async()=>{
   signal.throwIfAborted();if(!await env.DB.prepare("SELECT id FROM managed_cleanups WHERE id=? AND user_id=? AND lease_token=? AND lease_until>?").bind(cleanup.id,cleanup.userId,token,Date.now()).first())fail("cleanup_lease_expired");
   const saved=await readManagedCleanup(env,cleanup.userId,cleanup.deploymentId,cleanup.id);if(!saved)fail("cleanup_not_found");await fence(env,saved,signal);
   if(await readConfigurationVersion(env.DB,saved.userId)!==saved.configurationVersion)fail("cleanup_fence_changed");cleanup=saved;return saved.state;
  };
  await executeFlyReplacementCleanup({runExclusive:async operation=>operation({read,compareAndSwap:async(expected,next)=>{
   await read();const result=await commitConfiguration(env.DB,cleanup.userId,cleanup.configurationVersion,[env.DB.prepare(`UPDATE managed_cleanups SET phase=?,updated_at=? WHERE id=? AND user_id=? AND status='pending' AND phase=? AND lease_token=? AND lease_until>? AND ${sqlFence}`).bind(next.phase,Date.now(),cleanup.id,cleanup.userId,expected.phase,token,Date.now())]);return result.results[0]!.meta.changes===1;
  }})},client,{assertCurrent:async()=>{await read();}});
  await read();if(cleanup.status==="pending"){
   const guard=crypto.randomUUID();await commitConfiguration(env.DB,cleanup.userId,cleanup.configurationVersion,[
    env.DB.prepare("UPDATE managed_cleanups SET status='completed',updated_at=? WHERE id=? AND status='pending' AND phase='deleted' AND lease_token=? AND lease_until>?").bind(Date.now(),cleanup.id,token,Date.now()),
    env.DB.prepare("UPDATE managed_installations SET phase='obsolete',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND user_id=? AND deployment_id=?").bind(Date.now(),cleanup.replacementId,cleanup.userId,cleanup.deploymentId),
    env.DB.prepare(`INSERT INTO configuration_write_guards(id,user_id,expected_version) SELECT ?,?,CASE WHEN EXISTS
     (SELECT 1 FROM managed_cleanups c JOIN deployments d ON d.id=c.deployment_id JOIN deployment_configuration_state s ON s.deployment_id=d.id JOIN deployment_configuration_revisions r ON r.deployment_id=d.id AND r.sequence=s.desired_sequence
      WHERE c.id=? AND c.user_id=? AND c.status='completed' AND c.phase='deleted' AND c.lease_token=? AND c.lease_until>? AND d.user_id=c.user_id AND d.managed=1 AND d.target_kind='fly' AND d.external_id=c.external_id
      AND s.active_instance_id IS c.instance_id AND s.desired_sequence=c.fence_sequence AND r.revision=c.fence_revision
      AND (c.instance_id IS NULL OR (s.applied_sequence=c.fence_sequence AND s.last_report_sequence>0)))
     THEN (SELECT version FROM configuration_versions WHERE user_id=?) ELSE -1 END`)
     .bind(guard,cleanup.userId,cleanup.id,cleanup.userId,token,Date.now(),cleanup.userId),
    env.DB.prepare("DELETE FROM configuration_write_guards WHERE id=?").bind(guard),
   ]);
  }
  return {survivorId:cleanup.state.plan.survivor.id,retiredId:cleanup.state.plan.retired.id};
 }finally{await env.DB.prepare("UPDATE managed_cleanups SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(cleanup.id,token).run();}
}
