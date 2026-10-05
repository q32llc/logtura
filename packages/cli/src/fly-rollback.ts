import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,linkSync,renameSync,rmSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {canonicalConfigJson,hashConfigDocument,validateFlyReplacementState,validateFlyRollbackRequest,validateFlyRollbackReceipt,validateFlyRollbackRebaseRequest,validateFlyRollbackFence,executeFlyReplacement,FlyReplacementPending,matchesFlyConfig,flyRollbackConfig,isInstanceId,type FlyReplacementState,type FlyRollbackRequest,type FlyRollbackReceipt,type FlyRollbackRebaseRequest,type FlyRollbackFence,type LogturaServiceClient,type FlyMachinesClient} from "@logtura/core";
import {readDeploymentLink,validateDeploymentLink,type DeploymentLink} from "./deployment-link";
import {readPendingFlyApply,readPrivateFlyApplyArchive,readPrivateFlyAbandonedApplyArchive,abandonObsoleteFlyApply} from "./fly-apply";
import {readPendingActivation} from "./activation";
import {PrivateFlyReplacementStore,readPrivateFlyReplacement,readPrivateFlyReplacementArchive,readPrivateFlyRollbackArchive} from "./fly-replacement-store";
import {pendingFlyRollbackPath,assertNoPendingPush,assertTransactionClear} from "./file-transaction";
import {withPrivateDirectoryLock} from "./private-lock";
export interface PendingFlyRollback {
 schemaVersion:1;config:string;link:DeploymentLink;applyInstanceId:string;
 replacement:FlyReplacementState;request:FlyRollbackRequest;
 rebase:FlyRollbackRebaseRequest|null;completion:FlyRollbackReceipt|null;finalization:FlyRollbackFence|null;
}
const equal=(a:unknown,b:unknown)=>canonicalConfigJson(a)===canonicalConfigJson(b);
function flush(path:string){const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function parent(path:string){if(process.platform!=="win32")flush(dirname(path));}
function save(config:string,value:PendingFlyRollback,replace=false){
 const path=pendingFlyRollbackPath(config),stage=`${path}.${randomUUID()}.tmp`,bytes=JSON.stringify(value)+"\n";
 if(Buffer.byteLength(bytes)>16_777_216)throw new Error("Private rollback exceeds its recovery reader limit");
 try{writeFileSync(stage,bytes,{flag:"wx",mode:0o600});flush(stage);if(replace)renameSync(stage,path);else linkSync(stage,path);parent(path);}finally{rmSync(stage,{force:true});}
}
async function applyArchive(config:string,id:string){const pending=await readPendingFlyApply(config);return pending?.artifact.instance.instanceId===id?pending:await readPrivateFlyApplyArchive(config,id)??await readPrivateFlyAbandonedApplyArchive(config,id);}
function projected(p:PendingFlyRollback,r:FlyRollbackReceipt):DeploymentLink{
 const b=r.binding.request,f=p.finalization??{...r.fence,configurationVersion:r.configurationVersion},sameGraph=p.link.revision===f.revision;
 return {...p.link,...(sameGraph?{configurationVersion:f.configurationVersion,desiredSequence:f.sequence}:{}),target:{kind:"fly",managed:false,imageDigest:b.previousImageDigest,fly:{appName:b.appName,machineId:b.previousMachineId,region:b.region,orgSlug:b.orgSlug}}};
}
export async function readPendingFlyRollback(config:string):Promise<PendingFlyRollback|null>{
 assertTransactionClear(config);const path=pendingFlyRollbackPath(config);let fd:number;
 try{if(!lstatSync(path).isFile())throw new Error();fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("Rollback state must be a private regular file");}
 let p:PendingFlyRollback;
 try{const stat=fstatSync(fd);if(!stat.isFile() || stat.size>16_777_216 || process.platform!=="win32" && (stat.mode&0o077)!==0)throw new Error();p=JSON.parse(readFileSync(fd,"utf8"));}catch{throw new Error("Invalid private rollback state; retain it for recovery");}finally{closeSync(fd);}
 try{
  if(!p || typeof p!=="object" || Array.isArray(p) || Object.keys(p).length!==9 || Object.keys(p).some(k=>!["schemaVersion","config","link","applyInstanceId","replacement","request","rebase","completion","finalization"].includes(k)) || p.schemaVersion!==1 || p.config!==resolve(config) || !isInstanceId(p.applyInstanceId))throw new Error();
  p.link=await validateDeploymentLink(p.link);p.request=validateFlyRollbackRequest(p.request);p.replacement=validateFlyReplacementState(p.replacement);
  if(p.finalization!==null)p.finalization=validateFlyRollbackFence(p.finalization);
  if(p.rebase!==null)p.rebase=validateFlyRollbackRebaseRequest(p.rebase);
  if(p.finalization!==null && p.completion===null)throw new Error();
  if(p.completion!==null){p.completion=validateFlyRollbackReceipt(p.completion);if(p.completion.status!=="completed" || !equal(p.completion.request,p.request))throw new Error();if(p.finalization && (p.finalization.configurationVersion<p.completion.configurationVersion || p.finalization.sequence<p.completion.fence.sequence))throw new Error();}
  const a=await applyArchive(config,p.applyInstanceId),original=readPrivateFlyReplacementArchive(config,p.replacement.plan.id)??readPrivateFlyReplacement(config)??readPrivateFlyRollbackArchive(config,p.replacement.plan.id);
  if(!a || !original || !["installed","rolling_back","rolled_back"].includes(original.phase) || p.replacement.phase!=="installed" || p.request.expectedInstanceId!==p.applyInstanceId || p.link.service!==a.link.service || p.link.accountId!==a.link.accountId || p.link.deployment.id!==a.link.deployment.id || p.replacement.machineId!==original.machineId || !equal({...original.plan,after:p.replacement.plan.after},p.replacement.plan) || p.request.expectedImageDigest!==p.replacement.plan.after.image.split("@")[1] || p.request.candidateConfigDigest!==await hashConfigDocument(p.replacement.plan.after))throw new Error();
  const after={...a.plan.after,metadata:{...(a.plan.after.metadata as Record<string,unknown>??{}),"logtura.replacement":original.plan.id}};
  if(!equal(after,p.replacement.plan.after))throw new Error();
 }catch{throw new Error("Invalid private rollback state; retain it for recovery");}return p;
}
/** Explicit owner rollback. Retirement precedes lifecycle writes; legacy restore
 * always leaves applied state unknown. All uncertain operations remain resumable. */
export async function rollbackLinkedFlyDeployment(client:LogturaServiceClient,config:string,options:{fly:FlyMachinesClient;resume?:boolean;rebase?:boolean;waitMs?:number;pollMs?:number;signal?:AbortSignal}){
 return withPrivateDirectoryLock(resolve(dirname(resolve(config)),".logtura-rollback.lock"),async()=>{
  assertTransactionClear(config);const waitMs=options.waitMs??300_000,pollMs=options.pollMs??2_000;
  if(!Number.isSafeInteger(waitMs) || waitMs<1 || waitMs>600_000 || !Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>30_000)throw new Error("Invalid rollback observation budget");
  let p=await readPendingFlyRollback(config);
  if(!!p!==(options.resume===true))throw new Error(p?"Pending rollback; run deploy fly --rollback --resume":"No pending rollback to resume");
  if(options.rebase && !p)throw new Error("Rebase requires a pending rollback and --resume");
  const link=p?.link??await readDeploymentLink(config);if(!link || link.target?.kind!=="fly" || link.target.managed)throw new Error("Rollback requires a linked self-managed Fly deployment");
  const local=async()=>{
   if(options.signal?.aborted)throw new Error("Rollback interrupted; retain it and resume");
   if(client.url!==link.service || (await client.whoami()).id!==link.accountId)throw new Error("Rollback account or origin does not match");
   const current=await readDeploymentLink(config);if(!equal(current,link) && !(p?.completion && equal(current,projected(p,p.completion))))throw new Error("Local rollback link changed; retain recovery state");
  };await local();
  if(!p){
   const pending=await readPendingFlyApply(config);
   if(!pending)assertNoPendingPush(config);
   if(await readPendingActivation(config) && !pending)throw new Error("Resume the issued apply before rolling back");
   const capabilities=await client.request<{schemaVersion:number;features:string[]}>(`/deployments/${encodeURIComponent(link.deployment.id)}/config/fly-capabilities`);
   if(capabilities?.schemaVersion!==1 || !Array.isArray(capabilities.features) || !capabilities.features.includes("rollback"))throw new Error("Update the service before linked rollback");
   const binding=await client.getFlyBinding(link.deployment.id);if(!binding)throw new Error("No bound retained replacement; resume its apply before rollback");
   await client.pullDeploymentConfig(link.deployment.id);const state=await client.getDeploymentConfigurationState(link.deployment.id);
   if(!state || state.stale || !state.activeInstanceId)throw new Error("Rollback requires a current issued candidate");
   const a=await applyArchive(config,state.activeInstanceId),original=readPrivateFlyReplacementArchive(config,binding.request.instanceId)??readPrivateFlyReplacement(config);
   if(!a || !original || original.phase!=="installed" || original.machineId!==binding.request.machineId || original.plan.before.id!==binding.request.previousMachineId || original.plan.app!==binding.request.appName || original.plan.org!==binding.request.orgSlug || original.plan.before.region!==binding.request.region || original.plan.before.image_ref.digest!==binding.request.previousImageDigest || await hashConfigDocument(original.plan.rollback)!==binding.request.previousConfigDigest)throw new Error("Retained rollback identity or applied archive is unavailable");
   const after={...a.plan.after,metadata:{...(a.plan.after.metadata as Record<string,unknown>??{}),"logtura.replacement":original.plan.id}};
   const replacement=validateFlyReplacementState({...original,phase:"installed",plan:{...original.plan,after}}),app=await options.fly.app(original.plan.app),machines=await options.fly.machines(original.plan.app);
   const old=machines.find(m=>m.id===original.plan.before.id),candidate=machines.find(m=>m.id===original.machineId);
   if(app.organization.slug!==original.plan.org || machines.length!==2 || !old || old.state!=="stopped" || !equal(flyRollbackConfig(old),original.plan.rollback) || !candidate || candidate.state!=="started" || (candidate as typeof candidate & {name?:string}).name!==original.plan.name || candidate.image_ref.digest!==after.image.split("@")[1] || !matchesFlyConfig(candidate.config,after))throw new Error("Retained Fly machines changed before rollback");
   const activeReplacement=readPrivateFlyReplacement(config);if(activeReplacement && (!equal(activeReplacement.plan,replacement.plan) || activeReplacement.phase!=="installed" || activeReplacement.machineId!==replacement.machineId))throw new Error("Unresolved replacement must be reconciled before rollback");
   p={schemaVersion:1,config:resolve(config),link,applyInstanceId:state.activeInstanceId,replacement,request:{requestId:randomUUID(),bindingRequestId:binding.request.requestId,expectedConfigurationVersion:state.desired.configurationVersion,expectedSequence:state.desired.sequence,revision:state.desired.revision,expectedInstanceId:state.activeInstanceId,expectedImageDigest:candidate.image_ref.digest,candidateConfigDigest:await hashConfigDocument(after)},rebase:null,completion:null,finalization:null};
   await local();save(config,p);
  }
  const active=p;
  let receipt=await client.getFlyRollback(link.deployment.id,active.request.requestId)??await client.prepareFlyRollback(link.deployment.id,active.request);
  const verify=async()=>{
   const b=receipt.binding.request;if(active.completion && !equal(active.completion,receipt))throw new Error("Completed rollback receipt changed");if(!equal(receipt.request,active.request) || b.machineId!==active.replacement.machineId || b.previousMachineId!==active.replacement.plan.before.id || b.appName!==active.replacement.plan.app || b.orgSlug!==active.replacement.plan.org || b.region!==active.replacement.plan.before.region || b.previousImageDigest!==active.replacement.plan.before.image_ref.digest || b.previousConfigDigest!==await hashConfigDocument(active.replacement.plan.rollback))throw new Error("Rollback receipt differs from private intent");
  };await verify();
  const syncRebase=async()=>{
   if(!active.rebase)return;
   const acknowledged=await client.getFlyRollbackRebase(link.deployment.id,active.request.requestId,active.rebase.requestId)??await client.rebaseFlyRollback(link.deployment.id,active.request.requestId,active.rebase);
   if(!equal(acknowledged.request,active.rebase))throw new Error("Rebase acknowledgement differs from private intent");
   receipt=(await client.getFlyRollback(link.deployment.id,active.request.requestId))!;await verify();
   if(!equal(receipt.fence,{configurationVersion:active.rebase.configurationVersion,sequence:active.rebase.sequence,revision:active.rebase.revision}))throw new Error("Rebase is no longer current; retain rollback state");
  };
  await syncRebase();
  if(options.rebase){
   await client.pullDeploymentConfig(link.deployment.id);const state=await client.getDeploymentConfigurationState(link.deployment.id);
   if(!state || state.stale || state.activeInstanceId!==null)throw new Error("Rollback graph is unavailable for rebase");
   const fence={configurationVersion:state.desired.configurationVersion,sequence:state.desired.sequence,revision:state.desired.revision};
   if(receipt.status==="completed"){active.completion=receipt;active.finalization=fence;await local();save(config,active,true);}
   else if(!equal(receipt.fence,fence)){active.rebase={requestId:randomUUID(),...fence};await local();save(config,active,true);await syncRebase();}
  }
  const guard=async()=>{
   await local();const current=await client.getFlyRollback(link.deployment.id,active.request.requestId),state=await client.getDeploymentConfigurationState(link.deployment.id);
   const fence=active.finalization??{...receipt.fence,configurationVersion:receipt.configurationVersion};
   if(!current || !equal(current,receipt) || !state || state.stale || state.activeInstanceId!==null || state.applied!==null || state.desired.configurationVersion!==fence.configurationVersion || state.desired.sequence!==fence.sequence || state.desired.revision!==fence.revision)throw new Error("Rollback fence changed; use --rollback --resume --rebase");
   if((await options.fly.app(active.replacement.plan.app)).organization.slug!==active.replacement.plan.org)throw new Error("Rollback Fly organization changed");
  };await guard();
  const store=new PrivateFlyReplacementStore(config),deadline=Date.now()+waitMs;
  let replacement=readPrivateFlyReplacement(config);
  if(receipt.status!=="completed"){
   if(!replacement)await store.prepareRollback(active.replacement,guard);
   for(;;){try{replacement=await executeFlyReplacement(store,options.fly,{rollback:true,assertCurrent:guard});break;}catch(error){if(!(error instanceof FlyReplacementPending))throw error;if(Date.now()>=deadline)throw new Error("Rollback handoff pending; resume its private intent");await new Promise(done=>setTimeout(done,pollMs));}}
   await guard();receipt=await client.completeFlyRollback(link.deployment.id,active.request.requestId);await verify();
  }
  if(!replacement)replacement=readPrivateFlyRollbackArchive(config,active.replacement.plan.id);
  if(!replacement || replacement.phase!=="rolled_back" || !equal(replacement.plan,active.replacement.plan) || replacement.machineId!==active.replacement.machineId)throw new Error("Acknowledged private rollback handoff is missing");
  const restored=async()=>{
   await guard();const old=await options.fly.machine(active.replacement.plan.app,active.replacement.plan.before.id),candidate=await options.fly.machine(active.replacement.plan.app,active.replacement.machineId!);
   if(old.state!=="started" || old.image_ref.digest!==active.replacement.plan.before.image_ref.digest || !equal(flyRollbackConfig(old),active.replacement.plan.rollback) || !["stopped","created","suspended"].includes(candidate.state) || candidate.image_ref.digest!==active.request.expectedImageDigest || !matchesFlyConfig(candidate.config,active.replacement.plan.after))throw new Error("Restored Fly handoff changed; retain rollback state");
   const snapshot=await client.pullDeploymentConfig(link.deployment.id),b=receipt.binding.request;
   if(snapshot.target?.fly?.machineId!==b.previousMachineId || snapshot.target.imageDigest!==b.previousImageDigest || snapshot.configurationVersion!==(active.finalization?.configurationVersion??receipt.configurationVersion) || snapshot.desiredSequence!==(active.finalization?.sequence??receipt.fence.sequence) || snapshot.revision!==(active.finalization?.revision??receipt.fence.revision))throw new Error("Restored service target changed");
  };await restored();
  if(!active.completion){active.completion=receipt;save(config,active,true);}
  if(readPrivateFlyReplacement(config))await store.archive(replacement,restored);
  else if(!equal(readPrivateFlyRollbackArchive(config,replacement.plan.id),replacement))throw new Error("Private rollback archive changed");
  if(await readPendingFlyApply(config))await abandonObsoleteFlyApply(client,config);
  const target=await validateDeploymentLink(projected(active,receipt)),path=`${resolve(config)}.logtura-link.json`,stage=`${path}.${randomUUID()}.tmp`;
  if(!equal(await readDeploymentLink(config),target)){try{writeFileSync(stage,JSON.stringify(target)+"\n",{flag:"wx",mode:0o600});flush(stage);await restored();renameSync(stage,path);parent(path);}finally{rmSync(stage,{force:true});}}
  await restored();const journal=pendingFlyRollbackPath(config),archive=resolve(dirname(journal),`.logtura-rollback-${active.request.requestId}.json`);
  try{linkSync(journal,archive);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST" || !lstatSync(archive).isFile() || process.platform!=="win32" && (lstatSync(archive).mode&0o077)!==0 || readFileSync(archive,"utf8")!==readFileSync(journal,"utf8"))throw error;}
  parent(archive);await restored();rmSync(journal);parent(journal);
  return {app:active.replacement.plan.app,machineId:active.replacement.plan.before.id,candidateMachineId:active.replacement.machineId,applied:null,needsPull:target.configurationVersion!==(active.finalization?.configurationVersion??receipt.configurationVersion),rollbackFile:archive};
 },"Rollback");
}
