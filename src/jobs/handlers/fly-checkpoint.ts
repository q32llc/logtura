import {validateFlyRuntimeVolume,planFlyReplacement,flyRollbackConfig,FLY_RUNTIME_DIRECTORY} from "@logtura/core";
import {selectManagedForwarder} from "../../managed-machine-inventory";
import {readManagedInstall} from "../../managed-installations";
import {prepareManagedCheckpoint,executeManagedCheckpoint} from "../../managed-checkpoints";
import {readConfigurationVersion} from "../../config-version";
import {loadDischargedAuth,managedClient} from "./fly-deploy";
import type {JobHandlerCtx} from "../queue";
import type {FlyCreateOrUpdateMachinePayload} from "../types";

/** Storage gets its own bounded queue invocation, before issuing any instance. */
export async function runFlyEnsureCheckpoint(ctx:JobHandlerCtx):Promise<Record<string,unknown>>{
 const p=ctx.job.payload as unknown as FlyCreateOrUpdateMachinePayload,userId=ctx.job.userId,deploymentId=p.parentPayload.deploymentId;
 const prior=await readManagedInstall(ctx.env,userId,deploymentId);
 if(prior){
  if(prior.app!==p.appName || prior.org!==p.orgSlug || prior.region!==p.region)throw new Error("Managed retained installation target changed");
  await ctx.enqueueSibling({kind:"fly_deploy.create_or_update_machine",payload:{...p,installationId:prior.id}});return {installationId:prior.id,recovery:true};
 }
 await ctx.progress({label:"Preparing persistent runtime storage"});
 const client=managedClient(await loadDischargedAuth(ctx.env,userId,p.parentPayload),ctx.signal);
 if((await client.app(p.appName)).organization.slug!==p.orgSlug)throw new Error("Managed Fly organization does not match the checkpoint target");
 const machine=await selectManagedForwarder(ctx.env,userId,deploymentId,p.appName,await client.machines(p.appName));
 if(machine && machine.region!==p.region)throw new Error("Managed checkpoint region differs from the existing machine");
 let volumeId:string;
 const mounts=machine?.config.mounts;
 if(machine && Array.isArray(mounts) && mounts.some(mount=>mount?.path===FLY_RUNTIME_DIRECTORY)){
  volumeId=validateFlyRuntimeVolume(machine,await client.volumes(p.appName));
 }else{
  if(machine){
   // Validate the replacement shape before provisioning billable storage. This
   // synthetic reservation is only a read-only preflight; it is never persisted
   // or passed to the provider. Actual storage is independently reconciled below.
   const volume="vol_preflight";
   planFlyReplacement({id:crypto.randomUUID(),app:p.appName,org:p.orgSlug,machine,config:{...machine.config,image:flyRollbackConfig(machine).image,mounts:[{path:FLY_RUNTIME_DIRECTORY,volume}]},volume,volumes:[{id:volume,region:p.region,state:"created",encrypted:true,attached_machine_id:null}]});
  }
  const reservation=await prepareManagedCheckpoint(ctx.env,{userId,deploymentId,app:p.appName,org:p.orgSlug,region:p.region,configurationVersion:await readConfigurationVersion(ctx.env.DB,userId)});
  volumeId=(await executeManagedCheckpoint(ctx.env,reservation,client,ctx.signal)).id;
 }
 await ctx.enqueueSibling({kind:"fly_deploy.create_or_update_machine",payload:{...p,volumeId}});
 return {appName:p.appName,volumeId};
}
