import { canonicalConfigJson,generateBundle,hashConfigDocument,type GenerateInput,type DeploymentManifest,type SecretVersioner } from "@logtura/core";
import { exportHostedManifest } from "./credential-intent";
import { getDeployment } from "./db";
import type { Env } from "./env";
import { encryptSecret,newToken } from "./crypto";
import { compileGraphMutations,prepareGraphReconciliation } from "./graph-reconciliation";
import { compileDeploymentSelection,orderedSelectionFromInput } from "./deployment-selection";
import { compileDeploymentRevision,DeploymentRevisionConflict,readDeploymentConfiguration } from "./deployment-configuration";
import { commitConfiguration } from "./config-version";
import { readDeploymentRuntime } from "./deployment-runtime";
import { getProvider,listProviders } from "./providers";
import { getDestinationDriver,listDestinationDrivers } from "./destinations";
export interface ReconciledDeploymentConfiguration {
  configurationVersion:number;sequence:number;revision:string;document:DeploymentManifest;sourceAliases:Record<string,string>;
}
/** Internal transaction boundary, not an HTTP authorization or secret-transfer
 * policy. Callers resolve raw storage credentials and authorize explicit uploads.
 * Runtime OAuth broker envelopes must never be supplied as stored credentials.
 * Inventory, selectors, reporting targets, encrypted runtime overrides and public
 * desired history commit together, or nothing changes. No provider I/O occurs. */
export async function reconcileDeploymentConfiguration(env:Env,userId:string,deploymentId:string,expectedVersion:number,expectedSequence:number,desired:GenerateInput,versioner:SecretVersioner,retainedCredentials?:Map<string,string>):Promise<ReconciledDeploymentConfiguration>{
  if(!Number.isSafeInteger(expectedSequence) || expectedSequence<0 || expectedSequence>=Number.MAX_SAFE_INTEGER)throw new Error("Invalid desired sequence");
  const deployment=await getDeployment(env.DB,userId,deploymentId);if(!deployment)throw new Error("Deployment not found");
  const {plan,inventory,credentialVersions}=await prepareGraphReconciliation(env,userId,expectedVersion,desired,retainedCredentials);
  const state=await readDeploymentConfiguration(env.DB,userId,deploymentId);if((state?.desired.sequence??0)!==expectedSequence)throw new DeploymentRevisionConflict();
  const input=plan.input;input.providers=listProviders();input.destinations=listDestinationDrivers();
  const providers=new Set<string>();
  for(const c of input.connections){
    if(typeof c.credentials?.refreshToken==="string" && ((c.connection.provider==="supabase-edge-logs" && (c.credentials.tailToken!==undefined || c.credentials.tailTokenUrl!==undefined)) || (c.connection.provider==="railway-logs" && typeof c.credentials.apiToken==="string" && c.credentials.apiToken.startsWith(`${env.APP_URL}/api/tail/railway/token#`))))throw new Error("Resolve raw stored credentials before deployment reconciliation");
    const provider=getProvider(c.connection.provider);if(!provider)throw new Error("Unknown deployment provider");
    if(providers.has(provider.id))throw new Error("Only one connection per provider is supported");providers.add(provider.id);
    if(c.selectAll && provider.capabilities.selection!=="all" && provider.capabilities.selection!=="both")throw new Error("Provider does not support all-source selection");
  }
  for(const m of input.monitors)for(const s of m.sinks){const driver=getDestinationDriver(s.destination.kind);if(!driver || !driver.flows.includes("logs"))throw new Error("Unsupported log destination");}
  if(input.metrics?.kind==="destination"){const driver=getDestinationDriver(input.metrics.destination.kind);if(!driver || !driver.flows.includes("metrics"))throw new Error("Unsupported metrics destination");}
  for(const target of [input.heartbeat,input.metrics])if(target?.kind==="logtura" && (target.deploymentId!==deploymentId || target.appUrl!==env.APP_URL))throw new Error("Invalid deployment reporting scope");
  const token=deployment.heartbeat_token??newToken();
  const runtime={...input.runtimeEnv};
  const reporting:Record<string,string>={LOGTURA_HEARTBEAT_TOKEN:token,LOGTURA_METRICS_TOKEN:token,LOGTURA_HEARTBEAT_URL:`${env.APP_URL}/api/heartbeat/${deploymentId}`,LOGTURA_METRICS_URL:`${env.APP_URL}/api/metrics/${deploymentId}`};
  for(const [name,value] of Object.entries(reporting)){if(runtime[name]!==undefined && runtime[name]!==value)throw new Error("Invalid deployment reporting credential");delete runtime[name];}
  const oldRuntime=await readDeploymentRuntime(env,deployment.runtime_env_encrypted);
  for(const name of Object.keys(reporting))delete oldRuntime[name];
  const runtimeChanged=canonicalConfigJson(runtime)!==canonicalConfigJson(oldRuntime);
  input.runtimeEnv={...runtime,LOGTURA_HEARTBEAT_TOKEN:token,LOGTURA_METRICS_TOKEN:token};
  input.heartbeat={kind:input.heartbeat?.kind??"none",deploymentId,appUrl:env.APP_URL};input.metrics??={kind:"none"};
  generateBundle(input); // Validate the actual trusted registry/render graph before writes.
  for(const c of plan.connections){
    const stored=inventory.connections.find(old=>old.connection.id===c.connection.id);
    if(!stored || canonicalConfigJson(stored.credentials)!==canonicalConfigJson(c.credentials))credentialVersions.set(c.connection.id,newToken());
  }
  const selection=orderedSelectionFromInput(input),exported=await exportHostedManifest(input,credentialVersions,versioner),revision=await hashConfigDocument(exported.document);
  const heartbeat=input.heartbeat.kind,metrics=input.metrics.kind==="destination"?input.metrics.destination.id:input.metrics.kind;
  const graphChanges=plan.connections.length+plan.sources.length+plan.destinations.length+plan.monitors.length+plan.sinks.length+plan.removeSinkIds.length;
  const unchanged=state && state.desired.configurationVersion===expectedVersion && state.desired.revision===revision && graphChanges===0 && !runtimeChanged && deployment.graph_selection_json===canonicalConfigJson(selection) && deployment.heartbeat_target===heartbeat && (deployment.metrics_target??"none")===metrics && deployment.heartbeat_token===token;
  if(unchanged){await commitConfiguration(env.DB,userId,expectedVersion,[]);return {configurationVersion:expectedVersion,sequence:state.desired.sequence,revision,document:exported.document,sourceAliases:plan.sourceAliases};}
  const statements=await compileGraphMutations(env,userId,plan,inventory,credentialVersions);
  statements.push(...compileDeploymentSelection(env.DB,userId,deploymentId,selection));
  const encrypted=runtimeChanged?(Object.keys(runtime).length===0?null:await encryptSecret(canonicalConfigJson(runtime),env.CREDENTIAL_ENCRYPTION_KEY)):deployment.runtime_env_encrypted??null;
  statements.push(env.DB.prepare(`UPDATE deployments SET heartbeat_target=?,metrics_target=?,heartbeat_token=?,runtime_env_encrypted=?,updated_at=?,bundle_outdated=1
    WHERE id=? AND user_id=? AND (heartbeat_target IS NOT ? OR metrics_target IS NOT ? OR heartbeat_token IS NOT ? OR runtime_env_encrypted IS NOT ?)`)
    .bind(heartbeat,metrics,token,encrypted,Date.now(),deploymentId,userId,heartbeat,metrics,token,encrypted));
  const sequence=expectedSequence+1,compiled=await compileDeploymentRevision(env.DB,userId,deploymentId,sequence,exported.document);
  statements.push(...compiled.statements);
  let configurationVersion:number;
  try{configurationVersion=(await commitConfiguration(env.DB,userId,expectedVersion,statements)).version;}
  catch(error){if(error instanceof Error && error.message.includes("LOGT_REVISION_CONFLICT"))throw new DeploymentRevisionConflict();throw error;}
  return {configurationVersion,sequence,revision:compiled.revision,document:compiled.document,sourceAliases:plan.sourceAliases};
}
