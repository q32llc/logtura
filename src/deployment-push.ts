import { canonicalConfigJson,manifestSecretName,createSecretVersioner,normalizeDeploymentManifest,parseDeploymentManifest,type SecretReference,type DeploymentConfigPush } from "@logtura/core";
import type { Env } from "./env";
import { ConfigurationConflict,readStableConfiguration } from "./config-version";
import { loadOwnedGraphInventory } from "./graph-reconciliation";
import { getDeployment } from "./db";
import { readDeploymentRuntime } from "./deployment-runtime";

export class DeploymentPushError extends Error{
  constructor(public readonly status:400|404|503,public readonly code:string){super(code);this.name="DeploymentPushError";}
}
/** This boundary accepts public references by default. Payload uploads must be
 * explicitly enabled and limited to references in the submitted manifest. */
export function parseDeploymentPush(value:unknown):DeploymentConfigPush{
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(k=>!["document","expectedConfigurationVersion","expectedSequence","uploadSecrets","secretValues"].includes(k)))throw new DeploymentPushError(400,"invalid_push");
  const body=value as DeploymentConfigPush;
  if(!Number.isSafeInteger(body.expectedConfigurationVersion) || body.expectedConfigurationVersion<0 || !Number.isSafeInteger(body.expectedSequence) || body.expectedSequence<0 || body.expectedSequence>=Number.MAX_SAFE_INTEGER || (body.uploadSecrets!==undefined && typeof body.uploadSecrets!=="boolean"))throw new DeploymentPushError(400,"invalid_push");
  try{normalizeDeploymentManifest(body.document);}catch{throw new DeploymentPushError(400,"invalid_manifest");}
  if(body.secretValues!==undefined){
    if(!body.uploadSecrets)throw new DeploymentPushError(400,"secret_upload_not_authorized");
    if(!body.secretValues || typeof body.secretValues!=="object" || Array.isArray(body.secretValues) || Object.values(body.secretValues).some(v=>typeof v!=="string" || !v))throw new DeploymentPushError(400,"invalid_secret_values");
    const required=new Set(parseDeploymentManifest(body.document).requiredEnv);
    if(Object.keys(body.secretValues).some(name=>!required.has(name)))throw new DeploymentPushError(400,"unreferenced_secret");
  }
  return body;
}
function oauth(provider:string,credentials:Record<string,unknown>|undefined):boolean{
  return (provider==="supabase-edge-logs" || provider==="railway-logs") && typeof credentials?.refreshToken==="string";
}
function broker(provider:string,value:unknown):boolean{
  if(!value || typeof value!=="object")return false;
  const c=value as Record<string,unknown>;
  return provider==="supabase-edge-logs" ? c.tailToken!==undefined || c.tailTokenUrl!==undefined : provider==="railway-logs" && typeof c.apiToken==="string" && c.apiToken.includes("/api/tail/railway/token#");
}
/** Resolve only this account's raw storage payloads. Unchanged OAuth references
 * resolve the latest renewed grant, never the exported runtime broker envelope.
 * A changed reference needs an authorized payload upload. Reusing a version for
 * an edited private value is rejected, so manual env changes cannot be lost. */
export async function resolveOwnedDeploymentManifest(env:Env,userId:string,deploymentId:string,body:DeploymentConfigPush){
  body=parseDeploymentPush(body);
  const versioner=await createSecretVersioner(env.CREDENTIAL_ENCRYPTION_KEY);
  const snapshot=await readStableConfiguration(env.DB,userId,async()=>{
    const deployment=await getDeployment(env.DB,userId,deploymentId);if(!deployment)throw new DeploymentPushError(404,"not_found");
    let graph:Awaited<ReturnType<typeof loadOwnedGraphInventory>>,runtime:Record<string,string>;
    try{graph=await loadOwnedGraphInventory(env,userId);runtime=await readDeploymentRuntime(env,deployment.runtime_env_encrypted);}catch(error){if(error instanceof ConfigurationConflict)throw error;throw new DeploymentPushError(503,"configuration_unavailable");}
    for(const name of ["LOGTURA_HEARTBEAT_TOKEN","LOGTURA_METRICS_TOKEN","LOGTURA_HEARTBEAT_URL","LOGTURA_METRICS_URL"])delete runtime[name];
    if(deployment.heartbeat_token){runtime.LOGTURA_HEARTBEAT_TOKEN=deployment.heartbeat_token;runtime.LOGTURA_METRICS_TOKEN=deployment.heartbeat_token;}
    return {graph,runtime};
  });
  if(snapshot.version!==body.expectedConfigurationVersion)throw new ConfigurationConflict(body.expectedConfigurationVersion,snapshot.version);
  const {graph,runtime}=snapshot.value,values:Record<string,string>=Object.create(null),retainedCredentials=new Map<string,string>();
  const resolve=async(ref:SecretReference,candidate:unknown,identity:string|undefined,provider:string|undefined,ownedName:boolean)=>{
    const supplied=body.secretValues && Object.hasOwn(body.secretValues,ref.env)?body.secretValues[ref.env]:undefined;
    let uploaded:unknown;
    if(supplied!==undefined){try{uploaded=JSON.parse(supplied);}catch{throw new DeploymentPushError(400,"invalid_secret_values");}}
    const encoded=candidate===undefined?undefined:canonicalConfigJson(candidate);
    const matches=ownedName && encoded!==undefined && await versioner(ref.env,identity===undefined?encoded:canonicalConfigJson({credentialIntent:identity}))===ref.version;
    let resolved:string;
    if(matches){
      if(supplied!==undefined && canonicalConfigJson(uploaded)!==encoded && !(provider && identity && broker(provider,uploaded)))throw new DeploymentPushError(400,"secret_revision_required");
      resolved=encoded!;
    }else{
      if(supplied===undefined)throw new DeploymentPushError(400,"secret_required");
      if(provider && broker(provider,uploaded))throw new DeploymentPushError(400,"raw_credentials_required");
      resolved=canonicalConfigJson(uploaded);
    }
    if(values[ref.env]!==undefined && values[ref.env]!==resolved)throw new DeploymentPushError(400,"conflicting_secret_reference");
    values[ref.env]=resolved;
    return matches;
  };
  const doc=body.document;
  for(const c of doc.connections){
    const stored=graph.value.connections.find(owned=>owned.connection.id===c.connection.id);
    if(c.credentials && await resolve(c.credentials,stored?.credentials,stored && oauth(stored.connection.provider,stored.credentials)?graph.credentialVersions.get(c.connection.id):undefined,c.connection.provider,c.credentials.env===manifestSecretName("CREDENTIALS",c.connection.id)))retainedCredentials.set(c.connection.id,graph.credentialVersions.get(c.connection.id)!);
    for(const s of c.selectedSources)if(s.metadata){
      const owned=graph.value.sources.find(owned=>owned.connectionId===c.connection.id && owned.source.sourceKind===s.sourceKind && owned.source.externalId===s.externalId);
      await resolve(s.metadata,owned?.source.metadata,undefined,undefined,owned!==undefined && s.metadata.env===manifestSecretName("SOURCE",owned.source.id));
    }
  }
  const destination=async(id:string,ref:SecretReference)=>resolve(ref,graph.value.destinations.find(d=>d.destination.id===id)?.config,undefined,undefined,ref.env===manifestSecretName("METRICS",id) || graph.value.sinks.some(s=>s.destinationId===id && ref.env===manifestSecretName("DESTINATION",s.sink.id)));
  for(const m of doc.monitors)for(const s of m.sinks)await destination(s.destination.id,s.destinationConfig);
  if(doc.metrics?.kind==="destination")await destination(doc.metrics.destination.id,doc.metrics.destinationConfig);
  if(doc.runtimeEnv)await resolve(doc.runtimeEnv,runtime,undefined,undefined,doc.runtimeEnv.env===manifestSecretName("RUNTIME","ENV"));
  try{return {input:parseDeploymentManifest(doc,{env:values}).input,retainedCredentials};}catch{throw new DeploymentPushError(400,"invalid_manifest_payload");}
}
