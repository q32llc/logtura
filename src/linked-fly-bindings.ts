import {Hono,type Context} from "hono";
import {canonicalConfigJson,isInstanceId,validateFlyBindingRequest,validateFlyBindingReceipt,flyBindingConfigurationVersion,type FlyBindingRequest,type FlyBindingReceipt} from "@logtura/core";
import type {AppContext} from "./env";
import {getDeployment} from "./db";

export class FlyBindingError extends Error {constructor(public readonly status:400|404|409|413|503,public readonly code:string){super(code);}}
/** Receipt recovery precedes current-state fences, preserving a lost response
 * even after a later website edit. It never means the receipt is still current. */
export async function readFlyBindingReceipt(db:D1Database,userId:string,deploymentId:string,requestId:string,intent?:FlyBindingRequest):Promise<FlyBindingReceipt|null>{
 const row=await db.prepare(`SELECT r.request_json,r.configuration_version FROM linked_fly_binding_receipts r
  JOIN deployments d ON d.id=r.deployment_id AND d.user_id=r.user_id WHERE r.deployment_id=? AND r.user_id=? AND r.request_id=?`)
  .bind(deploymentId,userId,requestId).first<{request_json:string;configuration_version:number}>();
 if(!row)return null;
 try{
  const receipt=validateFlyBindingReceipt({request:JSON.parse(row.request_json),configurationVersion:row.configuration_version});
  if(receipt.request.requestId!==requestId)throw new Error();
  if(intent && canonicalConfigJson(receipt.request)!==canonicalConfigJson(intent))throw new FlyBindingError(409,"request_id_reused");
  return receipt;
 }catch(error){if(error instanceof FlyBindingError)throw error;throw new FlyBindingError(503,"configuration_unavailable");}
}
export async function bindLinkedFlyReplacement(db:D1Database,userId:string,deploymentId:string,value:unknown):Promise<FlyBindingReceipt>{
 let intent:FlyBindingRequest;try{intent=validateFlyBindingRequest(value);}catch{throw new FlyBindingError(400,"invalid_binding");}
 if(!await getDeployment(db,userId,deploymentId))throw new FlyBindingError(404,"not_found");
 const prior=await readFlyBindingReceipt(db,userId,deploymentId,intent.requestId,intent);if(prior)return prior;
 try{
  await db.prepare(`INSERT INTO linked_fly_binding_receipts(deployment_id,user_id,request_id,request_json,configuration_version,created_at) VALUES(?,?,?,?,?,?)`)
   .bind(deploymentId,userId,intent.requestId,canonicalConfigJson(intent),flyBindingConfigurationVersion(intent),Date.now()).run();
 }catch(error){
  const recovered=await readFlyBindingReceipt(db,userId,deploymentId,intent.requestId,intent);if(recovered)return recovered;
  if(error instanceof Error && error.message.includes("LOGT_FLY_BINDING_CONFLICT"))throw new FlyBindingError(409,"binding_changed");
  throw error;
 }
 return {request:intent,configurationVersion:flyBindingConfigurationVersion(intent)};
}
async function body(c:Context<AppContext>):Promise<unknown>{
 const reader=c.req.raw.body?.getReader();if(!reader)throw new FlyBindingError(400,"invalid_body");
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8192){await reader.cancel();throw new FlyBindingError(413,"body_too_large");}chunks.push(part.value);}}
 catch(error){if(error instanceof FlyBindingError)throw error;throw new FlyBindingError(400,"invalid_body");}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new FlyBindingError(400,"invalid_body");}
}
function failure(c:Context<AppContext>,error:unknown){return error instanceof FlyBindingError?c.json({error:error.code},error.status):c.json({error:"configuration_unavailable"},503);}
/** Account auth is installed by the parent. Reporting credentials cannot bind.
 * Provider handoff and file/config checks belong to the packaged CLI backend. */
export function linkedFlyBindingRoutes(){
 const routes=new Hono<AppContext>();
 routes.get("/deployments/:id/config/fly-capabilities",async c=>{
  try{if(!await getDeployment(c.env.DB,c.get("user")!.id,c.req.param("id")))return c.json({error:"not_found"},404);
   return c.json({schemaVersion:1,features:["replacement","image-update","rollback"]});
  }catch(error){return failure(c,error);}
 });
 routes.post("/deployments/:id/config/fly-bindings",async c=>{
  if(c.get("authKind")==="session" && c.req.header("origin")!==c.env.APP_URL)return c.json({error:"invalid_origin"},403);
  try{return c.json(await bindLinkedFlyReplacement(c.env.DB,c.get("user")!.id,c.req.param("id"),await body(c)));}catch(error){return failure(c,error);}
 });
 routes.get("/deployments/:id/config/fly-bindings/:requestId",async c=>{
  try{
   const userId=c.get("user")!.id,id=c.req.param("id"),requestId=c.req.param("requestId");
   if(!await getDeployment(c.env.DB,userId,id))return c.json({error:"not_found"},404);
   if(!isInstanceId(requestId))return c.json({error:"invalid_request_id"},400);
   const receipt=await readFlyBindingReceipt(c.env.DB,userId,id,requestId);return receipt?c.json(receipt):c.json({error:"receipt_not_found"},404);
  }catch(error){return failure(c,error);}
 });
 routes.get("/deployments/:id/config/fly-binding",async c=>{
  try{
   const userId=c.get("user")!.id,id=c.req.param("id"),deployment=await getDeployment(c.env.DB,userId,id);
   if(!deployment)return c.json({error:"not_found"},404);
   const row=await c.env.DB.prepare(`SELECT request_id FROM linked_fly_binding_receipts WHERE deployment_id=? AND user_id=?
    AND 'fly:'||json_extract(request_json,'$.appName')||':'||json_extract(request_json,'$.machineId')=?
    AND json_extract(request_json,'$.previousMachineId')<>json_extract(request_json,'$.machineId')
    ORDER BY configuration_version DESC LIMIT 1`).bind(id,userId,deployment.external_id).first<{request_id:string}>();
   return c.json({binding:row?await readFlyBindingReceipt(c.env.DB,userId,id,row.request_id):null});
  }catch(error){return failure(c,error);}
 });
 return routes;
}
