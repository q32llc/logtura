import {commitConfiguration} from "./config-version";
import type {ManagedInstall} from "./managed-installations";
import type {Env} from "./env";
/** The accepted report and active instance remain load-bearing in the mutation
 * itself: active-instance replacement does not advance the account graph clock. */
export async function completeIssuedManagedDeployment(env:Env,install:ManagedInstall,expectedVersion:number):Promise<void>{
 const runtime=install.runtime;
 if(!runtime || install.phase!=="installed" || !install.machineId || install.installedConfigurationVersion!==expectedVersion)throw new Error("Managed runtime installation is not ready for completion");
 const instance=runtime.instance;
 const accepted=`EXISTS (SELECT 1 FROM deployment_configuration_state s JOIN deployment_configuration_revisions r ON r.deployment_id=s.deployment_id AND r.sequence=s.desired_sequence
  WHERE s.deployment_id=? AND s.active_instance_id=? AND s.last_report_sequence>0 AND s.desired_sequence=? AND s.applied_sequence=? AND r.revision=? AND r.configuration_version=?)`;
 const args=[install.deploymentId,instance.instanceId,instance.sequence,instance.sequence,instance.revision,expectedVersion];
 const result=await commitConfiguration(env.DB,install.userId,expectedVersion,[
  env.DB.prepare(`UPDATE deployments SET status='running',bundle_outdated=0,updated_at=? WHERE id=? AND user_id=? AND managed=1 AND target_kind='fly'
   AND external_id=? AND EXISTS (SELECT 1 FROM managed_installations i WHERE i.id=? AND i.phase='installed' AND i.machine_id=?) AND ${accepted}`)
   .bind(Date.now(),install.deploymentId,install.userId,`fly:${install.app}:${install.machineId}`,install.id,install.machineId,...args),
  env.DB.prepare(`UPDATE managed_installations SET phase='completed',updated_at=? WHERE id=? AND user_id=? AND deployment_id=? AND phase='installed' AND machine_id=?
   AND EXISTS (SELECT 1 FROM deployments d WHERE d.id=? AND d.user_id=? AND d.managed=1 AND d.target_kind='fly' AND d.external_id=? AND d.status='running' AND d.bundle_outdated=0) AND ${accepted}`)
   .bind(Date.now(),install.id,install.userId,install.deploymentId,install.machineId,install.deploymentId,install.userId,`fly:${install.app}:${install.machineId}`,...args),
 ]);
 if(result.results.some(result=>result.meta.changes<1))throw new Error("Managed runtime acknowledgement changed before completion; retain installation for recovery");
}
