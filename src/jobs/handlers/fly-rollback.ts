import {FlyReplacementPending} from "@logtura/core";
import {executeManagedRollback,readManagedRollback} from "../../managed-rollbacks";
import {loadDischargedAuth,managedClient} from "./fly-deploy";
import type {JobHandlerCtx} from "../queue";
import type {FlyRollbackPayload} from "../types";
export async function runFlyRollback(ctx:JobHandlerCtx):Promise<Record<string,unknown>>{
 const p=ctx.job.payload as unknown as FlyRollbackPayload;
 if(!p.deploymentId || !p.deployTargetId || !p.rollbackId || !Number.isSafeInteger(p.deadline) || p.deadline<0 || p.deadline>Date.now()+305_000)throw new Error("Invalid managed rollback job");
 const rollback=await readManagedRollback(ctx.env,ctx.job.userId,p.deploymentId,p.rollbackId);
 if(!rollback)throw new Error("Managed rollback is missing; retain it for recovery");
 if(rollback.status==="pending" && Date.now()>=p.deadline)throw new Error("Managed rollback deadline exceeded; retain it for recovery");
 await ctx.progress({label:"Restoring previous forwarder"});
 const client=managedClient(await loadDischargedAuth(ctx.env,ctx.job.userId,p),ctx.signal);
 try{
  const machineId=await executeManagedRollback(ctx.env,rollback,client,ctx.signal);
  await ctx.events.record({kind:"fly_rollback.completed",message:"Previous forwarder restored; portable applied revision is unknown",payload:{rollbackId:rollback.id,machineId}});
  return {rollbackId:rollback.id,machineId,restored:true,appliedKnown:false};
 }catch(error){
  if(!(error instanceof FlyReplacementPending))throw error;
  if(Date.now()>=p.deadline)throw new Error("Managed rollback deadline exceeded; retain it for recovery");
  await ctx.progress({label:"Waiting for previous forwarder restoration"});
  await ctx.enqueueSibling({kind:"fly_rollback",payload:{...p},delaySecs:5});return {rollbackId:rollback.id,pending:true};
 }
}
