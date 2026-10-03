import {Hono,type Context} from "hono";
import {isInstanceId} from "@logtura/core";
import type {AppContext} from "./env";
import {getDeployment,getDeployTargetById} from "./db";
import {readManagedCleanup,prepareManagedCleanup,ManagedCleanupError,type ManagedCleanup} from "./managed-cleanups";
import {readConfigurationVersion,ConfigurationConflict} from "./config-version";
import {JobDriver} from "./jobs/driver";
import {loadDischargedAuth,managedClient} from "./jobs/handlers/fly-deploy";
import {lockKeyForFlyDeploy,type JobRecord} from "./jobs/types";
function summary(c:ManagedCleanup){return {id:c.id,replacementId:c.replacementId,status:c.status,phase:c.state.phase,survivorId:c.state.plan.survivor.id,retiredId:c.state.plan.retired.id};}
async function body(c:Context<AppContext>){
 const reader=c.req.raw.body?.getReader();if(!reader)throw new ManagedCleanupError("invalid_cleanup_request");const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>1024){await reader.cancel();throw new Error();}chunks.push(part.value);}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>;}catch{throw new ManagedCleanupError("invalid_cleanup_request");}
}
function failure(c:Context<AppContext>,error:unknown){
 if(error instanceof ConfigurationConflict)return c.json({error:"configuration_changed",configurationVersion:error.currentVersion},409);
 if(error instanceof ManagedCleanupError)return c.json({error:error.code},error.code==="invalid_cleanup_request"?400:error.code==="cleanup_not_found"?404:error.code==="invalid_encrypted_cleanup"?503:409);
 if(error instanceof Error && /LOGT_CLEANUP_(ACTIVE|CONFLICT)/.test(error.message))return c.json({error:"cleanup_changed"},409);
 return c.json({error:"cleanup_unavailable"},503);
}
export function managedCleanupRoutes(publicJob:(driver:JobDriver,job:JobRecord)=>Promise<Record<string,unknown>>){
 const routes=new Hono<AppContext>();routes.use("/deployments/:id/cleanup",async(c,next)=>{c.header("cache-control","no-store");await next();});
 routes.get("/deployments/:id/cleanup",async c=>{
  try{
   const userId=c.get("user")!.id,deploymentId=c.req.param("id"),deployment=await getDeployment(c.env.DB,userId,deploymentId);if(!deployment)return c.json({error:"not_found"},404);
   const cleanup=await readManagedCleanup(c.env,userId,deploymentId),available=deployment.managed && deployment.target_kind==="fly"?await c.env.DB.prepare(`SELECT i.id FROM managed_installations i WHERE i.deployment_id=? AND i.user_id=? AND i.replacement_phase IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM managed_cleanups c WHERE c.replacement_id=i.id)
    AND ((i.phase='completed' AND i.replacement_phase='installed') OR EXISTS (SELECT 1 FROM managed_rollbacks b WHERE b.replacement_id=i.id AND b.status='completed')) ORDER BY i.created_at DESC,i.id DESC LIMIT 1`).bind(deploymentId,userId).first<{id:string}>():null;
   return c.json({cleanup:cleanup?summary(cleanup):null,availableReplacementId:cleanup?.status==="pending"?cleanup.replacementId:available?.id??null,configurationVersion:await readConfigurationVersion(c.env.DB,userId)});
  }catch(error){return failure(c,error);}
 });
 routes.post("/deployments/:id/cleanup",async c=>{
  try{
   const userId=c.get("user")!.id,deploymentId=c.req.param("id"),value=await body(c);
   if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==4 || value.confirmRetirement!==true || !isInstanceId(value.replacementId) || typeof value.deployTargetId!=="string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.deployTargetId) || !Number.isSafeInteger(value.configurationVersion) || (value.configurationVersion as number)<0)throw new ManagedCleanupError("invalid_cleanup_request");
   const target=await getDeployTargetById(c.env.DB,userId,value.deployTargetId);if(!target || target.kind!=="fly")return c.json({error:"deploy_target_not_found"},404);
   const driver=new JobDriver(c.env.DB,c.env.JOBS_QUEUE),lockKey=lockKeyForFlyDeploy(deploymentId),active=await driver.activeForLockKey(lockKey);if(active && active.kind!=="fly_cleanup")throw new ManagedCleanupError("deployment_busy");
   if(active){const saved=await readManagedCleanup(c.env,userId,deploymentId,active.payload.cleanupId as string);if(saved?.replacementId!==value.replacementId || active.payload.deployTargetId!==target.id)throw new ManagedCleanupError("deployment_busy");return c.json({job:await publicJob(driver,active),deduped:true,cleanup:summary(saved)});}
   const payload={deploymentId,deployTargetId:target.id},signal=AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(60000)]),client=managedClient(await loadDischargedAuth(c.env,userId,payload),signal);
   const cleanup=await prepareManagedCleanup(c.env,{userId,deploymentId,replacementId:value.replacementId,configurationVersion:value.configurationVersion as number,client,signal});
   const {job,deduped}=await driver.enqueue({userId,kind:"fly_cleanup",lockKey,payload:{...payload,cleanupId:cleanup.id,deadline:Date.now()+300000}});if(job.kind!=="fly_cleanup")throw new ManagedCleanupError("deployment_busy");return c.json({job:await publicJob(driver,job),deduped,cleanup:summary(cleanup)});
  }catch(error){return failure(c,error);}
 });return routes;
}
