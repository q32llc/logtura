import { canonicalConfigJson,createSecretVersioner,normalizeDeploymentManifest,validateDeploymentConfigCommit,isDeploymentPushRequestId,type DeploymentConfigPush,type DeploymentConfigCommit,type DeploymentPushReceipt } from "@logtura/core";
import type { Env } from "./env";
import { DeploymentPushError } from "./deployment-push";
export class PushReceiptConflict extends Error {constructor(){super("Push request identity was already used for a different request");}}
export class PushReceiptUnavailable extends Error {constructor(){super("Push receipt unavailable");}}
export interface PushReceiptIntent {requestId:string;requestHash:string;}
/** Keyed request fingerprints detect identity reuse without retaining uploads or
 * exposing dictionary-checkable private hashes. Equivalent JSON payload formatting
 * and omitted/false upload switches have the same effective request fingerprint. */
export async function createPushReceiptIntent(env:Env,userId:string,deploymentId:string,body:DeploymentConfigPush):Promise<PushReceiptIntent|undefined>{
 if(body.requestId===undefined)return undefined;
 if(!isDeploymentPushRequestId(body.requestId))throw new DeploymentPushError(400,"invalid_request_id");
 let secretValues:Record<string,unknown>;
 try{secretValues=Object.fromEntries(Object.entries(body.secretValues??{}).map(([name,value])=>[name,JSON.parse(value)]));}catch{throw new DeploymentPushError(400,"invalid_secret_values");}
 const versioner=await createSecretVersioner(env.CREDENTIAL_ENCRYPTION_KEY);
 const encoded=canonicalConfigJson({document:normalizeDeploymentManifest(body.document),expectedConfigurationVersion:body.expectedConfigurationVersion,expectedSequence:body.expectedSequence,uploadSecrets:body.uploadSecrets===true,secretValues});
 return {requestId:body.requestId,requestHash:await versioner(`deployment-push:${userId}:${deploymentId}:${body.requestId}`,encoded)};
}
export async function readPushReceipt(db:D1Database,userId:string,deploymentId:string,requestId:string,expectedHash?:string):Promise<DeploymentPushReceipt|null>{
 if(!isDeploymentPushRequestId(requestId))throw new DeploymentPushError(400,"invalid_request_id");
 try{
 const row=await db.prepare(`SELECT p.request_hash,p.configuration_version,p.sequence,p.revision,p.document_json,p.source_aliases_json
   FROM deployment_push_receipts p JOIN deployments d ON d.id=p.deployment_id AND d.user_id=p.user_id
   WHERE p.deployment_id=? AND p.user_id=? AND p.request_id=?`).bind(deploymentId,userId,requestId).first<{request_hash:string;configuration_version:number;sequence:number;revision:string;document_json:string;source_aliases_json:string}>();
 if(!row)return null;
 if(!/^[a-f0-9]{64}$/.test(row.request_hash))throw new PushReceiptUnavailable();
 if(expectedHash!==undefined && row.request_hash!==expectedHash)throw new PushReceiptConflict();
 const result=await validateDeploymentConfigCommit({configurationVersion:row.configuration_version,sequence:row.sequence,revision:row.revision,document:JSON.parse(row.document_json),sourceAliases:JSON.parse(row.source_aliases_json)});
 return {requestId,result};
 }catch(error){if(error instanceof PushReceiptConflict)throw error;throw new PushReceiptUnavailable();}
}
/** Append after all graph/revision mutations in the same guarded D1 batch, so
 * configuration_version records the committed graph and failure rolls back both. */
export function compilePushReceipt(db:D1Database,userId:string,deploymentId:string,intent:PushReceiptIntent,result:Omit<DeploymentConfigCommit,"configurationVersion">):D1PreparedStatement {
 if(!isDeploymentPushRequestId(intent.requestId) || !/^[a-f0-9]{64}$/.test(intent.requestHash))throw new DeploymentPushError(400,"invalid_request_id");
 return db.prepare(`INSERT INTO deployment_push_receipts(deployment_id,user_id,request_id,request_hash,configuration_version,sequence,revision,document_json,source_aliases_json,created_at)
   SELECT id,user_id,?,?,(SELECT version FROM configuration_versions WHERE user_id=?),?,?,?,?,? FROM deployments WHERE id=? AND user_id=?`)
   .bind(intent.requestId,intent.requestHash,userId,result.sequence,result.revision,canonicalConfigJson(result.document),canonicalConfigJson(result.sourceAliases),Date.now(),deploymentId,userId);
}
