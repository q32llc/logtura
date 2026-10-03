import {FlyReplacementCleanupPending} from "@logtura/core";
import {executeManagedCleanup,readManagedCleanup} from "../../managed-cleanups";
import {loadDischargedAuth,managedClient} from "./fly-deploy";
import type {JobHandlerCtx} from "../queue";
import type {FlyCleanupPayload} from "../types";
export async function runFlyCleanup(ctx:JobHandlerCtx):Promise<Record<string,unknown>>{
 const p=ctx.job.payload as unknown as FlyCleanupPayload;
 if(!p.deploymentId || !p.deployTargetId || !p.cleanupId || !Number.isSafeInteger(p.deadline) || p.deadline<0 || p.deadline>Date.now()+305000)throw new Error("Invalid managed cleanup job");
 const cleanup=await readManagedCleanup(ctx.env,ctx.job.userId,p.deploymentId,p.cleanupId);if(!cleanup)throw new Error("Managed cleanup is missing; retain it for recovery");
 if(cleanup.status==="pending" && Date.now()>=p.deadline)throw new Error("Managed cleanup deadline exceeded; retain it for recovery");
 await ctx.progress({label:"Removing retained forwarder"});const client=managedClient(await loadDischargedAuth(ctx.env,ctx.job.userId,p),ctx.signal);
 try{
  const result=await executeManagedCleanup(ctx.env,cleanup,client,ctx.signal);await ctx.events.record({kind:"fly_cleanup.completed",message:"Retained machine removed; survivor and checkpoint preserved",payload:{cleanupId:cleanup.id,...result}});return {cleanupId:cleanup.id,...result,retired:true};
 }catch(error){
  if(!(error instanceof FlyReplacementCleanupPending))throw error;
  if(Date.now()>=p.deadline)throw new Error("Managed cleanup deadline exceeded; retain it for recovery");
  await ctx.progress({label:"Observing retained machine removal"});await ctx.enqueueSibling({kind:"fly_cleanup",payload:{...p},delaySecs:5});return {cleanupId:cleanup.id,pending:true};
 }
}
