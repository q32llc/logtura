import {validateFlyRuntimeVolume} from "@logtura/core";
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
 const machines=await client.machines(p.appName);
 if(machines.length>1 || (machines.length===1 && (machines[0] as {name?:string}).name!=="forwarder"))throw new Error("Managed checkpoint preparation requires one owned forwarder machine");
 let volumeId:string;
 if(machines.length){
  const machine=machines[0]!;
  if(machine.region!==p.region)throw new Error("Managed checkpoint region differs from the existing machine");
  volumeId=validateFlyRuntimeVolume(machine,await client.volumes(p.appName));
 }else{
  const reservation=await prepareManagedCheckpoint(ctx.env,{userId,deploymentId,app:p.appName,org:p.orgSlug,region:p.region,configurationVersion:await readConfigurationVersion(ctx.env.DB,userId)});
  volumeId=(await executeManagedCheckpoint(ctx.env,reservation,client,ctx.signal)).id;
 }
 await ctx.enqueueSibling({kind:"fly_deploy.create_or_update_machine",payload:{...p,volumeId}});
 return {appName:p.appName,volumeId};
}
