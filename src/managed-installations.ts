import { FlyMachinesClient, executeFlyReplacement, planFlyReplacement, validateFlyReplacementState, applyFlyMachine, canonicalConfigJson, flyRollbackConfig, immutableFlyImage, matchesFlyConfig, validateFlyMachine, type FlyMachine, type FlyMachineConfig, type ForwarderRuntimeArtifact, type FlyVolume, type FlyReplacementState, type FlyReplacementPhase } from "@logtura/core";
import { encryptSecret, decryptSecret } from "./crypto";
import { commitConfiguration, readConfigurationVersion } from "./config-version";
import { validateManagedRuntime } from "./managed-runtime-inputs";
import { readDeploymentConfiguration } from "./deployment-configuration";
import type { Env } from "./env";

interface InstallPayload {schemaVersion:1|2|3;name:string;after:FlyMachineConfig;before:FlyMachine|null;rollback:FlyMachineConfig|null;}
export interface ManagedInstall {
 id:string;deploymentId:string;userId:string;app:string;org:string;region:string;configurationVersion:number;
 phase:"prepared"|"dispatched"|"installed"|"completed"|"obsolete";machineId:string|null;installedConfigurationVersion:number|null;payload:InstallPayload;runtime:ForwarderRuntimeArtifact|null;replacementPhase:FlyReplacementPhase|null;
}
interface Row {id:string;deployment_id:string;user_id:string;app_name:string;org_slug:string;region:string;configuration_version:number;phase:ManagedInstall["phase"];machine_id:string|null;installed_configuration_version:number|null;payload_encrypted:ArrayBuffer|number[];replacement_phase:FlyReplacementPhase|null;}
// Leave space for row metadata beneath D1's 2,000,000-byte row/blob limit.
const LIMIT=1_900_000;
async function decode(env:Env,row:Row):Promise<ManagedInstall> {
 try {
  const envelope=Array.isArray(row.payload_encrypted)?Uint8Array.from(row.payload_encrypted):new Uint8Array(row.payload_encrypted);
  if(envelope.byteLength>LIMIT+28)throw new Error();
  const text=await decryptSecret(envelope,env.CREDENTIAL_ENCRYPTION_KEY);
  const value=JSON.parse(text) as InstallPayload;
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==5 || ![1,2,3].includes(value.schemaVersion) || value.name!==(value.schemaVersion===3?`forwarder-${row.id}`:"forwarder") || !value.after || typeof value.after!=="object" || Array.isArray(value.after))throw new Error();
  immutableFlyImage(value.after.image);canonicalConfigJson(value.after);
  if((value.after.metadata as Record<string,unknown>)?.["logtura.install"]!==row.id)throw new Error();
  if(value.before!==null){value.before=validateFlyMachine(value.before);if(value.before.region!==row.region || canonicalConfigJson(value.rollback)!==canonicalConfigJson(flyRollbackConfig(value.before)) || value.schemaVersion!==3 && row.machine_id!==value.before.id)throw new Error();}
  else if(value.rollback!==null)throw new Error();
  const decoded:ManagedInstall={id:row.id,deploymentId:row.deployment_id,userId:row.user_id,app:row.app_name,org:row.org_slug,region:row.region,configurationVersion:row.configuration_version,phase:row.phase,machineId:row.machine_id,installedConfigurationVersion:row.installed_configuration_version,payload:value,runtime:value.schemaVersion>=2?await validateManagedRuntime(value.after,row.deployment_id,row.configuration_version):null,replacementPhase:row.replacement_phase??null};
  if(value.schemaVersion===3){replacementState(decoded);if(row.phase==="prepared" && row.replacement_phase!=="prepared" || row.phase==="installed" && row.replacement_phase!=="installed" || row.phase==="completed" && row.replacement_phase!=="installed")throw new Error();}
  else if(decoded.replacementPhase!==null)throw new Error();
  return decoded;
 } catch {throw new Error("Invalid encrypted managed installation; retain it for recovery");}
}
/** Private internal lookup. Never expose decrypted provider payloads in job results. */
export async function readManagedInstall(env:Env,userId:string,deploymentId:string,id?:string):Promise<ManagedInstall|null> {
 const row=await env.DB.prepare(`SELECT i.* FROM managed_installations i JOIN deployments d ON d.id=i.deployment_id AND d.user_id=i.user_id
  WHERE i.deployment_id=? AND i.user_id=? AND ${id===undefined?"i.phase IN ('prepared','dispatched','installed')":"i.id=?"}`)
  .bind(deploymentId,userId,...(id===undefined?[]:[id])).first<Row>();
 return row?await decode(env,row):null;
}
/** Durable ownership/graph-fenced intent precedes every machine mutation. */
export async function prepareManagedInstall(env:Env,input:{userId:string;deploymentId:string;app:string;org:string;region:string;configurationVersion:number;config:FlyMachineConfig;machine:FlyMachine|null}):Promise<ManagedInstall> {
 const prior=await readManagedInstall(env,input.userId,input.deploymentId);
 if(prior){if(prior.app!==input.app || prior.region!==input.region || prior.org!==input.org)throw new Error("Managed installation target changed; retain it for recovery");return prior;}
 const compiled=await compileManagedInstallIntent(env,input,1);
 const {id}=compiled;
 try {
  const result=await commitConfiguration(env.DB,input.userId,input.configurationVersion,[compiled.statement]);
  if(result.results[0]!.meta.changes!==1)throw new Error("Managed deployment not found");
 } catch(error) {const recovered=await readManagedInstall(env,input.userId,input.deploymentId);if(recovered && recovered.app===input.app && recovered.region===input.region && recovered.org===input.org)return recovered;throw error;}
 return (await readManagedInstall(env,input.userId,input.deploymentId,id))!;
}
async function current(env:Env,install:ManagedInstall):Promise<void> {
 if(install.runtime){const state=await readDeploymentConfiguration(env.DB,install.userId,install.deploymentId),instance=install.runtime.instance;
  if(!state || state.stale || state.activeInstanceId!==instance.instanceId || state.desired.sequence!==instance.sequence || state.desired.revision!==instance.revision)throw new Error("Managed issued instance changed; retain installation for recovery");
 }
 if(await readConfigurationVersion(env.DB,install.userId)!==(install.installedConfigurationVersion??install.configurationVersion))throw new Error("Managed configuration changed; retain installation for recovery");
 if(!await env.DB.prepare("SELECT id FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'").bind(install.deploymentId,install.userId).first())throw new Error("Managed deployment no longer owned; retain installation for recovery");
}
/** Claim fences concurrent jobs. Unknown creates are observed, never blindly retried.
 * Updates use the packaged lease/version/full-config recovery operation. */
export async function executeManagedInstall(env:Env,install:ManagedInstall,client:FlyMachinesClient,signal:AbortSignal):Promise<string> {
 const token=crypto.randomUUID(),now=Date.now();
 const claimed=await env.DB.prepare(`UPDATE managed_installations SET lease_token=?,lease_until=?,updated_at=?
  WHERE id=? AND user_id=? AND phase IN ('prepared','dispatched','installed') AND (lease_until IS NULL OR lease_until<=?) RETURNING id`)
  .bind(token,now+60_000,now,install.id,install.userId,now).first();
 if(!claimed)throw new Error("Managed installation is busy or terminal; retry recovery");
 try {
  const stored=await readManagedInstall(env,install.userId,install.deploymentId,install.id);
  if(!stored)throw new Error("Managed installation no longer owned; retain it for recovery");install=stored;
  await current(env,install);if(signal.aborted)throw new Error("Managed installation interrupted; retain it for recovery");
  if((await client.app(install.app)).organization.slug!==install.org)throw new Error("Managed Fly organization does not match the saved installation");
  if(install.payload.schemaVersion===3)return await executeReplacement(env,install,client,signal,token);
  let machine:FlyMachine;
  if(install.payload.before){
   const before=install.payload.before;
   let inventory=await client.machines(install.app);
   if(inventory.length>1){const {selectManagedForwarder}=await import("./managed-machine-inventory"),selected=await selectManagedForwarder(env,install.userId,install.deploymentId,install.app,inventory);inventory=selected?[selected]:[];}
   if(inventory.length!==1 || inventory[0]!.id!==before.id)throw new Error("Managed install requires the same single forwarder machine");
   await dispatch(env,install,token);
   await applyFlyMachine(client,{app:install.app,machineId:before.id,version:before.instance_id,before:before.config,after:install.payload.after});
   machine=await client.machine(install.app,before.id);
  } else {
   const inventory=await client.machines(install.app);
   if(inventory.length){
    if(inventory.length!==1 || inventory[0]!.region!==install.region || (inventory[0] as FlyMachine & {name?:string}).name!==install.payload.name || !matchesFlyConfig(inventory[0]!.config,install.payload.after))throw new Error("Managed machine does not match the saved create intent");
    machine=inventory[0]!;
   } else {
    if(install.phase!=="prepared")throw new Error("Managed create outcome is unknown; retain installation for recovery");
    await dispatch(env,install,token);
    machine=await client.create(install.app,{name:install.payload.name,region:install.region,config:install.payload.after});
   }
  }
  if(!matchesFlyConfig(machine.config,install.payload.after))throw new Error("Fly did not install the saved managed configuration");
  await current(env,install);
  const saved=await env.DB.prepare(`UPDATE managed_installations SET phase='installed',machine_id=?,updated_at=? WHERE id=? AND lease_token=? AND lease_until>? AND phase IN ('dispatched','installed','prepared')`)
   .bind(machine.id,Date.now(),install.id,token,Date.now()).run();
  if(saved.meta.changes!==1)throw new Error("Managed installation lease expired; retain it for recovery");return machine.id;
 } finally {await env.DB.prepare("UPDATE managed_installations SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(install.id,token).run();}
}
async function dispatch(env:Env,install:ManagedInstall,token:string):Promise<void> {
 await current(env,install);
 const changed=await commitConfiguration(env.DB,install.userId,install.installedConfigurationVersion??install.configurationVersion,[env.DB.prepare(`UPDATE managed_installations SET phase='dispatched',updated_at=? WHERE id=? AND lease_token=? AND lease_until>? AND phase IN ('prepared','dispatched','installed')`)
  .bind(Date.now(),install.id,token,Date.now())]);
 if(changed.results[0]!.meta.changes!==1)throw new Error("Managed installation lease expired; retain it for recovery");
}
export function completeManagedInstall(db:D1Database,id:string,userId:string):D1PreparedStatement {
 return db.prepare("UPDATE managed_installations SET phase='completed',updated_at=? WHERE id=? AND user_id=? AND phase='installed'").bind(Date.now(),id,userId);
}

/** In the same batch after the external target write, bind its post-write graph base. */
export function recordManagedInstallVersion(db:D1Database,id:string,userId:string):D1PreparedStatement {
 return db.prepare(`UPDATE managed_installations SET installed_configuration_version=(SELECT version FROM configuration_versions WHERE user_id=?)
  WHERE id=? AND user_id=? AND phase='installed'`).bind(userId,id,userId);
}

export interface ManagedInstallInput {userId:string;deploymentId:string;app:string;org:string;region:string;configurationVersion:number;config:FlyMachineConfig;machine:FlyMachine|null;replacement?:{volume:string;volumes:FlyVolume[]};}
export async function compileManagedInstallIntent(env:Env,input:ManagedInstallInput,schemaVersion:1|2|3):Promise<{id:string;statement:D1PreparedStatement}>{
 const id=crypto.randomUUID(),before=input.machine===null?null:validateFlyMachine(input.machine);
 if(!/^[a-z0-9-]{1,63}$/.test(input.org) || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.app) || !/^[a-z]{3}$/.test(input.region) || (before && before.region!==input.region))throw new Error("Invalid managed installation target");
 immutableFlyImage(input.config.image);
 let payload:InstallPayload={schemaVersion,name:"forwarder",after:{...input.config,metadata:{...(input.config.metadata as Record<string,unknown>??{}),"logtura.install":id}},before,rollback:before?flyRollbackConfig(before):null};
 if(schemaVersion===3){
  if(!before || !input.replacement)throw new Error("Managed replacement requires a complete previous machine and checkpoint inventory");
  const plan=planFlyReplacement({id,app:input.app,org:input.org,machine:before,config:payload.after,...input.replacement});
  payload={schemaVersion,name:plan.name,after:plan.after,before:plan.before,rollback:plan.rollback};
 }
 const text=canonicalConfigJson(payload);if(new TextEncoder().encode(text).byteLength>LIMIT)throw new Error("Managed installation exceeds recovery limit");
 const encrypted=await encryptSecret(text,env.CREDENTIAL_ENCRYPTION_KEY),now=Date.now();
 const runtime=schemaVersion>=2?await validateManagedRuntime(payload.after,input.deploymentId,input.configurationVersion):null;
 return {id,statement:env.DB.prepare(`INSERT INTO managed_installations(id,deployment_id,user_id,app_name,org_slug,region,configuration_version,payload_encrypted,phase,machine_id,replacement_phase,created_at,updated_at)
  SELECT ?,id,user_id,?,?,?,?,?,'prepared',?,?,?,? FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'
  AND (? IS NULL OR EXISTS (SELECT 1 FROM deployment_configuration_state s WHERE s.deployment_id=deployments.id AND s.active_instance_id=?))`)
  .bind(id,input.app,input.org,input.region,input.configurationVersion,encrypted,schemaVersion===3?null:before?.id??null,schemaVersion===3?"prepared":null,now,now,input.deploymentId,input.userId,runtime?.instance.instanceId??null,runtime?.instance.instanceId??null)};
}


/** The native phase lives outside ciphertext, while the public plan is rebuilt
 * exclusively from the immutable encrypted provider inputs and row identity. */
function replacementState(install:ManagedInstall):FlyReplacementState {
 const {payload}=install,mounts=payload.after.mounts as Array<{volume?:unknown}>|undefined;
 if(payload.schemaVersion!==3 || !payload.before || !payload.rollback || !install.replacementPhase || !Array.isArray(mounts) || mounts.length!==1 || typeof mounts[0]?.volume!=="string")throw new Error("Invalid managed replacement journal");
 return validateFlyReplacementState({plan:{schemaVersion:1,id:install.id,app:install.app,org:install.org,name:payload.name,before:payload.before,after:payload.after,rollback:payload.rollback,volume:mounts[0].volume},phase:install.replacementPhase,machineId:install.machineId});
}
async function executeReplacement(env:Env,install:ManagedInstall,client:FlyMachinesClient,signal:AbortSignal,token:string):Promise<string>{
 const read=async()=>{
  signal.throwIfAborted();
  const owned=await env.DB.prepare("SELECT id FROM managed_installations WHERE id=? AND user_id=? AND lease_token=? AND lease_until>? AND phase IN ('prepared','dispatched','installed')")
   .bind(install.id,install.userId,token,Date.now()).first();
  if(!owned)throw new Error("Managed replacement lease expired; retain installation for recovery");
  const saved=await readManagedInstall(env,install.userId,install.deploymentId,install.id);
  if(!saved)throw new Error("Managed replacement no longer owned; retain installation for recovery");
  await current(env,saved);return replacementState(saved);
 };
 const result=await executeFlyReplacement({runExclusive:async operation=>operation({read,compareAndSwap:async(expected,next)=>{
  signal.throwIfAborted();
  const instance=install.runtime!.instance;
  const changed=await commitConfiguration(env.DB,install.userId,install.installedConfigurationVersion??install.configurationVersion,[env.DB.prepare(`UPDATE managed_installations SET replacement_phase=?,phase=?,machine_id=?,updated_at=?
   WHERE id=? AND user_id=? AND lease_token=? AND lease_until>? AND replacement_phase=? AND machine_id IS ?
   AND phase IN ('prepared','dispatched','installed') AND EXISTS (SELECT 1 FROM deployments d WHERE d.id=managed_installations.deployment_id AND d.user_id=managed_installations.user_id AND d.managed=1 AND d.target_kind='fly')
   AND EXISTS (SELECT 1 FROM deployment_configuration_state s JOIN deployment_configuration_revisions r ON r.deployment_id=s.deployment_id AND r.sequence=s.desired_sequence WHERE s.deployment_id=managed_installations.deployment_id AND s.active_instance_id=? AND s.desired_sequence=? AND r.revision=?)`)
   .bind(next.phase,next.phase==="installed"?"installed":"dispatched",next.machineId,Date.now(),install.id,install.userId,token,Date.now(),expected.phase,expected.machineId,instance.instanceId,instance.sequence,instance.revision)]);
  return changed.results[0]!.meta.changes===1;
 }})},client,{assertCurrent:async()=>{signal.throwIfAborted();}});
 if(result.phase!=="installed" || !result.machineId)throw new Error("Managed replacement handoff is pending; retain installation for recovery");
 return result.machineId;
}
