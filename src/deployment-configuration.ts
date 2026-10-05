import { hashConfigDocument,parseDeploymentManifest,canonicalConfigJson,type DeploymentManifest,type DeploymentConfigurationState } from "@logtura/core";
import { commitConfiguration } from "./config-version";

export class DeploymentRevisionConflict extends Error {
  constructor(){super("Deployment revision changed; pull before retrying");this.name="DeploymentRevisionConflict";}
}
export type { DeploymentConfigurationState } from "@logtura/core";
function validatedDocument(value:unknown):DeploymentManifest {
  parseDeploymentManifest(value);return JSON.parse(canonicalConfigJson(value)) as DeploymentManifest;
}
interface StateRow {
  desired_sequence:number;desired_revision:string;document_json:string;configuration_version:number;
  applied_sequence:number|null;applied_revision:string|null;applied_at:number|null;
  active_instance_id:string|null;last_report_sequence:number;current_version:number;
}
export async function readDeploymentConfiguration(db:D1Database,userId:string,deploymentId:string):Promise<DeploymentConfigurationState|null>{
  const row=await db.prepare(`SELECT s.desired_sequence,r.revision AS desired_revision,r.document_json,r.configuration_version,
    s.applied_sequence,a.revision AS applied_revision,s.applied_at,s.active_instance_id,s.last_report_sequence,v.version AS current_version
    FROM deployment_configuration_state s JOIN deployments d ON d.id=s.deployment_id
    JOIN configuration_versions v ON v.user_id=d.user_id
    JOIN deployment_configuration_revisions r ON r.deployment_id=s.deployment_id AND r.sequence=s.desired_sequence
    LEFT JOIN deployment_configuration_revisions a ON a.deployment_id=s.deployment_id AND a.sequence=s.applied_sequence
    WHERE d.id=? AND d.user_id=?`).bind(deploymentId,userId).first<StateRow>();
  if(!row)return null;
  const document=validatedDocument(JSON.parse(row.document_json));
  return {desired:{sequence:row.desired_sequence,revision:row.desired_revision,document,configurationVersion:row.configuration_version},applied:row.applied_sequence===null?null:{sequence:row.applied_sequence,revision:row.applied_revision!,at:row.applied_at!},activeInstanceId:row.active_instance_id,lastReportSequence:row.last_report_sequence,stale:row.configuration_version!==row.current_version};
}
async function requireOwnedDeployment(db:D1Database,userId:string,deploymentId:string):Promise<void>{
  if(!await db.prepare("SELECT id FROM deployments WHERE id=? AND user_id=?").bind(deploymentId,userId).first())throw new Error("Deployment not found");
}
/** Compile validated public history/state writes for the same transaction as
 * inventory and selectors. The final statement records the post-mutation graph
 * version. Callers check owner, base sequence and account version first. */
export async function compileDeploymentRevision(db:D1Database,userId:string,deploymentId:string,sequence:number,manifest:DeploymentManifest):Promise<{document:DeploymentManifest;revision:string;statements:D1PreparedStatement[]}>{
  if(!Number.isSafeInteger(sequence) || sequence<=0)throw new Error("Invalid revision sequence");
  const document=validatedDocument(manifest),revision=await hashConfigDocument(document);
  return {document,revision,statements:[
    db.prepare(`INSERT INTO deployment_configuration_revisions(deployment_id,sequence,revision,document_json,configuration_version,created_at)
      SELECT id,?,?,?,(SELECT version FROM configuration_versions WHERE user_id=?),? FROM deployments WHERE id=? AND user_id=?`)
      .bind(sequence,revision,canonicalConfigJson(document),userId,Date.now(),deploymentId,userId),
    db.prepare(`INSERT INTO deployment_configuration_state(deployment_id,desired_sequence) VALUES (?,?)
      ON CONFLICT(deployment_id) DO UPDATE SET desired_sequence=excluded.desired_sequence`).bind(deploymentId,sequence),
    db.prepare(`UPDATE deployment_configuration_revisions SET configuration_version=(SELECT version FROM configuration_versions WHERE user_id=?) WHERE deployment_id=? AND sequence=?`).bind(userId,deploymentId,sequence),
  ]};
}
/** Issue a public desired revision. This internal primitive does not resolve
 * secrets, update graph inventory/selectors, or authorize HTTP requests. Graph
 * reconciliation uses compileDeploymentRevision in its same guarded transaction;
 * this standalone path supports issuing an already stable graph. */
export async function issueDeploymentConfiguration(db:D1Database,userId:string,deploymentId:string,expectedVersion:number,expectedSequence:number,manifest:DeploymentManifest):Promise<{sequence:number;revision:string;configurationVersion:number}>{
  if(!Number.isSafeInteger(expectedSequence) || expectedSequence<0 || expectedSequence>=Number.MAX_SAFE_INTEGER)throw new Error("Invalid desired sequence");
  await requireOwnedDeployment(db,userId,deploymentId);
  const document=validatedDocument(manifest),revision=await hashConfigDocument(document);
  const state=await readDeploymentConfiguration(db,userId,deploymentId);
  if((state?.desired.sequence??0)!==expectedSequence)throw new DeploymentRevisionConflict();
  // An unchanged revision is a no-op only at the same graph version. Otherwise
  // reissue it to record the new configuration base and fence old acknowledgements.
  if(state && state.desired.revision===revision && state.desired.configurationVersion===expectedVersion){
    await commitConfiguration(db,userId,expectedVersion,[]);return {sequence:state.desired.sequence,revision,configurationVersion:expectedVersion};
  }
  const sequence=expectedSequence+1;
  let configurationVersion:number;
  try{
    const compiled=await compileDeploymentRevision(db,userId,deploymentId,sequence,document);
    const committed=await commitConfiguration(db,userId,expectedVersion,compiled.statements);
    configurationVersion=committed.version;
  }catch(error){if(error instanceof Error && error.message.includes("LOGT_REVISION_CONFLICT"))throw new DeploymentRevisionConflict();throw error;}
  return {sequence,revision,configurationVersion};
}
/** Activate a fresh server-issued instance identity with a compare-and-swap.
 * Old instances cannot overwrite the new instance's applied reports. Legacy
 * heartbeat/metrics authentication remains independent and unchanged. */
export async function activateDeploymentInstance(db:D1Database,userId:string,deploymentId:string,expectedVersion:number,expectedInstanceId:string|null):Promise<string>{
  await requireOwnedDeployment(db,userId,deploymentId);
  const instanceId=crypto.randomUUID();
  const result=await commitConfiguration(db,userId,expectedVersion,[db.prepare(`UPDATE deployment_configuration_state SET active_instance_id=?,last_report_sequence=0
    WHERE deployment_id=? AND active_instance_id IS ?`).bind(instanceId,deploymentId,expectedInstanceId)]);
  if(result.results[0]!.meta.changes!==1)throw new DeploymentRevisionConflict();
  return instanceId;
}
/** Caller authenticates the reporting token first. Accept only a known issued
 * revision from the active instance, with an increasing per-instance report
 * sequence and no applied-configuration regression. Unknown/legacy reports are
 * a no-op; runtime reports never advance the account configuration version. */
export async function acknowledgeDeploymentConfiguration(db:D1Database,deploymentId:string,instanceId:string,sequence:number,revision:string,reportSequence:number):Promise<boolean>{
  if(!Number.isSafeInteger(sequence) || sequence<=0 || !Number.isSafeInteger(reportSequence) || reportSequence<=0)return false;
  const results=await db.batch([db.prepare(`UPDATE deployment_configuration_state SET applied_sequence=?,last_report_sequence=?,applied_at=?
    WHERE deployment_id=? AND active_instance_id=? AND last_report_sequence<? AND desired_sequence>=?
      AND (applied_sequence IS NULL OR applied_sequence<=?)
      AND EXISTS (SELECT 1 FROM deployment_configuration_revisions r WHERE r.deployment_id=? AND r.sequence=? AND r.revision=?)`)
    .bind(sequence,reportSequence,Date.now(),deploymentId,instanceId,reportSequence,sequence,sequence,deploymentId,sequence,revision),
    // Clear the legacy warning only for an accepted current report, in the same
    // transaction. Managed jobs retain their readiness/acceptance gate.
    // Historical, stale and replayed reports cannot hide edits.
    db.prepare(`UPDATE deployments SET bundle_outdated=0 WHERE id=? AND managed=0 AND bundle_outdated=1 AND changes()=1
      AND EXISTS (SELECT 1 FROM deployment_configuration_state s
        JOIN deployment_configuration_revisions r ON r.deployment_id=s.deployment_id AND r.sequence=s.desired_sequence
        JOIN configuration_versions v ON v.user_id=deployments.user_id
        WHERE s.deployment_id=deployments.id AND s.active_instance_id=? AND s.last_report_sequence=?
          AND s.applied_sequence=s.desired_sequence AND r.configuration_version=v.version)`)
      .bind(deploymentId,instanceId,reportSequence)]);
  return results[0]!.meta.changes===1;
}
