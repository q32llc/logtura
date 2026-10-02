import { assertNoPendingActivation } from "./file-transaction";
import { existsSync,lstatSync,readFileSync,writeFileSync,renameSync,linkSync,rmSync,openSync,fsyncSync,closeSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalConfigJson,normalizeDeploymentManifest,parseDeploymentManifest,hashConfigDocument,createSecretVersioner,normalizeServiceUrl,isDeploymentPushRequestId,ServiceError,type DeploymentManifest,type DeploymentConfigPush,type DeploymentConfigCommit,type LogturaServiceClient,type SecretReference } from "@logtura/core";
import { readDeploymentLink,validateDeploymentLink,createDeploymentLink,manifestReferences,privateFingerprint,type DeploymentLink } from "./deployment-link";
import { readConfigDoc,readConfigEnvironment } from "./config";
import { writePulledConfig } from "./pull";
import { assertTransactionClear,pendingPushPath } from "./file-transaction";
import { withPushLock } from "./push-lock";
export interface PendingPush {schemaVersion:1;config:string;link:DeploymentLink;request:DeploymentConfigPush & {requestId:string};snapshot:{revision:string;fingerprints:Record<string,string>};rejected?:boolean;}
function references(doc:DeploymentManifest):SecretReference[]{return [...doc.connections.flatMap(c=>[c.credentials,...c.selectedSources.map(s=>s.metadata)]),...doc.monitors.flatMap(m=>m.sinks.map(s=>s.destinationConfig)),...(doc.metrics?.kind==="destination"?[doc.metrics.destinationConfig]:[]),doc.runtimeEnv].filter((ref):ref is SecretReference=>ref!==null);}
function purposes(doc:DeploymentManifest):Map<string,string>{
 const found=new Map<string,string[]>(),add=(ref:SecretReference|null,purpose:string)=>{if(ref)found.set(ref.env,[...(found.get(ref.env)??[]),purpose]);};
 for(const c of doc.connections){add(c.credentials,`connection:${c.connection.id}:${c.connection.provider}`);for(const s of c.selectedSources)add(s.metadata,`source:${c.connection.id}:${s.sourceKind}:${s.externalId}`);}
 for(const m of doc.monitors)for(const s of m.sinks)add(s.destinationConfig,`destination:${s.destination.id}`);
 if(doc.metrics?.kind==="destination")add(doc.metrics.destinationConfig,`destination:${doc.metrics.destination.id}`);add(doc.runtimeEnv,"runtime");return new Map([...found].map(([name,values])=>[name,canonicalConfigJson([...new Set(values)].sort())]));
}
export async function prepareDeploymentPush(path:string,link:DeploymentLink,uploadSecrets=false):Promise<PendingPush>{
 if(link.desiredSequence>=Number.MAX_SAFE_INTEGER)throw new Error("Deployment sequence cannot be advanced");
 const original=normalizeDeploymentManifest(readConfigDoc(path)),document=structuredClone(original) as unknown as DeploymentManifest,env=readConfigEnvironment(path),parsed=parseDeploymentManifest(document,{env});
 if(parsed.missingEnv.length)throw new Error("Push requires all referenced private payloads");
 const baseline=manifestReferences(link.document),oldPurposes=purposes(link.document),newPurposes=purposes(document),secretValues:Record<string,string>={},fingerprints:Record<string,string>={};
 const versioner=await createSecretVersioner(link.privateKey);
 for(const [name,ref] of manifestReferences(document)){
  const value=canonicalConfigJson(JSON.parse(env[name]!)),fingerprint=privateFingerprint(link.privateKey,name,value),old=baseline.get(name);fingerprints[name]=fingerprint;
  const changed=!old || fingerprint!==link.fingerprints[name] || ref.version!==old.version || newPurposes.get(name)!==oldPurposes.get(name);
  if(changed){if(!uploadSecrets)throw new Error("Private references changed; pass --upload-secrets to authorize only changed payloads");
   for(const c of document.connections)if(c.credentials?.env===name && ((c.connection.provider==="supabase-edge-logs" && (parsed.input.connections.find(i=>i.connection.id===c.connection.id)!.credentials!.tailToken!==undefined || parsed.input.connections.find(i=>i.connection.id===c.connection.id)!.credentials!.tailTokenUrl!==undefined)) || (c.connection.provider==="railway-logs" && String(parsed.input.connections.find(i=>i.connection.id===c.connection.id)!.credentials!.apiToken).includes("/api/tail/railway/token#"))))throw new Error("Changed OAuth broker credentials require raw grant values or a fresh website pull");
   secretValues[name]=value;const version=await versioner(name,value);for(const item of references(document))if(item.env===name)item.version=version;
  }
 }
 return {schemaVersion:1,config:resolve(path),link,request:{document,expectedConfigurationVersion:link.configurationVersion,expectedSequence:link.desiredSequence,requestId:randomUUID(),...(Object.keys(secretValues).length?{uploadSecrets:true,secretValues}:{})},snapshot:{revision:await hashConfigDocument(original),fingerprints}};
}
function sync(path:string):void{const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncParent(path:string):void{if(process.platform!=="win32")sync(dirname(path));}
function savePending(path:string,pending:PendingPush,initial=false):void{
 const file=pendingPushPath(path),stage=`${file}.${randomUUID()}.tmp`;
 try{writeFileSync(stage,JSON.stringify(pending)+"\n",{flag:"wx",mode:0o600});sync(stage);if(initial)linkSync(stage,file);else renameSync(stage,file);}finally{rmSync(stage,{force:true});}
 syncParent(file);
}
export async function readPendingPush(path:string):Promise<PendingPush|null>{
 const file=pendingPushPath(path);if(!existsSync(file))return null;if(!lstatSync(file).isFile())throw new Error("Pending push must be a regular private file");
 try{
 const pending=JSON.parse(readFileSync(file,"utf8")) as PendingPush;
 if(!pending || pending.schemaVersion!==1 || pending.config!==resolve(path) || Object.keys(pending).some(k=>!["schemaVersion","config","link","request","snapshot","rejected"].includes(k)) || (pending.rejected!==undefined && typeof pending.rejected!=="boolean"))throw new Error();
 pending.link=await validateDeploymentLink(pending.link);const request=pending.request;
 if(!request || !isDeploymentPushRequestId(request.requestId) || request.expectedConfigurationVersion!==pending.link.configurationVersion || request.expectedSequence!==pending.link.desiredSequence || Object.keys(request).some(k=>!["document","requestId","expectedConfigurationVersion","expectedSequence","uploadSecrets","secretValues"].includes(k)))throw new Error();
 normalizeDeploymentManifest(request.document);if(request.uploadSecrets!==undefined && request.uploadSecrets!==true)throw new Error();
 const names=parseDeploymentManifest(request.document).requiredEnv;
 if(request.secretValues!==undefined && (!request.uploadSecrets || !request.secretValues || typeof request.secretValues!=="object" || Array.isArray(request.secretValues) || Object.keys(request.secretValues).some(name=>!names.includes(name)) || Object.values(request.secretValues).some(value=>typeof value!=="string" || !value)))throw new Error();
 parseDeploymentManifest(request.document,{env:request.secretValues});
 if(!pending.snapshot || !/^sha256:[a-f0-9]{64}$/.test(pending.snapshot.revision) || !pending.snapshot.fingerprints || typeof pending.snapshot.fingerprints!=="object" || Array.isArray(pending.snapshot.fingerprints) || Object.keys(pending.snapshot).some(k=>!["revision","fingerprints"].includes(k)) || Object.keys(pending.snapshot.fingerprints).length!==names.length || names.some(name=>!Object.hasOwn(pending.snapshot.fingerprints,name) || !/^[a-f0-9]{64}$/.test(pending.snapshot.fingerprints[name]!)))throw new Error();
 for(const [name,value] of Object.entries(request.secretValues??{}))if(privateFingerprint(pending.link.privateKey,name,value)!==pending.snapshot.fingerprints[name])throw new Error();
 return pending;
 }catch{throw new Error("Invalid pending push; retain it for recovery");}
}
async function unchanged(path:string,pending:PendingPush):Promise<boolean>{
 const link=await readDeploymentLink(path);if(canonicalConfigJson(link)!==canonicalConfigJson(pending.link))return false;
 if(await hashConfigDocument(readConfigDoc(path))!==pending.snapshot.revision)return false;const env=readConfigEnvironment(path);
 return Object.entries(pending.snapshot.fingerprints).every(([name,fingerprint])=>env[name]!==undefined && privateFingerprint(pending.link.privateKey,name,env[name]!)===fingerprint);
}
function clearPending(path:string):void{rmSync(pendingPushPath(path));syncParent(pendingPushPath(path));}
export async function pushDeploymentConfig(client:LogturaServiceClient,path:string,options:{resume?:boolean;uploadSecrets?:boolean;acceptRemote?:boolean;force?:boolean}={}):Promise<{requestId:string;result:DeploymentConfigCommit;acceptedRemote:boolean}>{
 assertTransactionClear(path);
 return withPushLock(path,async()=>{
  assertNoPendingActivation(path);
  let pending=await readPendingPush(path);
  if((options.resume===true)!==!!pending)throw new Error(pending?"Pending push; pass --resume":"No pending push to resume");
  const link=pending?.link??await readDeploymentLink(path);if(!link)throw new Error("Pull a hosted deployment before pushing");
  if(client.url!==normalizeServiceUrl(link.service))throw new Error("Push service does not match the linked origin");
  if((await client.whoami()).id!==link.accountId)throw new Error("Push account does not match the linked account");
  if((options.acceptRemote || options.force) && (!options.resume || !options.acceptRemote))throw new Error("Accepting remote state/forcing local replacement requires --resume --accept-remote");
  if(!pending){pending=await prepareDeploymentPush(path,link,options.uploadSecrets);savePending(path,pending,true);}
  const receipt=await client.getDeploymentPushReceipt(link.deployment.id,pending.request.requestId);
  let result=receipt?.result;
  if(options.acceptRemote && !result && !pending.rejected)throw new Error("Push outcome is uncertain; retry --resume before accepting remote state");
  if(!result && !options.acceptRemote){
   try{result=await client.pushDeploymentConfig(link.deployment.id,pending.request);}catch(error){if(error instanceof ServiceError && [400,409].includes(error.status)){pending.rejected=true;savePending(path,pending);}throw error;}
  }
  let advanced=false;
  if(result && !options.force){
   const current=await readDeploymentLink(path);
   if(current?.service===link.service && current.accountId===link.accountId && current.deployment.id===link.deployment.id && current.configurationVersion===result.configurationVersion && current.desiredSequence===result.sequence && current.revision===result.revision && canonicalConfigJson(current.document)===canonicalConfigJson(result.document) && await hashConfigDocument(readConfigDoc(path))===result.revision){
    const env=readConfigEnvironment(path);if(Object.entries(current.fingerprints).every(([name,hash])=>env[name]!==undefined && privateFingerprint(current.privateKey,name,env[name]!)===hash)){advanced=true;if(!options.acceptRemote){clearPending(path);return {requestId:pending.request.requestId,result,acceptedRemote:false};}}
   }
  }
  if(!options.force && !advanced && !await unchanged(path,pending))throw new Error("Local configuration changed during push; retain pending request and reconcile before replacement");
  const exported=await client.pullDeploymentConfig(link.deployment.id,true);
  if(!options.acceptRemote && (!result || exported.configurationVersion!==result.configurationVersion || exported.desiredSequence!==result.sequence || exported.revision!==result.revision))throw new Error("Remote configuration changed after commit; inspect it or resume with --accept-remote");
  const next=await createDeploymentLink(link.service,link.accountId,exported);
  await writePulledConfig(exported,path,true,next,pending.request.requestId);
  clearPending(path);
  return {requestId:pending.request.requestId,result:options.acceptRemote?{configurationVersion:next.configurationVersion,sequence:next.desiredSequence,revision:next.revision,document:next.document,sourceAliases:{}}:result!,acceptedRemote:options.acceptRemote===true};
 });
}
