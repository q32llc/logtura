import {Hono,type Context} from "hono";
import {isInstanceId} from "@logtura/core";
import type {AppContext} from "./env";
import {getDeployment,getDeployTargetById} from "./db";
import {readManagedRollback,prepareManagedRollback,ManagedRollbackError,type ManagedRollback} from "./managed-rollbacks";
import {readConfigurationVersion,ConfigurationConflict} from "./config-version";
import {JobDriver} from "./jobs/driver";
import {lockKeyForFlyDeploy,type JobRecord} from "./jobs/types";
function summary(r:ManagedRollback){return {id:r.id,replacementId:r.replacementId,status:r.status,phase:r.state.phase,oldMachineId:r.state.plan.before.id,candidateMachineId:r.state.machineId};}
async function body(c:Context<AppContext>){
 const reader=c.req.raw.body?.getReader();if(!reader)throw new ManagedRollbackError("invalid_rollback_request");
 const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>1024){await reader.cancel();throw new Error();}chunks.push(part.value);}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>;}catch{throw new ManagedRollbackError("invalid_rollback_request");}
}
function failure(c:Context<AppContext>,error:unknown){
 if(error instanceof ConfigurationConflict)return c.json({error:"configuration_changed",configurationVersion:error.currentVersion},409);
 if(error instanceof ManagedRollbackError)return c.json({error:error.code},error.code==="invalid_rollback_request"?400:error.code==="rollback_not_found"?404:error.code==="invalid_encrypted_rollback"?503:409);
 return c.json({error:"rollback_unavailable"},503);
}
export function managedRollbackRoutes(publicJob:(driver:JobDriver,job:JobRecord)=>Promise<Record<string,unknown>>){
 const routes=new Hono<AppContext>();routes.use("/deployments/:id/rollback",async(c,next)=>{c.header("cache-control","no-store");await next();});
 routes.get("/deployments/:id/rollback",async c=>{
  try{
   const userId=c.get("user")!.id,deploymentId=c.req.param("id"),deployment=await getDeployment(c.env.DB,userId,deploymentId);
   if(!deployment)return c.json({error:"not_found"},404);
   const rollback=await readManagedRollback(c.env,userId,deploymentId);
   const available=deployment.managed && deployment.target_kind==="fly"?await c.env.DB.prepare("SELECT id FROM managed_installations WHERE deployment_id=? AND user_id=? AND phase!='obsolete' AND replacement_phase IN ('creating','created','switching','installed') ORDER BY created_at DESC LIMIT 1").bind(deploymentId,userId).first<{id:string}>():null;
   return c.json({rollback:rollback?summary(rollback):null,availableReplacementId:rollback?.status==="pending"?rollback.replacementId:available?.id??null,configurationVersion:await readConfigurationVersion(c.env.DB,userId)});
  }catch(error){return failure(c,error);}
 });
 routes.post("/deployments/:id/rollback",async c=>{
  try{
   const userId=c.get("user")!.id,deploymentId=c.req.param("id"),value=await body(c);
   if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==3 || !isInstanceId(value.replacementId) || typeof value.deployTargetId!=="string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.deployTargetId) || !Number.isSafeInteger(value.configurationVersion) || (value.configurationVersion as number)<0)throw new ManagedRollbackError("invalid_rollback_request");
   const target=await getDeployTargetById(c.env.DB,userId,value.deployTargetId);
   if(!target || target.kind!=="fly")return c.json({error:"deploy_target_not_found"},404);
   const driver=new JobDriver(c.env.DB,c.env.JOBS_QUEUE),lockKey=lockKeyForFlyDeploy(deploymentId),active=await driver.activeForLockKey(lockKey);
   if(active && active.kind!=="fly_rollback")throw new ManagedRollbackError("deployment_busy");
   if(active){const saved=await readManagedRollback(c.env,userId,deploymentId,active.payload.rollbackId as string);if(saved?.replacementId!==value.replacementId || active.payload.deployTargetId!==target.id)throw new ManagedRollbackError("deployment_busy");return c.json({job:await publicJob(driver,active),deduped:true,rollback:summary(saved)});}
   const rollback=await prepareManagedRollback(c.env,{userId,deploymentId,replacementId:value.replacementId,configurationVersion:value.configurationVersion as number});
   const {job,deduped}=await driver.enqueue({userId,kind:"fly_rollback",lockKey,payload:{deploymentId,deployTargetId:target.id,rollbackId:rollback.id,deadline:Date.now()+300_000}});
   if(job.kind!=="fly_rollback")throw new ManagedRollbackError("deployment_busy");
   return c.json({job:await publicJob(driver,job),deduped,rollback:summary(rollback)});
  }catch(error){return failure(c,error);}
 });return routes;
}
