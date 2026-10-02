import {buildFlyRuntimeConfig,compileForwarderRuntime,hashConfigDocument,type DeploymentManifest,type FlyMachineConfig,type FlyMachine,type GenerateInput} from "@logtura/core";
import {commitConfiguration} from "./config-version";
import {readDeploymentConfiguration} from "./deployment-configuration";
import {deploymentInstanceActivationStatements} from "./deployment-instances";
import {compileManagedInstallIntent,readManagedInstall,recordManagedInstallVersion,type ManagedInstall} from "./managed-installations";
import type {Env} from "./env";

/** Server-owned issuance and encrypted provider intent share one transaction.
 * No provider writes occur here. Queue adapters must persist storage first. */
export async function prepareIssuedManagedInstall(env:Env,input:{userId:string;deploymentId:string;app:string;org:string;region:string;configurationVersion:number;base:FlyMachineConfig;machine:FlyMachine|null;volume:string;service:string;document:DeploymentManifest;env:Record<string,string>;providers:GenerateInput["providers"];destinations:GenerateInput["destinations"]}):Promise<ManagedInstall>{
 const prior=await readManagedInstall(env,input.userId,input.deploymentId);
 if(prior){
  if(!prior.runtime || prior.app!==input.app || prior.org!==input.org || prior.region!==input.region)throw new Error("Managed issued installation conflicts with retained intent");return prior;
 }
 if(!await env.DB.prepare("SELECT id FROM deployments WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'").bind(input.deploymentId,input.userId).first())throw new Error("Managed deployment not found");
 const state=await readDeploymentConfiguration(env.DB,input.userId,input.deploymentId);
 if(!state || state.stale || state.desired.configurationVersion!==input.configurationVersion || state.desired.revision!==await hashConfigDocument(input.document))throw new Error("Managed desired revision changed before issuance");
 const instance={requestId:crypto.randomUUID(),instanceId:crypto.randomUUID(),configurationVersion:input.configurationVersion,sequence:state.desired.sequence,revision:state.desired.revision};
 const compiled=await compileForwarderRuntime({service:input.service,deploymentId:input.deploymentId,document:input.document,instance,env:input.env,providers:input.providers,destinations:input.destinations});
 const config=await buildFlyRuntimeConfig({base:input.base,volume:input.volume,image:input.base.image,...compiled});
 const intent=await compileManagedInstallIntent(env,{...input,config},2);
 try {
  const result=await commitConfiguration(env.DB,input.userId,input.configurationVersion,[
   ...deploymentInstanceActivationStatements(env.DB,input.userId,input.deploymentId,{requestId:instance.requestId,expectedConfigurationVersion:input.configurationVersion,expectedInstanceId:state.activeInstanceId,expectedSequence:instance.sequence,revision:instance.revision},instance.instanceId),
   intent.statement,
  ]);
  if(result.results.some(result=>result.meta.changes!==1))throw new Error("Managed instance changed before atomic issuance");
 }catch(error){const recovered=await readManagedInstall(env,input.userId,input.deploymentId);if(recovered?.runtime && recovered.app===input.app && recovered.org===input.org && recovered.region===input.region)return recovered;throw error;}
 return (await readManagedInstall(env,input.userId,input.deploymentId,intent.id))!;
}

/** Physical target binding changes the account graph clock. Rebase only this
 * unchanged issued revision in the same transaction; its immutable receipt and
 * runtime artifact retain the original issuance version. */
export async function bindInstalledManagedRuntime(env:Env,userId:string,deploymentId:string,installationId:string):Promise<number>{
 const install=await readManagedInstall(env,userId,deploymentId,installationId);
 if(!install?.runtime || install.phase!=="installed" || !install.machineId)throw new Error("Managed issued installation is not installed");
 const state=await readDeploymentConfiguration(env.DB,userId,deploymentId),instance=install.runtime.instance;
 const expected=install.installedConfigurationVersion??install.configurationVersion;
 if(!state || state.stale || state.activeInstanceId!==instance.instanceId || state.desired.sequence!==instance.sequence || state.desired.revision!==instance.revision || state.desired.configurationVersion!==expected)throw new Error("Managed issued instance changed before target binding");
 const result=await commitConfiguration(env.DB,userId,expected,[
  env.DB.prepare(`UPDATE deployments SET external_id=?,image_digest=?,updated_at=? WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'
   AND EXISTS (SELECT 1 FROM managed_installations i WHERE i.id=? AND i.phase='installed' AND i.machine_id=?)`)
   .bind(`fly:${install.app}:${install.machineId}`,install.payload.after.image.split("@")[1],Date.now(),deploymentId,userId,install.id,install.machineId),
  recordManagedInstallVersion(env.DB,install.id,userId),
  env.DB.prepare(`UPDATE deployment_configuration_revisions SET configuration_version=(SELECT version FROM configuration_versions WHERE user_id=?)
   WHERE deployment_id=? AND sequence=? AND revision=? AND configuration_version=?
   AND EXISTS (SELECT 1 FROM deployment_configuration_state s WHERE s.deployment_id=? AND s.active_instance_id=? AND s.desired_sequence=?)`)
   .bind(userId,deploymentId,instance.sequence,instance.revision,expected,deploymentId,instance.instanceId,instance.sequence),
 ]);
 // D1 includes configuration-version trigger changes in its change count.
 if(result.results.some(result=>result.meta.changes<1))throw new Error("Managed target changed during binding");return result.version;
}
