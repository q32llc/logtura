import { Hono,type Context } from "hono";
import { isInstanceId,validateDeploymentAppliedReport,validateDeploymentConfigurationState } from "@logtura/core";
import type { AppContext } from "./env";
import { getDeployment } from "./db";
import { ConfigurationConflict } from "./config-version";
import { readDeploymentConfiguration,acknowledgeDeploymentConfiguration } from "./deployment-configuration";
import { activateDeploymentWithReceipt,readDeploymentInstanceReceipt,DeploymentInstanceError } from "./deployment-instances";
/** Bound streamed input, regardless of a missing or dishonest Content-Length. */
async function jsonBody(c:Context<AppContext>):Promise<unknown>{
 const reader=c.req.raw.body?.getReader();if(!reader)throw new DeploymentInstanceError(400,"invalid_body");
 const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>8192){await reader.cancel();throw new DeploymentInstanceError(413,"body_too_large");}chunks.push(part.value);}}catch(error){if(error instanceof DeploymentInstanceError)throw error;throw new DeploymentInstanceError(400,"invalid_body");}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DeploymentInstanceError(400,"invalid_body");}
}
function failure(c:Context<AppContext>,error:unknown){
 if(error instanceof DeploymentInstanceError)return c.json({error:error.code},error.status);
 if(error instanceof ConfigurationConflict)return c.json({error:"configuration_changed",configurationVersion:error.currentVersion},409);
 return c.json({error:"configuration_unavailable"},503);
}
/** Mounted under account auth. Reporting tokens cannot issue/replace instances. */
export function deploymentStateRoutes(){
 const routes=new Hono<AppContext>();
 routes.get("/deployments/:id/config/state",async c=>{
  const user=c.get("user")!,id=c.req.param("id");
  try{if(!await getDeployment(c.env.DB,user.id,id))return c.json({error:"not_found"},404);
   const state=await readDeploymentConfiguration(c.env.DB,user.id,id);return c.json({state:state?await validateDeploymentConfigurationState(state):null});
  }catch(error){return failure(c,error);}
 });
 routes.post("/deployments/:id/config/instances",async c=>{
  try{return c.json(await activateDeploymentWithReceipt(c.env.DB,c.get("user")!.id,c.req.param("id"),await jsonBody(c)));}catch(error){return failure(c,error);}
 });
 routes.get("/deployments/:id/config/instances/:requestId",async c=>{
  try{const user=c.get("user")!,id=c.req.param("id"),requestId=c.req.param("requestId");
   if(!await getDeployment(c.env.DB,user.id,id))return c.json({error:"not_found"},404);
   if(!isInstanceId(requestId))return c.json({error:"invalid_request_id"},400);
   const receipt=await readDeploymentInstanceReceipt(c.env.DB,user.id,id,requestId);return receipt?c.json(receipt):c.json({error:"receipt_not_found"},404);
  }catch(error){return failure(c,error);}
 });
 return routes;
}
/** Fresh token lookup deliberately avoids the heartbeat cache: startup/config
 * reports are infrequent and must honor reporting-token rotation immediately. */
export function deploymentAppliedRoutes(){
 const routes=new Hono<AppContext>();
 routes.post("/applied/:id",async c=>{
  c.header("cache-control","no-store");
  const auth=c.req.header("authorization")??"",token=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
  if(!token)return c.json({error:"missing_token"},401);
  try{
   const id=c.req.param("id"),owned=await c.env.DB.prepare("SELECT id FROM deployments WHERE id=? AND heartbeat_token=?").bind(id,token).first();
   if(!owned)return c.json({error:"invalid_token"},401);
   let report;try{report=validateDeploymentAppliedReport(await jsonBody(c));}catch(error){if(error instanceof DeploymentInstanceError)throw error;throw new DeploymentInstanceError(400,"invalid_report");}
   return c.json({accepted:await acknowledgeDeploymentConfiguration(c.env.DB,id,report.instanceId,report.sequence,report.revision,report.reportSequence)});
  }catch(error){return failure(c,error);}
 });
 return routes;
}
