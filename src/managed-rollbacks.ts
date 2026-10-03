import {canonicalConfigJson,executeFlyReplacement,isInstanceId,validateFlyReplacementState,type FlyMachinesClient,type FlyReplacementState} from "@logtura/core";
import {decryptSecret,encryptSecret} from "./crypto";
import {commitConfiguration,readConfigurationVersion} from "./config-version";
import {readDeploymentConfiguration} from "./deployment-configuration";
import {readManagedInstall,type ManagedInstall} from "./managed-installations";
import type {Env} from "./env";

interface Payload {schemaVersion:1;state:FlyReplacementState;instanceId:string;externalId:string|null;}
interface Row {id:string;deployment_id:string;user_id:string;replacement_id:string;installation_id:string;instance_id:string;external_id:string|null;payload_encrypted:ArrayBuffer|number[];phase:FlyReplacementState["phase"];machine_id:string|null;status:"pending"|"completed";fence_version:number;fence_sequence:number;fence_revision:string;}
export interface ManagedRollback {id:string;deploymentId:string;userId:string;replacementId:string;installationId:string;status:"pending"|"completed";configurationVersion:number;sequence:number;revision:string;payload:Payload;state:FlyReplacementState;}
export class ManagedRollbackError extends Error {constructor(public readonly code:string){super(code);}}
function fail(code:string):never{throw new ManagedRollbackError(code);}
function envelope(bytes:ArrayBuffer|number[]):Uint8Array{return Array.isArray(bytes)?Uint8Array.from(bytes):new Uint8Array(bytes);}
/** Internal private lookup. No decrypted config or environment belongs in API/job output. */
export async function readManagedRollback(env:Env,userId:string,deploymentId:string,id?:string):Promise<ManagedRollback|null>{
 const row=await env.DB.prepare(`SELECT b.* FROM managed_rollbacks b JOIN deployments d ON d.id=b.deployment_id AND d.user_id=b.user_id
 WHERE b.user_id=? AND b.deployment_id=? ${id===undefined?"ORDER BY b.created_at DESC LIMIT 1":"AND b.id=?"}`)
 .bind(userId,deploymentId,...(id===undefined?[]:[id])).first<Row>();
 if(!row)return null;
 try{
  const bytes=envelope(row.payload_encrypted);if(bytes.byteLength>1_900_028)throw new Error();
  const payload=JSON.parse(await decryptSecret(bytes,env.CREDENTIAL_ENCRYPTION_KEY)) as Payload;
  if(!payload || Object.keys(payload).length!==4 || payload.schemaVersion!==1 || !isInstanceId(payload.instanceId) || !isInstanceId(row.id) || (payload.externalId!==null && typeof payload.externalId!=="string"))throw new Error();
  validateFlyReplacementState(payload.state);
  const state=validateFlyReplacementState({...payload.state,phase:row.phase,machineId:row.machine_id});
  if(state.plan.id!==row.replacement_id || payload.instanceId!==row.instance_id || payload.externalId!==row.external_id || !Number.isSafeInteger(row.fence_version) || row.fence_version<0 || !Number.isSafeInteger(row.fence_sequence) || row.fence_sequence<1 || !/^sha256:[a-f0-9]{64}$/.test(row.fence_revision) || row.status==="completed" && row.phase!=="rolled_back")throw new Error();
  return {id:row.id,deploymentId:row.deployment_id,userId:row.user_id,replacementId:row.replacement_id,installationId:row.installation_id,status:row.status,configurationVersion:row.fence_version,sequence:row.fence_sequence,revision:row.fence_revision,payload,state};
 }catch{fail("invalid_encrypted_rollback");}
}
function replacementState(original:ManagedInstall,current:ManagedInstall):FlyReplacementState{
 const before=original.payload.before,rollback=original.payload.rollback,mounts=current.payload.after.mounts;
 if(original.payload.schemaVersion!==3 || !before || !rollback || !original.replacementPhase || !Array.isArray(mounts) || mounts.length!==1 || typeof mounts[0]?.volume!=="string")fail("rollback_not_available");
 return validateFlyReplacementState({plan:{schemaVersion:1,id:original.id,app:original.app,org:original.org,name:original.payload.name,before,rollback,after:current.payload.after,volume:mounts[0].volume},phase:original.replacementPhase,machineId:original.machineId});
}
/** Explicit owner decision. Fence reports before any provider write. Repeating
 * with a new current graph version rebases only fences, never private inputs. */
export async function prepareManagedRollback(env:Env,input:{userId:string;deploymentId:string;replacementId:string;configurationVersion:number}):Promise<ManagedRollback>{
 const {userId,deploymentId,replacementId,configurationVersion}=input;
 if(!Number.isSafeInteger(configurationVersion) || configurationVersion<0)fail("invalid_configuration_version");
 const state=await readDeploymentConfiguration(env.DB,userId,deploymentId);
 const deployment=await env.DB.prepare("SELECT external_id FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'").bind(deploymentId,userId).first<{external_id:string|null}>();
 if(!state || !deployment)fail("rollback_not_found");
 const priorRow=await env.DB.prepare("SELECT id FROM managed_rollbacks WHERE replacement_id=? AND deployment_id=? AND user_id=?").bind(replacementId,deploymentId,userId).first<{id:string}>();
 const prior=priorRow?await readManagedRollback(env,userId,deploymentId,priorRow.id):null;
 if(prior){
  if(prior.status==="completed")return prior;
  if(state.activeInstanceId!==null || deployment.external_id!==prior.payload.externalId)fail("rollback_target_changed");
  const changed=await commitConfiguration(env.DB,userId,configurationVersion,[env.DB.prepare(`UPDATE managed_rollbacks SET fence_version=?,fence_sequence=?,fence_revision=?,updated_at=? WHERE id=? AND status='pending' AND (lease_until IS NULL OR lease_until<=?)
   AND EXISTS (SELECT 1 FROM deployment_configuration_state s JOIN deployment_configuration_revisions r ON r.deployment_id=s.deployment_id AND r.sequence=s.desired_sequence WHERE s.deployment_id=? AND s.active_instance_id IS NULL AND s.desired_sequence=? AND r.revision=?)`)
   .bind(configurationVersion,state.desired.sequence,state.desired.revision,Date.now(),prior.id,Date.now(),deploymentId,state.desired.sequence,state.desired.revision)]);
  if(changed.results[0]!.meta.changes!==1)fail("rollback_busy");return (await readManagedRollback(env,userId,deploymentId,prior.id))!;
 }
 const original=await readManagedInstall(env,userId,deploymentId,replacementId);
 if(!original || original.phase==="obsolete" || original.replacementPhase==="prepared")fail("rollback_not_available");
 const rows=await env.DB.prepare("SELECT id FROM managed_installations WHERE deployment_id=? AND user_id=? AND phase IN ('dispatched','installed','completed') ORDER BY created_at DESC,id DESC LIMIT 32").bind(deploymentId,userId).all<{id:string}>();
 let installed:ManagedInstall|undefined;
 for(const row of rows.results){const candidate=await readManagedInstall(env,userId,deploymentId,row.id);if(candidate?.runtime?.instance.instanceId===state.activeInstanceId){installed=candidate;break;}}
 if(!installed?.runtime || installed.app!==original.app || installed.org!==original.org || installed.region!==original.region || installed.id!==original.id && (installed.machineId!==original.machineId || !["installed","completed"].includes(installed.phase)))fail("rollback_instance_changed");
 const saved=replacementState(original,installed);
 if(deployment.external_id!==null && ![`fly:${original.app}:${original.payload.before!.id}`,`fly:${original.app}:${original.machineId}`].includes(deployment.external_id))fail("rollback_target_changed");
 const payload:Payload={schemaVersion:1,state:saved,instanceId:installed.runtime.instance.instanceId,externalId:deployment.external_id};
 const text=canonicalConfigJson(payload);if(new TextEncoder().encode(text).length>1_900_000)fail("rollback_too_large");
 const encrypted=await encryptSecret(text,env.CREDENTIAL_ENCRYPTION_KEY),id=crypto.randomUUID(),now=Date.now();
 await commitConfiguration(env.DB,userId,configurationVersion,[
  env.DB.prepare("INSERT INTO managed_rollbacks(id,deployment_id,user_id,replacement_id,installation_id,instance_id,external_id,payload_encrypted,phase,machine_id,status,fence_version,fence_sequence,fence_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)")
   .bind(id,deploymentId,userId,original.id,installed.id,payload.instanceId,payload.externalId,encrypted,saved.phase,saved.machineId,configurationVersion,state.desired.sequence,state.desired.revision,now,now),
  env.DB.prepare(`UPDATE deployment_configuration_state SET active_instance_id=NULL,last_report_sequence=0,applied_sequence=NULL,applied_at=NULL WHERE deployment_id=? AND active_instance_id=? AND desired_sequence=?`).bind(deploymentId,payload.instanceId,state.desired.sequence),
  env.DB.prepare("UPDATE managed_installations SET phase='obsolete',lease_token=NULL,lease_until=NULL,updated_at=? WHERE deployment_id=? AND phase IN ('prepared','dispatched','installed')").bind(now,deploymentId),
 ]);
 const result=(await readManagedRollback(env,userId,deploymentId,id))!;
 if((await readDeploymentConfiguration(env.DB,userId,deploymentId))!.activeInstanceId!==null)fail("rollback_instance_changed");
 return result;
}

/** One bounded public rollback invocation. A typed pending error leaves the
 * same private intent resumable; provider health never creates applied state. */
export async function executeManagedRollback(env:Env,rollback:ManagedRollback,client:FlyMachinesClient,signal:AbortSignal):Promise<string>{
 const stored=await readManagedRollback(env,rollback.userId,rollback.deploymentId,rollback.id);if(!stored)fail("rollback_not_found");rollback=stored;
 if(rollback.status==="completed")return rollback.state.plan.before.id;
 const token=crypto.randomUUID(),now=Date.now();
 const claimed=await env.DB.prepare("UPDATE managed_rollbacks SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND user_id=? AND status='pending' AND (lease_until IS NULL OR lease_until<=?) RETURNING id").bind(token,now+60_000,now,rollback.id,rollback.userId,now).first();
 if(!claimed)fail("rollback_busy");
 try{
  const read=async()=>{
   signal.throwIfAborted();
   if(!await env.DB.prepare("SELECT id FROM managed_rollbacks WHERE id=? AND user_id=? AND lease_token=? AND lease_until>? AND status='pending'").bind(rollback.id,rollback.userId,token,Date.now()).first())fail("rollback_lease_expired");
   const saved=await readManagedRollback(env,rollback.userId,rollback.deploymentId,rollback.id);if(!saved)fail("rollback_not_found");
   const state=await readDeploymentConfiguration(env.DB,saved.userId,saved.deploymentId),deployment=await env.DB.prepare("SELECT external_id FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'").bind(saved.deploymentId,saved.userId).first<{external_id:string|null}>();
   if(!state || state.activeInstanceId!==null || state.desired.sequence!==saved.sequence || state.desired.revision!==saved.revision || await readConfigurationVersion(env.DB,saved.userId)!==saved.configurationVersion || !deployment || deployment.external_id!==saved.payload.externalId)fail("rollback_fence_changed");
   rollback=saved;return saved.state;
  };
  await executeFlyReplacement({runExclusive:async operation=>operation({read,compareAndSwap:async(expected,next)=>{
   await read();
   const changed=await commitConfiguration(env.DB,rollback.userId,rollback.configurationVersion,[env.DB.prepare(`UPDATE managed_rollbacks SET phase=?,machine_id=?,updated_at=? WHERE id=? AND user_id=? AND lease_token=? AND lease_until>? AND status='pending' AND phase=? AND machine_id IS ?
    AND EXISTS (SELECT 1 FROM deployment_configuration_state s JOIN deployment_configuration_revisions r ON r.deployment_id=s.deployment_id AND r.sequence=s.desired_sequence WHERE s.deployment_id=? AND s.active_instance_id IS NULL AND s.desired_sequence=? AND r.revision=?)`)
    .bind(next.phase,next.machineId,Date.now(),rollback.id,rollback.userId,token,Date.now(),expected.phase,expected.machineId,rollback.deploymentId,rollback.sequence,rollback.revision)]);
   return changed.results[0]!.meta.changes===1;
  }})},client,{rollback:true,assertCurrent:async()=>{signal.throwIfAborted();}});
  await read();
  const before=rollback.state.plan.before;
  // Mark complete first inside this same transaction so activation stays
  // blocked through the provider handoff and is released only with rebinding.
  const guard=crypto.randomUUID();
  const completed=await commitConfiguration(env.DB,rollback.userId,rollback.configurationVersion,[
   env.DB.prepare("UPDATE managed_rollbacks SET status='completed',updated_at=? WHERE id=? AND lease_token=? AND lease_until>? AND status='pending' AND phase='rolled_back'").bind(Date.now(),rollback.id,token,Date.now()),
   env.DB.prepare("UPDATE deployments SET external_id=?,image_digest=?,status='running',bundle_outdated=1,updated_at=? WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly' AND external_id IS ?").bind(`fly:${rollback.state.plan.app}:${before.id}`,before.image_ref.digest,Date.now(),rollback.deploymentId,rollback.userId,rollback.payload.externalId),
   env.DB.prepare("UPDATE managed_installations SET phase='obsolete',updated_at=? WHERE id IN (?,?)").bind(Date.now(),rollback.replacementId,rollback.installationId),
   env.DB.prepare("UPDATE deployment_configuration_revisions SET configuration_version=(SELECT version FROM configuration_versions WHERE user_id=?) WHERE deployment_id=? AND sequence=? AND revision=?").bind(rollback.userId,rollback.deploymentId,rollback.sequence,rollback.revision),
   env.DB.prepare("UPDATE managed_rollbacks SET fence_version=(SELECT version FROM configuration_versions WHERE user_id=?) WHERE id=?").bind(rollback.userId,rollback.id),
   // An unsuccessful lease/instance CAS must abort every preceding mutation.
   env.DB.prepare(`INSERT INTO configuration_write_guards(id,user_id,expected_version) SELECT ?,?,CASE WHEN EXISTS
    (SELECT 1 FROM managed_rollbacks b JOIN deployments d ON d.id=b.deployment_id JOIN deployment_configuration_state s ON s.deployment_id=d.id
     WHERE b.id=? AND b.user_id=? AND b.status='completed' AND b.phase='rolled_back' AND b.lease_token=? AND b.lease_until>?
     AND d.user_id=b.user_id AND d.managed=1 AND d.target_kind='fly' AND d.external_id=? AND s.active_instance_id IS NULL AND s.applied_sequence IS NULL AND s.last_report_sequence=0 AND s.desired_sequence=?)
    THEN (SELECT version FROM configuration_versions WHERE user_id=?) ELSE -1 END`)
    .bind(guard,rollback.userId,rollback.id,rollback.userId,token,Date.now(),`fly:${rollback.state.plan.app}:${before.id}`,rollback.sequence,rollback.userId),
   env.DB.prepare("DELETE FROM configuration_write_guards WHERE id=?").bind(guard),
  ]);
  if(completed.results.some(result=>result.meta.changes<1))fail("rollback_binding_changed");return before.id;
 }finally{await env.DB.prepare("UPDATE managed_rollbacks SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(rollback.id,token).run();}
}
