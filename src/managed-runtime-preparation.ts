import {createSecretVersioner,validateFlyRuntimeVolume,type FlyMachine,type FlyMachineConfig,type FlyMachinesClient} from "@logtura/core";
import {exportHostedManifest} from "./credential-intent";
import {issueDeploymentConfiguration,readDeploymentConfiguration} from "./deployment-configuration";
import {prepareIssuedManagedInstall} from "./managed-issued-installations";
import {readManagedCheckpoint} from "./managed-checkpoints";
import type {Env} from "./env";
import type {AssembledBundle} from "./bundle-assembly";
import type {FlyCreateOrUpdateMachinePayload} from "./jobs/types";

export async function prepareManagedRuntimeForQueue(env:Env,input:{userId:string;payload:FlyCreateOrUpdateMachinePayload;snapshot:{version:number;value:AssembledBundle};client:FlyMachinesClient;machine:FlyMachine|null;image:string;defaults:FlyMachineConfig}){
 const {payload:p,snapshot,machine,userId}=input,volumeId=p.volumeId!;
 const volumes=await input.client.volumes(p.appName);
 if(machine){validateFlyRuntimeVolume(machine,volumes,volumeId);}
 else {
  const reservation=await readManagedCheckpoint(env,userId,p.parentPayload.deploymentId),matches=volumes.filter(v=>v.id===volumeId),volume=matches[0];
  if(!reservation || reservation.phase!=="ready" || reservation.volumeId!==volumeId || reservation.app!==p.appName || reservation.org!==p.orgSlug || reservation.options.region!==p.region || matches.length!==1 || !volume?.encrypted || volume.state!=="created" || volume.region!==p.region || volume.attached_machine_id!==null)throw new Error("Managed checkpoint is not available for the new issued machine");
 }
 const assembled=snapshot.value,exported=await exportHostedManifest(assembled.input,assembled.credentialVersions,await createSecretVersioner(env.CREDENTIAL_ENCRYPTION_KEY));
 const state=await readDeploymentConfiguration(env.DB,userId,p.parentPayload.deploymentId);
 const issued=await issueDeploymentConfiguration(env.DB,userId,p.parentPayload.deploymentId,snapshot.version,state?.desired.sequence??0,exported.document);
 const base:FlyMachineConfig={...machine?.config,image:input.image,guest:machine?.config.guest??input.defaults.guest,checks:{...(machine?.config.checks as Record<string,unknown>??{}),...(input.defaults.checks as Record<string,unknown>)}};
 return prepareIssuedManagedInstall(env,{userId,deploymentId:p.parentPayload.deploymentId,app:p.appName,org:p.orgSlug,region:p.region,configurationVersion:issued.configurationVersion,base,machine,volume:volumeId,service:env.APP_URL,document:exported.document,env:exported.secretValues,providers:assembled.input.providers,destinations:assembled.input.destinations});
}
