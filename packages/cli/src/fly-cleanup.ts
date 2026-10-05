import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,linkSync,renameSync,rmSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {canonicalConfigJson,hashConfigDocument,isInstanceId,validateFlyCleanupRequest,validateFlyCleanupReceipt,validateFlyRollbackFence,validateFlyRollbackRebaseRequest,validateFlyReplacementCleanupState,planFlyReplacementCleanup,executeFlyReplacementCleanup,FlyReplacementCleanupPending,validateFlyRuntimeVolume,type FlyCleanupRequest,type FlyCleanupReceipt,type FlyRollbackFence,type FlyRollbackRebaseRequest,type FlyReplacementCleanupState,type FlyReplacementCleanupStore,type FlyReplacementCleanupTransaction,type LogturaServiceClient,type FlyMachinesClient} from "@logtura/core";
import {readDeploymentLink,validateDeploymentLink,type DeploymentLink} from "./deployment-link";
import {readPrivateFlyApplyArchive} from "./fly-apply";
import {readPrivateFlyReplacementArchive,readPrivateFlyRollbackArchive} from "./fly-replacement-store";
import {pendingFlyCleanupPath,assertNoPendingPush,assertTransactionClear} from "./file-transaction";
import {withPrivateDirectoryLock} from "./private-lock";
export interface PendingFlyCleanup {
 schemaVersion:1;config:string;link:DeploymentLink;request:FlyCleanupRequest;
 state:FlyReplacementCleanupState;rebase:FlyRollbackRebaseRequest|null;
 completion:FlyCleanupReceipt|null;finalization:FlyRollbackFence|null;
}
const equal=(a:unknown,b:unknown)=>canonicalConfigJson(a)===canonicalConfigJson(b);
function flush(path:string){const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function parent(path:string){if(process.platform!=="win32")flush(dirname(path));}
function save(config:string,value:PendingFlyCleanup,initial=false){
 const path=pendingFlyCleanupPath(config),stage=`${path}.${randomUUID()}.tmp`,bytes=JSON.stringify(value)+"\n";
 if(Buffer.byteLength(bytes)>16_777_216)throw new Error("Private cleanup exceeds its recovery reader limit");
 try{writeFileSync(stage,bytes,{flag:"wx",mode:0o600});flush(stage);if(initial)linkSync(stage,path);else renameSync(stage,path);parent(path);}finally{rmSync(stage,{force:true});}
}
export async function readPendingFlyCleanup(config:string):Promise<PendingFlyCleanup|null>{
 assertTransactionClear(config);const path=pendingFlyCleanupPath(config);let fd:number;
 try{if(!lstatSync(path).isFile())throw new Error();fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("Cleanup state must be a private regular file");}
 let p:PendingFlyCleanup;
 try{const stat=fstatSync(fd);if(!stat.isFile() || stat.size>16_777_216 || process.platform!=="win32" && (stat.mode&0o077)!==0)throw new Error();p=JSON.parse(readFileSync(fd,"utf8"));}catch{throw new Error("Invalid private cleanup state; retain it for recovery");}finally{closeSync(fd);}
 try{
  if(!p || typeof p!=="object" || Array.isArray(p) || Object.keys(p).length!==8 || Object.keys(p).some(k=>!["schemaVersion","config","link","request","state","rebase","completion","finalization"].includes(k)) || p.schemaVersion!==1 || p.config!==resolve(config))throw new Error();
  p.link=await validateDeploymentLink(p.link);p.request=validateFlyCleanupRequest(p.request);p.state=validateFlyReplacementCleanupState(p.state);
  if(p.rebase!==null)p.rebase=validateFlyRollbackRebaseRequest(p.rebase);
  if(p.finalization!==null)p.finalization=validateFlyRollbackFence(p.finalization);
  if(p.completion!==null){p.completion=validateFlyCleanupReceipt(p.completion);if(p.completion.status!=="completed" || p.state.phase!=="deleted" || !equal(p.completion.request,p.request) || p.finalization && (p.finalization.configurationVersion<p.completion.fence.configurationVersion || p.finalization.sequence<p.completion.fence.sequence))throw new Error();}
  if(p.finalization && !p.completion)throw new Error();
  const replacement=p.state.plan.replacement,old=readPrivateFlyReplacementArchive(config,replacement.plan.id),rolled=p.request.rollbackRequestId!==null;
  if(!old || old.phase!=="installed" || old.machineId!==replacement.machineId || !equal({...old.plan,after:replacement.plan.after},replacement.plan) || replacement.phase!==(rolled?"rolled_back":"installed") || p.link.target?.kind!=="fly" || p.link.target.managed || !p.link.target.fly || p.link.target.fly.appName!==replacement.plan.app || p.link.target.fly.machineId!==p.state.plan.survivor.id || p.link.target.imageDigest!==p.request.imageDigest)throw new Error();
  if(rolled){if(!equal(readPrivateFlyRollbackArchive(config,replacement.plan.id),replacement))throw new Error();}
  else{const a=await readPrivateFlyApplyArchive(config,p.request.expectedInstanceId!);if(!a || !a.completion || a.link.service!==p.link.service || a.link.accountId!==p.link.accountId || a.link.deployment.id!==p.link.deployment.id || !equal({...a.plan.after,metadata:{...(a.plan.after.metadata as Record<string,unknown>??{}),"logtura.replacement":old.plan.id}},replacement.plan.after))throw new Error();}
  if(p.request.survivorConfigDigest!==await hashConfigDocument(rolled?replacement.plan.rollback:replacement.plan.after) || p.request.retiredConfigDigest!==await hashConfigDocument(rolled?replacement.plan.after:replacement.plan.rollback))throw new Error();
 }catch{throw new Error("Invalid private cleanup state; retain it for recovery");}return p;
}
/** Durable private adapter. Cleanup cannot retry uncertain deletion or mutate its
 * immutable provider plan; the shared backend owns all lifecycle transitions. */
export class PrivateFlyCleanupStore implements FlyReplacementCleanupStore {
 constructor(readonly config:string){}
 async runExclusive<T>(operation:(transaction:FlyReplacementCleanupTransaction)=>Promise<T>):Promise<T>{
  return withPrivateDirectoryLock(resolve(dirname(resolve(this.config)),".logtura-cleanup.lock"),async()=>{
   const initial=await readPendingFlyCleanup(this.config);if(!initial)throw new Error("Cleanup state is missing; retain provider resources");
   return operation({read:async()=>{const current=await readPendingFlyCleanup(this.config);if(!current || !equal({...current,state:initial.state},initial))throw new Error("Cleanup owner intent changed during execution");return current.state;},compareAndSwap:async(expected,next)=>{
    const current=await readPendingFlyCleanup(this.config),validated=validateFlyReplacementCleanupState(next);
    if(!current || !equal(current.state,expected) || !equal({...current,state:initial.state},initial) || !equal(expected.plan,validated.plan) || !(expected.phase==="prepared" && validated.phase==="deleting" || expected.phase==="deleting" && validated.phase==="deleted"))return false;
    save(this.config,{...current,state:validated});return true;
   }});
  },"Cleanup backend");
 }
 async archive(assertCurrent:()=>Promise<void>):Promise<string>{
  return withPrivateDirectoryLock(resolve(dirname(resolve(this.config)),".logtura-cleanup.lock"),async()=>{
   const p=await readPendingFlyCleanup(this.config);if(!p || p.state.phase!=="deleted" || !p.completion)throw new Error("Cleanup is not acknowledged; retain its recovery intent");
   await assertCurrent();const path=pendingFlyCleanupPath(this.config),archive=resolve(dirname(path),`.logtura-cleanup-${p.request.requestId}${p.finalization?`-finalized-${p.finalization.configurationVersion}-${p.finalization.sequence}-${p.finalization.revision.slice(7)}`:""}.json`);
   try{linkSync(path,archive);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST" || !lstatSync(archive).isFile() || process.platform!=="win32" && (lstatSync(archive).mode&0o077)!==0 || readFileSync(archive,"utf8")!==readFileSync(path,"utf8"))throw new Error("Cleanup archive conflicts; retain it for recovery");}
   parent(archive);await assertCurrent();if(!equal(await readPendingFlyCleanup(this.config),p))throw new Error("Cleanup state changed before archive acknowledgement");rmSync(path);parent(path);return archive;
  },"Cleanup backend");
 }
}
/** Explicit deletion of an acknowledged retained machine. --rollback-id selects
 * a completed restoration; without it the current accepted candidate survives. */
export async function cleanupLinkedFlyDeployment(client:LogturaServiceClient,config:string,options:{fly:FlyMachinesClient;rollbackId?:string;resume?:boolean;rebase?:boolean;waitMs?:number;pollMs?:number;signal?:AbortSignal}){
 return withPrivateDirectoryLock(resolve(dirname(resolve(config)),".logtura-cleanup-command.lock"),async()=>{
  assertTransactionClear(config);const waitMs=options.waitMs??300_000,pollMs=options.pollMs??2_000;
  if(!Number.isSafeInteger(waitMs) || waitMs<1 || waitMs>600_000 || !Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>30_000)throw new Error("Invalid cleanup observation budget");
  if(options.rollbackId!==undefined && !isInstanceId(options.rollbackId))throw new Error("Invalid completed rollback identity");
  let p=await readPendingFlyCleanup(config);if(!!p!==(options.resume===true))throw new Error(p?"Pending cleanup; run deploy fly --cleanup --resume":"No pending cleanup to resume");
  if(options.rebase && !p)throw new Error("Cleanup rebase requires --resume and pending intent");
  if(p && options.rollbackId!==undefined && options.rollbackId!==p.request.rollbackRequestId)throw new Error("Cleanup rollback identity differs from its private intent");
  const link=p?.link??await readDeploymentLink(config);if(!link || link.target?.kind!=="fly" || link.target.managed)throw new Error("Cleanup requires a linked self-managed Fly deployment");
  const local=async()=>{if(options.signal?.aborted)throw new Error("Cleanup interrupted; retain its intent and resume");if(client.url!==link.service || (await client.whoami()).id!==link.accountId)throw new Error("Cleanup account or origin does not match");if(!equal(await readDeploymentLink(config),link))throw new Error("Local cleanup link changed; retain recovery state");};await local();
  if(!p){
   assertNoPendingPush(config);const caps=await client.request<{schemaVersion:number;features:string[]}>(`/deployments/${encodeURIComponent(link.deployment.id)}/config/fly-capabilities`);
   if(caps?.schemaVersion!==1 || !Array.isArray(caps.features) || !caps.features.includes("cleanup"))throw new Error("Update the service before linked cleanup");
   const rollback=options.rollbackId?await client.getFlyRollback(link.deployment.id,options.rollbackId):null;
   if(options.rollbackId && rollback?.status!=="completed")throw new Error("Cleanup requires the selected completed rollback");
   const binding=rollback?.binding??await client.getFlyBinding(link.deployment.id);if(!binding)throw new Error("No bound retained replacement; provide its completed --rollback-id after restoration");
   const snapshot=await client.pullDeploymentConfig(link.deployment.id),state=await client.getDeploymentConfigurationState(link.deployment.id),original=readPrivateFlyReplacementArchive(config,binding.request.instanceId);
   if(!state || state.stale || !original || original.phase!=="installed")throw new Error("Current graph or acknowledged private replacement is unavailable");
   if(!equal(snapshot.target,link.target))throw new Error("Cleanup service target differs from its local link");
   let replacement=original;
   if(rollback){const restored=readPrivateFlyRollbackArchive(config,original.plan.id);if(!restored || restored.phase!=="rolled_back" || state.activeInstanceId!==null || state.applied!==null)throw new Error("Cleanup requires acknowledged restoration and retired reports");replacement=restored;}
   else{if(!state.activeInstanceId || state.applied?.sequence!==state.desired.sequence || state.applied.revision!==state.desired.revision || !state.lastReportSequence)throw new Error("Cleanup requires an accepted current candidate report");const a=await readPrivateFlyApplyArchive(config,state.activeInstanceId);if(!a?.completion)throw new Error("Current acknowledged apply archive is unavailable");replacement={...original,plan:{...original.plan,after:{...a.plan.after,metadata:{...(a.plan.after.metadata as Record<string,unknown>??{}),"logtura.replacement":original.plan.id}}}};}
   const cleanup=planFlyReplacementCleanup({replacement,machines:await options.fly.machines(replacement.plan.app)}),rolled=rollback!==null;
   p={schemaVersion:1,config:resolve(config),link,state:{plan:cleanup,phase:"prepared"},request:{requestId:randomUUID(),bindingRequestId:binding.request.requestId,rollbackRequestId:rollback?.request.requestId??null,expectedConfigurationVersion:state.desired.configurationVersion,expectedSequence:state.desired.sequence,revision:state.desired.revision,expectedInstanceId:state.activeInstanceId,imageDigest:link.target.imageDigest!,survivorConfigDigest:await hashConfigDocument(rolled?replacement.plan.rollback:replacement.plan.after),retiredConfigDigest:await hashConfigDocument(rolled?replacement.plan.after:replacement.plan.rollback)},rebase:null,completion:null,finalization:null};
   if((await options.fly.app(replacement.plan.app)).organization.slug!==replacement.plan.org)throw new Error("Cleanup Fly organization changed");await local();save(config,p,true);await readPendingFlyCleanup(config);
  }
  let active=p,receipt=await client.getFlyCleanup(link.deployment.id,p.request.requestId)??await client.prepareFlyCleanup(link.deployment.id,p.request);
  const verify=async()=>{const b=receipt.binding.request,r=active.state.plan.replacement;if(!equal(receipt.request,active.request) || active.completion && !equal(active.completion,receipt) || b.instanceId!==r.plan.id || b.machineId!==r.machineId || b.previousMachineId!==r.plan.before.id || b.previousImageDigest!==r.plan.before.image_ref.digest || b.previousConfigDigest!==await hashConfigDocument(r.plan.rollback) || b.appName!==r.plan.app || b.orgSlug!==r.plan.org || b.region!==r.plan.before.region)throw new Error("Cleanup receipt differs from its retained private identity");};await verify();
  const syncRebase=async()=>{if(!active.rebase)return;const ack=await client.getFlyCleanupRebase(link.deployment.id,active.request.requestId,active.rebase.requestId)??await client.rebaseFlyCleanup(link.deployment.id,active.request.requestId,active.rebase);if(!equal(ack.request,active.rebase))throw new Error("Cleanup rebase differs from private intent");receipt=(await client.getFlyCleanup(link.deployment.id,active.request.requestId))!;await verify();if(!equal(receipt.fence,{configurationVersion:active.rebase.configurationVersion,sequence:active.rebase.sequence,revision:active.rebase.revision}) && !options.rebase)throw new Error("Cleanup rebase is no longer current");};await syncRebase();
  if(options.rebase){const snapshot=await client.pullDeploymentConfig(link.deployment.id);if(!equal(snapshot.target,link.target))throw new Error("Cleanup physical target changed; retain recovery state");const state=await client.getDeploymentConfigurationState(link.deployment.id);if(!state || state.stale || state.activeInstanceId!==active.request.expectedInstanceId)throw new Error("Cleanup graph is unavailable for rebase");const fence={configurationVersion:state.desired.configurationVersion,sequence:state.desired.sequence,revision:state.desired.revision};if(receipt.status==="completed"){active.completion=receipt;active.finalization=fence;await local();save(config,active);}else if(!equal(receipt.fence,fence)){active.rebase={requestId:randomUUID(),...fence};await local();save(config,active);await syncRebase();}}
  const guard=async()=>{await local();const current=await client.getFlyCleanup(link.deployment.id,active.request.requestId),state=await client.getDeploymentConfigurationState(link.deployment.id),fence=active.finalization??receipt.fence;
   if(!current || !equal(current,receipt) || !state || state.stale || state.activeInstanceId!==active.request.expectedInstanceId || state.desired.configurationVersion!==fence.configurationVersion || state.desired.sequence!==fence.sequence || state.desired.revision!==fence.revision || (active.request.rollbackRequestId===null?state.applied?.sequence!==active.request.expectedSequence || state.applied.revision!==active.request.revision || !state.lastReportSequence:state.applied!==null))throw new Error("Cleanup fence changed; use --cleanup --resume --rebase");
   if((await options.fly.app(active.state.plan.replacement.plan.app)).organization.slug!==active.state.plan.replacement.plan.org)throw new Error("Cleanup Fly organization changed");
  };await guard();
  const store=new PrivateFlyCleanupStore(config),deadline=Date.now()+waitMs;
  if(receipt.status==="completed" && active.state.phase!=="deleted")throw new Error("Completed cleanup lacks private deletion proof; retain recovery state");
  for(;;){try{await executeFlyReplacementCleanup(store,options.fly,{assertCurrent:guard});break;}catch(error){if(!(error instanceof FlyReplacementCleanupPending))throw error;if(Date.now()>=deadline)throw new Error("Cleanup deletion outcome is pending; resume without repeating DELETE");await new Promise(done=>setTimeout(done,pollMs));}}
  active=(await readPendingFlyCleanup(config))!;await guard();if(receipt.status!=="completed"){receipt=await client.completeFlyCleanup(link.deployment.id,active.request.requestId);await verify();}
  if(!active.completion){active.completion=receipt;save(config,active);}
  const accepted=async()=>{await guard();const plan=active.state.plan,app=plan.replacement.plan.app,machines=await options.fly.machines(app),survivor=machines[0];if(machines.length!==1 || !survivor || survivor.id!==plan.survivor.id || survivor.state!=="started" || survivor.instance_id!==plan.survivor.instance_id || survivor.region!==plan.survivor.region || !equal(survivor.image_ref,plan.survivor.image_ref) || !equal(survivor.config,plan.survivor.config) || (survivor as typeof survivor & {name?:string}).name!==(plan.survivor as typeof survivor & {name?:string}).name)throw new Error("Cleanup survivor changed after deletion");const volumes=await options.fly.volumes(app),volume=volumes.find(v=>v.id===plan.replacement.plan.volume);validateFlyRuntimeVolume(survivor,volumes,plan.replacement.plan.volume);if(volume!.attached_machine_id!==(plan.replacement.phase==="installed"?survivor.id:null))throw new Error("Cleanup checkpoint attachment changed");await guard();};
  await accepted();const archive=await store.archive(accepted),fence=active.finalization??receipt.fence;
  return {app:active.state.plan.replacement.plan.app,machineId:active.state.plan.survivor.id,deletedMachineId:active.state.plan.retired.id,volume:active.state.plan.replacement.plan.volume,cleanupId:active.request.requestId,needsPull:link.configurationVersion!==fence.configurationVersion || link.desiredSequence!==fence.sequence || link.revision!==fence.revision,cleanupFile:archive};
 },"Cleanup");
}
