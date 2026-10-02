import { canonicalConfigJson,validateDeploymentActivation,validateDeploymentInstanceReceipt,type DeploymentInstanceActivation,type DeploymentInstanceReceipt } from "@logtura/core";
import { commitConfiguration } from "./config-version";
export class DeploymentInstanceError extends Error {constructor(public readonly status:400|404|409|413|503,public readonly code:string){super(code);}}
export async function readDeploymentInstanceReceipt(db:D1Database,userId:string,deploymentId:string,requestId:string,intent?:DeploymentInstanceActivation):Promise<DeploymentInstanceReceipt|null>{
 const row=await db.prepare(`SELECT r.* FROM deployment_instance_receipts r JOIN deployments d ON d.id=r.deployment_id AND d.user_id=r.user_id WHERE r.deployment_id=? AND r.user_id=? AND r.request_id=?`).bind(deploymentId,userId,requestId).first<{request_json:string;request_id:string;instance_id:string;configuration_version:number;sequence:number;revision:string}>();
 if(!row)return null;
 try{const stored=validateDeploymentActivation(JSON.parse(row.request_json));
 if(stored.requestId!==requestId || stored.expectedConfigurationVersion!==row.configuration_version || stored.expectedSequence!==row.sequence || stored.revision!==row.revision)throw new Error();
 if(intent && canonicalConfigJson(stored)!==canonicalConfigJson(intent))throw new DeploymentInstanceError(409,"request_id_reused");
 return validateDeploymentInstanceReceipt({requestId:row.request_id,instanceId:row.instance_id,configurationVersion:row.configuration_version,sequence:row.sequence,revision:row.revision});}catch(error){if(error instanceof DeploymentInstanceError)throw error;throw new DeploymentInstanceError(503,"configuration_unavailable");}
}
/** Active-instance CAS and receipt insertion share one graph-fenced transaction.
 * Receipt lookup precedes fences so a lost response can always be recovered. */
export async function activateDeploymentWithReceipt(db:D1Database,userId:string,deploymentId:string,value:unknown):Promise<DeploymentInstanceReceipt>{
 let intent:DeploymentInstanceActivation;try{intent=validateDeploymentActivation(value);}catch{throw new DeploymentInstanceError(400,"invalid_activation");}
 if(!await db.prepare("SELECT id FROM deployments WHERE id=? AND user_id=?").bind(deploymentId,userId).first())throw new DeploymentInstanceError(404,"not_found");
 const prior=await readDeploymentInstanceReceipt(db,userId,deploymentId,intent.requestId,intent);if(prior)return prior;
 const instanceId=crypto.randomUUID();
 try{
  const result=await commitConfiguration(db,userId,intent.expectedConfigurationVersion,[
   ...deploymentInstanceActivationStatements(db,userId,deploymentId,intent,instanceId),
  ]);
  if(result.results[0]!.meta.changes!==1 || result.results[1]!.meta.changes!==1)throw new DeploymentInstanceError(409,"revision_changed");
  return {requestId:intent.requestId,instanceId,configurationVersion:intent.expectedConfigurationVersion,sequence:intent.expectedSequence,revision:intent.revision};
 }catch(error){const recovered=await readDeploymentInstanceReceipt(db,userId,deploymentId,intent.requestId,intent);if(recovered)return recovered;throw error;}
}

/** Internal statement compiler for atomic service runtime intent + activation.
 * instanceId is allocated by the calling server operation, never HTTP input. */
export function deploymentInstanceActivationStatements(db:D1Database,userId:string,deploymentId:string,intent:DeploymentInstanceActivation,instanceId:string):D1PreparedStatement[]{
 return [
   db.prepare(`UPDATE deployment_configuration_state SET active_instance_id=?,last_report_sequence=0
    WHERE deployment_id=? AND active_instance_id IS ? AND desired_sequence=?
    AND EXISTS (SELECT 1 FROM deployment_configuration_revisions r WHERE r.deployment_id=? AND r.sequence=? AND r.revision=? AND r.configuration_version=?)`)
   .bind(instanceId,deploymentId,intent.expectedInstanceId,intent.expectedSequence,deploymentId,intent.expectedSequence,intent.revision,intent.expectedConfigurationVersion),
   db.prepare(`INSERT INTO deployment_instance_receipts(deployment_id,user_id,request_id,request_json,instance_id,configuration_version,sequence,revision,created_at)
    SELECT d.id,d.user_id,?,?,?,?,?,?,? FROM deployments d JOIN deployment_configuration_state s ON s.deployment_id=d.id WHERE d.id=? AND d.user_id=? AND s.active_instance_id=?`)
   .bind(intent.requestId,canonicalConfigJson(intent),instanceId,intent.expectedConfigurationVersion,intent.expectedSequence,intent.revision,Date.now(),deploymentId,userId,instanceId),
 ];
}
