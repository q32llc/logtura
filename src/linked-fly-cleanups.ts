import {Hono,type Context} from "hono";
import {canonicalConfigJson,isInstanceId,validateFlyCleanupRequest,validateFlyCleanupReceipt,validateFlyRollbackRebaseRequest,validateFlyCleanupRebaseReceipt,type FlyCleanupRequest,type FlyCleanupReceipt,type FlyRollbackRebaseRequest,type FlyCleanupRebaseReceipt} from "@logtura/core";
import {readLinkedFlyRollback} from "./linked-fly-rollbacks";
import {getDeployment} from "./db";
import type {AppContext} from "./env";
export class LinkedFlyCleanupError extends Error {constructor(public readonly status:400|404|409|413|503,public readonly code:string){super(code);}}
export async function readLinkedFlyCleanup(db:D1Database,userId:string,deploymentId:string,requestId:string,intent?:FlyCleanupRequest):Promise<FlyCleanupReceipt|null>{
 const row=await db.prepare(`SELECT p.request_json,p.status,p.fence_version,p.fence_sequence,p.fence_revision,b.request_json AS binding_json,b.configuration_version AS binding_version
 FROM linked_fly_cleanups p JOIN deployments d ON d.id=p.deployment_id AND d.user_id=p.user_id
 JOIN linked_fly_binding_receipts b ON b.deployment_id=p.deployment_id AND b.user_id=p.user_id AND b.request_id=p.binding_request_id
 WHERE p.deployment_id=? AND p.user_id=? AND p.request_id=?`).bind(deploymentId,userId,requestId)
 .first<{request_json:string;status:string;fence_version:number;fence_sequence:number;fence_revision:string;binding_json:string;binding_version:number}>();
 if(!row)return null;
 try{const request=validateFlyCleanupRequest(JSON.parse(row.request_json));
  const rollback=request.rollbackRequestId===null?null:await readLinkedFlyRollback(db,userId,deploymentId,request.rollbackRequestId);
  const receipt=validateFlyCleanupReceipt({request,status:row.status,rollback,fence:{configurationVersion:row.fence_version,sequence:row.fence_sequence,revision:row.fence_revision},binding:{request:JSON.parse(row.binding_json),configurationVersion:row.binding_version}});
  if(receipt.request.requestId!==requestId)throw new Error();
  if(intent && canonicalConfigJson(intent)!==canonicalConfigJson(receipt.request))throw new LinkedFlyCleanupError(409,"request_id_reused");return receipt;
 }catch(error){if(error instanceof LinkedFlyCleanupError)throw error;throw new LinkedFlyCleanupError(503,"configuration_unavailable");}
}

export async function prepareLinkedFlyCleanup(db:D1Database,userId:string,deploymentId:string,value:unknown):Promise<FlyCleanupReceipt>{
 let intent:FlyCleanupRequest;try{intent=validateFlyCleanupRequest(value);}catch{throw new LinkedFlyCleanupError(400,"invalid_cleanup");}
 if(!await getDeployment(db,userId,deploymentId))throw new LinkedFlyCleanupError(404,"not_found");
 const prior=await readLinkedFlyCleanup(db,userId,deploymentId,intent.requestId,intent);if(prior)return prior;
 try{await db.prepare("INSERT INTO linked_fly_cleanups(deployment_id,user_id,request_id,request_json,binding_request_id,rollback_request_id,status,created_at,fence_version,fence_sequence,fence_revision) VALUES (?,?,?,?,?,?,'prepared',?,?,?,?)")
  .bind(deploymentId,userId,intent.requestId,canonicalConfigJson(intent),intent.bindingRequestId,intent.rollbackRequestId,Date.now(),intent.expectedConfigurationVersion,intent.expectedSequence,intent.revision).run();
 }catch(error){const recovered=await readLinkedFlyCleanup(db,userId,deploymentId,intent.requestId,intent);if(recovered)return recovered;
  if(error instanceof Error && (error.message.includes("LOGT_FLY_CLEANUP_CONFLICT") || error.message.includes("UNIQUE constraint failed")))throw new LinkedFlyCleanupError(409,"cleanup_changed");throw error;}
 return (await readLinkedFlyCleanup(db,userId,deploymentId,intent.requestId))!;
}
export async function completeLinkedFlyCleanup(db:D1Database,userId:string,deploymentId:string,requestId:string):Promise<FlyCleanupReceipt>{
 if(!isInstanceId(requestId))throw new LinkedFlyCleanupError(400,"invalid_request_id");
 if(!await getDeployment(db,userId,deploymentId))throw new LinkedFlyCleanupError(404,"not_found");
 const prior=await readLinkedFlyCleanup(db,userId,deploymentId,requestId);if(!prior)throw new LinkedFlyCleanupError(404,"receipt_not_found");if(prior.status==="completed")return prior;
 try{await db.prepare("UPDATE linked_fly_cleanups SET status='completed',completed_at=? WHERE deployment_id=? AND user_id=? AND request_id=? AND status='prepared'")
  .bind(Date.now(),deploymentId,userId,requestId).run();
 }catch(error){const recovered=await readLinkedFlyCleanup(db,userId,deploymentId,requestId);if(recovered?.status==="completed")return recovered;
  if(error instanceof Error && error.message.includes("LOGT_FLY_CLEANUP_CONFLICT"))throw new LinkedFlyCleanupError(409,"cleanup_changed");throw error;}
 return (await readLinkedFlyCleanup(db,userId,deploymentId,requestId))!;
}
export async function readLinkedFlyCleanupRebase(db:D1Database,userId:string,deploymentId:string,cleanupId:string,requestId:string,intent?:FlyRollbackRebaseRequest):Promise<FlyCleanupRebaseReceipt|null>{
 const row=await db.prepare(`SELECT a.request_json FROM linked_fly_cleanup_rebases a
 JOIN linked_fly_cleanups p ON p.deployment_id=a.deployment_id AND p.request_id=a.cleanup_id
 JOIN deployments d ON d.id=p.deployment_id AND d.user_id=p.user_id
 WHERE a.deployment_id=? AND p.user_id=? AND a.cleanup_id=? AND a.request_id=?`).bind(deploymentId,userId,cleanupId,requestId).first<{request_json:string}>();
 if(!row)return null;
 try{const receipt=validateFlyCleanupRebaseReceipt({cleanupId,request:JSON.parse(row.request_json)});if(receipt.request.requestId!==requestId)throw new Error();
  if(intent && canonicalConfigJson(intent)!==canonicalConfigJson(receipt.request))throw new LinkedFlyCleanupError(409,"request_id_reused");return receipt;
 }catch(error){if(error instanceof LinkedFlyCleanupError)throw error;throw new LinkedFlyCleanupError(503,"configuration_unavailable");}
}
/** Explicit graph reconciliation retains survivor/retired identities and snapshots. */
export async function rebaseLinkedFlyCleanup(db:D1Database,userId:string,deploymentId:string,cleanupId:string,value:unknown):Promise<FlyCleanupRebaseReceipt>{
 let intent:FlyRollbackRebaseRequest;try{intent=validateFlyRollbackRebaseRequest(value);}catch{throw new LinkedFlyCleanupError(400,"invalid_rebase");}
 if(!isInstanceId(cleanupId))throw new LinkedFlyCleanupError(400,"invalid_request_id");
 if(!await getDeployment(db,userId,deploymentId))throw new LinkedFlyCleanupError(404,"not_found");
 const prior=await readLinkedFlyCleanupRebase(db,userId,deploymentId,cleanupId,intent.requestId,intent);if(prior)return prior;
 if(!await readLinkedFlyCleanup(db,userId,deploymentId,cleanupId))throw new LinkedFlyCleanupError(404,"receipt_not_found");
 try{await db.prepare("INSERT INTO linked_fly_cleanup_rebases(deployment_id,cleanup_id,request_id,request_json,created_at) VALUES(?,?,?,?,?)")
  .bind(deploymentId,cleanupId,intent.requestId,canonicalConfigJson(intent),Date.now()).run();
 }catch(error){const recovered=await readLinkedFlyCleanupRebase(db,userId,deploymentId,cleanupId,intent.requestId,intent);if(recovered)return recovered;
  if(error instanceof Error && error.message.includes("LOGT_FLY_CLEANUP_CONFLICT"))throw new LinkedFlyCleanupError(409,"cleanup_changed");throw error;}
 return {cleanupId,request:intent};
}
async function body(c:Context<AppContext>):Promise<unknown>{
 const reader=c.req.raw.body?.getReader();if(!reader)throw new LinkedFlyCleanupError(400,"invalid_body");const chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>8192){await reader.cancel();throw new LinkedFlyCleanupError(413,"body_too_large");}chunks.push(part.value);}}
 catch(error){if(error instanceof LinkedFlyCleanupError)throw error;throw new LinkedFlyCleanupError(400,"invalid_body");}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new LinkedFlyCleanupError(400,"invalid_body");}
}
function failure(c:Context<AppContext>,error:unknown){return error instanceof LinkedFlyCleanupError?c.json({error:error.code},error.status):c.json({error:"configuration_unavailable"},503);}
export function linkedFlyCleanupRoutes(){
 const routes=new Hono<AppContext>();
 routes.post("/deployments/:id/config/fly-cleanups",async c=>{
  if(c.get("authKind")==="session" && c.req.header("origin")!==c.env.APP_URL)return c.json({error:"invalid_origin"},403);
  try{return c.json(await prepareLinkedFlyCleanup(c.env.DB,c.get("user")!.id,c.req.param("id"),await body(c)));}catch(error){return failure(c,error);}
 });
 routes.get("/deployments/:id/config/fly-cleanups/:requestId",async c=>{
  try{if(!await getDeployment(c.env.DB,c.get("user")!.id,c.req.param("id")))throw new LinkedFlyCleanupError(404,"not_found");
   if(!isInstanceId(c.req.param("requestId")))throw new LinkedFlyCleanupError(400,"invalid_request_id");
   const receipt=await readLinkedFlyCleanup(c.env.DB,c.get("user")!.id,c.req.param("id"),c.req.param("requestId"));if(!receipt)throw new LinkedFlyCleanupError(404,"receipt_not_found");return c.json(receipt);
  }catch(error){return failure(c,error);}
 });
 routes.post("/deployments/:id/config/fly-cleanups/:requestId/complete",async c=>{
  if(c.get("authKind")==="session" && c.req.header("origin")!==c.env.APP_URL)return c.json({error:"invalid_origin"},403);
  try{return c.json(await completeLinkedFlyCleanup(c.env.DB,c.get("user")!.id,c.req.param("id"),c.req.param("requestId")));}catch(error){return failure(c,error);}
 });
 routes.post("/deployments/:id/config/fly-cleanups/:cleanupId/rebases",async c=>{
  if(c.get("authKind")==="session" && c.req.header("origin")!==c.env.APP_URL)return c.json({error:"invalid_origin"},403);
  try{return c.json(await rebaseLinkedFlyCleanup(c.env.DB,c.get("user")!.id,c.req.param("id"),c.req.param("cleanupId"),await body(c)));}catch(error){return failure(c,error);}
 });
 routes.get("/deployments/:id/config/fly-cleanups/:cleanupId/rebases/:requestId",async c=>{
  try{if(!await getDeployment(c.env.DB,c.get("user")!.id,c.req.param("id")))throw new LinkedFlyCleanupError(404,"not_found");
   if(!isInstanceId(c.req.param("cleanupId")) || !isInstanceId(c.req.param("requestId")))throw new LinkedFlyCleanupError(400,"invalid_request_id");
   const receipt=await readLinkedFlyCleanupRebase(c.env.DB,c.get("user")!.id,c.req.param("id"),c.req.param("cleanupId"),c.req.param("requestId"));if(!receipt)throw new LinkedFlyCleanupError(404,"receipt_not_found");return c.json(receipt);
  }catch(error){return failure(c,error);}
 });return routes;
}
