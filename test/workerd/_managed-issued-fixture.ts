import {env} from "cloudflare:test";
import {createSecretVersioner,exportDeploymentManifest,type FlyMachineConfig} from "@logtura/core";
import {railwayLogsDriver} from "@logtura/driver-railway-logs";
import {createConnection,createDeployment} from "../../src/db";
import {readConfigurationVersion} from "../../src/config-version";
import {issueDeploymentConfiguration,readDeploymentConfiguration} from "../../src/deployment-configuration";
import {prepareIssuedManagedInstall} from "../../src/managed-issued-installations";
import {seedUser,seedDeployTarget} from "./_setup";
const image=`registry.test/forwarder@sha256:${"a".repeat(64)}`;
export async function managedIssuedFixture(issue=true){
 const {userId}=await seedUser(),target=await seedDeployTarget({userId,kind:"fly",displayName:"Fly",externalAccountId:"personal",credentials:{apiToken:"fo1_fixture"}}),connection=await createConnection(env.DB,env,{userId,provider:"railway-logs",displayName:"Source",externalAccountId:"project:production",credentials:{apiToken:"private-source-token"}}),deployment=await createDeployment(env.DB,{userId,connectionId:connection.id,deployTargetId:target.id,targetKind:"fly",displayName:"Managed",managed:true});
 const exported=await exportDeploymentManifest({providers:[railwayLogsDriver],destinations:[],monitors:[],connections:[{connection:{id:connection.id,provider:railwayLogsDriver.id,displayName:"Source",externalAccountId:"project:production"},credentials:{apiToken:"private-source-token"},selectedSources:[{id:"source",externalId:"service",displayName:"App",sourceKind:"railway_service",metadata:{environment_id:"production",service_id:"service"}}]}],heartbeat:{kind:"logtura",deploymentId:deployment.id,appUrl:env.APP_URL},runtimeEnv:{LOGTURA_HEARTBEAT_TOKEN:deployment.heartbeat_token}},await createSecretVersioner("fixture"));
 let version=await readConfigurationVersion(env.DB,userId);if(issue)version=(await issueDeploymentConfiguration(env.DB,userId,deployment.id,version,0,exported.document)).configurationVersion;
 const input={userId,deploymentId:deployment.id,app:"app",org:"personal",region:"ord",configurationVersion:version,base:{image,guest:{cpu_kind:"shared",cpus:2,memory_mb:4096}} as FlyMachineConfig,machine:null,volume:"vol_checkpoint",service:env.APP_URL,document:exported.document,env:exported.secretValues,providers:[railwayLogsDriver],destinations:[]};
 return {userId,target,deployment,input,version,prepare:()=>prepareIssuedManagedInstall(env,input),state:()=>readDeploymentConfiguration(env.DB,userId,deployment.id)};
}
