import {Hono,type Context} from "hono";
import {canonicalConfigJson,isInstanceId,validateFlyRollbackRequest,validateFlyRollbackReceipt,validateFlyRollbackRebaseRequest,validateFlyRollbackRebaseReceipt,type FlyRollbackRequest,type FlyRollbackReceipt,type FlyRollbackRebaseRequest,type FlyRollbackRebaseReceipt} from "@logtura/core";
import {getDeployment} from "./db";
import type {AppContext} from "./env";
export class LinkedFlyRollbackError extends Error {constructor(public readonly status:400|404|409|413|503,public readonly code:string){super(code);}}
export async function readLinkedFlyRollback(db:D1Database,userId:string,deploymentId:string,requestId:string,intent?:FlyRollbackRequest):Promise<FlyRollbackReceipt|null>{
 const row=await db.prepare(`SELECT p.request_json,p.status,p.configuration_version,p.fence_version,p.fence_sequence,p.fence_revision,b.request_json AS binding_json,b.configuration_version AS binding_version
 FROM linked_fly_rollbacks p JOIN deployments d ON d.id=p.deployment_id AND d.user_id=p.user_id
 JOIN linked_fly_binding_receipts b ON b.deployment_id=p.deployment_id AND b.user_id=p.user_id AND b.request_id=p.binding_request_id
 WHERE p.deployment_id=? AND p.user_id=? AND p.request_id=?`).bind(deploymentId,userId,requestId)
 .first<{request_json:string;status:string;configuration_version:number;fence_version:number;fence_sequence:number;fence_revision:string;binding_json:string;binding_version:number}>();
 if(!row)return null;
 try{const receipt=validateFlyRollbackReceipt({request:JSON.parse(row.request_json),status:row.status,configurationVersion:row.configuration_version,fence:{configurationVersion:row.fence_version,sequence:row.fence_sequence,revision:row.fence_revision},binding:{request:JSON.parse(row.binding_json),configurationVersion:row.binding_version}});
  if(receipt.request.requestId!==requestId)throw new Error();
  if(intent && canonicalConfigJson(intent)!==canonicalConfigJson(receipt.request))throw new LinkedFlyRollbackError(409,"request_id_reused");return receipt;
 }catch(error){if(error instanceof LinkedFlyRollbackError)throw error;throw new LinkedFlyRollbackError(503,"configuration_unavailable");}
}
export async function prepareLinkedFlyRollback(db:D1Database,userId:string,deploymentId:string,value:unknown):Promise<FlyRollbackReceipt>{
 let intent:FlyRollbackRequest;try{intent=validateFlyRollbackRequest(value);}catch{throw new LinkedFlyRollbackError(400,"invalid_rollback");}
 if(!await getDeployment(db,userId,deploymentId))throw new LinkedFlyRollbackError(404,"not_found");
 const prior=await readLinkedFlyRollback(db,userId,deploymentId,intent.requestId,intent);if(prior)return prior;
 try{await db.prepare("INSERT INTO linked_fly_rollbacks(deployment_id,user_id,request_id,request_json,binding_request_id,status,configuration_version,created_at,fence_version,fence_sequence,fence_revision) VALUES (?,?,?,?,?,'prepared',?,?,?,?,?)")
  .bind(deploymentId,userId,intent.requestId,canonicalConfigJson(intent),intent.bindingRequestId,intent.expectedConfigurationVersion,Date.now(),intent.expectedConfigurationVersion,intent.expectedSequence,intent.revision).run();
 }catch(error){const recovered=await readLinkedFlyRollback(db,userId,deploymentId,intent.requestId,intent);if(recovered)return recovered;
  if(error instanceof Error && (error.message.includes("LOGT_FLY_ROLLBACK_CONFLICT") || error.message.includes("UNIQUE constraint failed")))throw new LinkedFlyRollbackError(409,"rollback_changed");throw error;}
 return (await readLinkedFlyRollback(db,userId,deploymentId,intent.requestId))!;
}
export async function completeLinkedFlyRollback(db:D1Database,userId:string,deploymentId:string,requestId:string):Promise<FlyRollbackReceipt>{
 if(!isInstanceId(requestId))throw new LinkedFlyRollbackError(400,"invalid_request_id");
 if(!await getDeployment(db,userId,deploymentId))throw new LinkedFlyRollbackError(404,"not_found");
 const prior=await readLinkedFlyRollback(db,userId,deploymentId,requestId);if(!prior)throw new LinkedFlyRollbackError(404,"receipt_not_found");if(prior.status==="completed")return prior;
 try{await db.prepare("UPDATE linked_fly_rollbacks SET status='completed',configuration_version=configuration_version+1,completed_at=? WHERE deployment_id=? AND user_id=? AND request_id=? AND status='prepared'")
  .bind(Date.now(),deploymentId,userId,requestId).run();
 }catch(error){const recovered=await readLinkedFlyRollback(db,userId,deploymentId,requestId);if(recovered?.status==="completed")return recovered;
  if(error instanceof Error && error.message.includes("LOGT_FLY_ROLLBACK_CONFLICT"))throw new LinkedFlyRollbackError(409,"rollback_changed");throw error;}
 return (await readLinkedFlyRollback(db,userId,deploymentId,requestId))!;
}
export async function readLinkedFlyRollbackRebase(db:D1Database,userId:string,deploymentId:string,rollbackId:string,requestId:string,intent?:FlyRollbackRebaseRequest):Promise<FlyRollbackRebaseReceipt|null>{
 const row=await db.prepare(`SELECT a.request_json FROM linked_fly_rollback_rebases a
 JOIN linked_fly_rollbacks p ON p.deployment_id=a.deployment_id AND p.request_id=a.rollback_id
 JOIN deployments d ON d.id=p.deployment_id AND d.user_id=p.user_id
 WHERE a.deployment_id=? AND p.user_id=? AND a.rollback_id=? AND a.request_id=?`).bind(deploymentId,userId,rollbackId,requestId).first<{request_json:string}>();
 if(!row)return null;
 try{const receipt=validateFlyRollbackRebaseReceipt({rollbackId,request:JSON.parse(row.request_json)});if(receipt.request.requestId!==requestId)throw new Error();
  if(intent && canonicalConfigJson(intent)!==canonicalConfigJson(receipt.request))throw new LinkedFlyRollbackError(409,"request_id_reused");return receipt;
 }catch(error){if(error instanceof LinkedFlyRollbackError)throw error;throw new LinkedFlyRollbackError(503,"configuration_unavailable");}
}
/** Explicit graph reconciliation only. The retained physical/private identities
 * remain in the original immutable request; receipt lookup never implies current. */
export async function rebaseLinkedFlyRollback(db:D1Database,userId:string,deploymentId:string,rollbackId:string,value:unknown):Promise<FlyRollbackRebaseReceipt>{
 let intent:FlyRollbackRebaseRequest;try{intent=validateFlyRollbackRebaseRequest(value);}catch{throw new LinkedFlyRollbackError(400,"invalid_rebase");}
 if(!isInstanceId(rollbackId))throw new LinkedFlyRollbackError(400,"invalid_request_id");
 if(!await getDeployment(db,userId,deploymentId))throw new LinkedFlyRollbackError(404,"not_found");
 const prior=await readLinkedFlyRollbackRebase(db,userId,deploymentId,rollbackId,intent.requestId,intent);if(prior)return prior;
 if(!await readLinkedFlyRollback(db,userId,deploymentId,rollbackId))throw new LinkedFlyRollbackError(404,"receipt_not_found");
 try{await db.prepare("INSERT INTO linked_fly_rollback_rebases(deployment_id,rollback_id,request_id,request_json,created_at) VALUES(?,?,?,?,?)")
  .bind(deploymentId,rollbackId,intent.requestId,canonicalConfigJson(intent),Date.now()).run();
 }catch(error){const recovered=await readLinkedFlyRollbackRebase(db,userId,deploymentId,rollbackId,intent.requestId,intent);if(recovered)return recovered;
  if(error instanceof Error && error.message.includes("LOGT_FLY_ROLLBACK_CONFLICT"))throw new LinkedFlyRollbackError(409,"rollback_changed");throw error;}
 return {rollbackId,request:intent};
}
async function body(c:Context<AppContext>):Promise<unknown>{
 const reader=c.req.raw.body?.getReader();if(!reader)throw new LinkedFlyRollbackError(400,"invalid_body");const chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>8192){await reader.cancel();throw new LinkedFlyRollbackError(413,"body_too_large");}chunks.push(part.value);}}
 catch(error){if(error instanceof LinkedFlyRollbackError)throw error;throw new LinkedFlyRollbackError(400,"invalid_body");}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new LinkedFlyRollbackError(400,"invalid_body");}
}
function failure(c:Context<AppContext>,error:unknown){return error instanceof LinkedFlyRollbackError?c.json({error:error.code},error.status):c.json({error:"configuration_unavailable"},503);}
export function linkedFlyRollbackRoutes(){
 const routes=new Hono<AppContext>();
 routes.post("/deployments/:id/config/fly-rollbacks",async c=>{
  if(c.get("authKind")==="session" && c.req.header("origin")!==c.env.APP_URL)return c.json({error:"invalid_origin"},403);
  try{return c.json(await prepareLinkedFlyRollback(c.env.DB,c.get("user")!.id,c.req.param("id"),await body(c)));}catch(error){return failure(c,error);}
 });
 routes.get("/deployments/:id/config/fly-rollbacks/:requestId",async c=>{
  try{if(!await getDeployment(c.env.DB,c.get("user")!.id,c.req.param("id")))throw new LinkedFlyRollbackError(404,"not_found");
   if(!isInstanceId(c.req.param("requestId")))throw new LinkedFlyRollbackError(400,"invalid_request_id");
   const receipt=await readLinkedFlyRollback(c.env.DB,c.get("user")!.id,c.req.param("id"),c.req.param("requestId"));if(!receipt)throw new LinkedFlyRollbackError(404,"receipt_not_found");return c.json(receipt);
  }catch(error){return failure(c,error);}
 });
 routes.post("/deployments/:id/config/fly-rollbacks/:requestId/complete",async c=>{
  if(c.get("authKind")==="session" && c.req.header("origin")!==c.env.APP_URL)return c.json({error:"invalid_origin"},403);
  try{return c.json(await completeLinkedFlyRollback(c.env.DB,c.get("user")!.id,c.req.param("id"),c.req.param("requestId")));}catch(error){return failure(c,error);}
 });
 routes.post("/deployments/:id/config/fly-rollbacks/:rollbackId/rebases",async c=>{
  if(c.get("authKind")==="session" && c.req.header("origin")!==c.env.APP_URL)return c.json({error:"invalid_origin"},403);
  try{return c.json(await rebaseLinkedFlyRollback(c.env.DB,c.get("user")!.id,c.req.param("id"),c.req.param("rollbackId"),await body(c)));}catch(error){return failure(c,error);}
 });
 routes.get("/deployments/:id/config/fly-rollbacks/:rollbackId/rebases/:requestId",async c=>{
  try{if(!await getDeployment(c.env.DB,c.get("user")!.id,c.req.param("id")))throw new LinkedFlyRollbackError(404,"not_found");
   if(!isInstanceId(c.req.param("rollbackId")) || !isInstanceId(c.req.param("requestId")))throw new LinkedFlyRollbackError(400,"invalid_request_id");
   const receipt=await readLinkedFlyRollbackRebase(c.env.DB,c.get("user")!.id,c.req.param("id"),c.req.param("rollbackId"),c.req.param("requestId"));if(!receipt)throw new LinkedFlyRollbackError(404,"receipt_not_found");return c.json(receipt);
  }catch(error){return failure(c,error);}
 });return routes;
}
