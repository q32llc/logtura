import {
  FlyMachinesClient, applyFlyMachine, compileForwarderRuntime, generateBundle, parseDeploymentManifest,
  planFlyRuntime, matchesFlyConfig, validateFlyRuntimeVolume, immutableFlyImage, resolveFlyImage, flyRollbackConfig, validateFlyMachine,
  validateForwarderRuntimeArtifact, canonicalConfigJson, VECTOR_VERSION, hashConfigDocument,
  planFlyReplacement,executeFlyReplacement,FlyReplacementPending,validateFlyReplacementState,validateFlyBindingReceipt,isInstanceId,
  type FlyReplacementState,type FlyBindingReceipt,
  ServiceError, type LogturaServiceClient, type FlyMachine, type FlyMachinePlan, type FlyMachineConfig, type ForwarderRuntimeArtifact,
} from "@logtura/core";
import { constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,linkSync,rmSync,renameSync } from "node:fs";
import { resolve,dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { withPrivateDirectoryLock } from "./private-lock";
import { readDeploymentLink,validateDeploymentLink,deploymentStatus,type DeploymentLink } from "./deployment-link";
import { activateLinkedDeployment,readPendingActivation,finishLinkedActivation,abandonObsoleteLinkedActivation } from "./activation";
import { pendingFlyApplyPath,assertNoPendingPush,assertTransactionClear } from "./file-transaction";
import { linkedFlyTarget,type FlyTargetOptions } from "./fly-target";
import { readConfigEnvironment } from "./config";
import { listProviders,listDestinations } from "./registry";
import {PrivateFlyReplacementStore,readPrivateFlyReplacement,readPrivateFlyReplacementArchive} from "./fly-replacement-store";

/** Contains resolved machine payloads. Mode 0600, never public logs/CI artifacts. */
export interface PendingFlyApply {
  schemaVersion:1;config:string;link:DeploymentLink;machine:FlyMachine;volume:string;
  artifact:ForwarderRuntimeArtifact;plan:FlyMachinePlan;rollback:FlyMachineConfig;
  completion?:{binding:FlyBindingReceipt;link:DeploymentLink;replacement:FlyReplacementState|null};
}
function flush(path:string):void {const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function flushParent(path:string):void {if(process.platform!=="win32")flush(dirname(path));}
function save(path:string,value:PendingFlyApply,replace=false):void {
  const stage=`${path}.${randomUUID()}.tmp`;
  try{const serialized=JSON.stringify(value)+"\n";if(Buffer.byteLength(serialized)>16_777_216)throw new Error("Private apply state exceeds its recovery reader limit");writeFileSync(stage,serialized,{flag:"wx",mode:0o600});flush(stage);if(replace)renameSync(stage,path);else linkSync(stage,path);}finally{rmSync(stage,{force:true});}
  flushParent(path);
}
export async function readPendingFlyApply(config:string):Promise<PendingFlyApply|null> {return readApply(config,pendingFlyApplyPath(config));}
export async function readPrivateFlyApplyArchive(config:string,id:string):Promise<PendingFlyApply|null>{
  if(!isInstanceId(id))throw new Error("Invalid apply archive identity");
  return readApply(config,resolve(dirname(resolve(config)),`.logtura-applied-${id}.json`));
}
export async function readPrivateFlyAbandonedApplyArchive(config:string,id:string):Promise<PendingFlyApply|null>{
  if(!isInstanceId(id))throw new Error("Invalid abandoned apply archive identity");
  return readApply(config,resolve(dirname(resolve(config)),`.logtura-abandoned-${id}.json`));
}
async function readApply(config:string,path:string):Promise<PendingFlyApply|null> {
  try{if(!lstatSync(path).isFile())throw new Error();}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("Apply state must be a private regular file");}
  let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{throw new Error("Apply state must be a private regular file");}
  let value:PendingFlyApply;
  try{const stat=fstatSync(fd);if(!stat.isFile() || stat.size>16_777_216 || (process.platform!=="win32" && (stat.mode&0o077)!==0))throw new Error();value=JSON.parse(readFileSync(fd,"utf8")) as PendingFlyApply;}catch{throw new Error("Invalid private apply state; retain it for recovery");}finally{closeSync(fd);}
  try{
    if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==(value.completion===undefined?8:9) || Object.keys(value).some(key=>!["schemaVersion","config","link","machine","volume","artifact","plan","rollback","completion"].includes(key)) || value.schemaVersion!==1 || value.config!==resolve(config))throw new Error();
    value.link=await validateDeploymentLink(value.link);value.machine=validateFlyMachine(value.machine);value.artifact=await validateForwarderRuntimeArtifact(value.artifact);
    const target=linkedFlyTarget(value.link,{app:value.plan.app,region:value.machine.region});
    if(target.appName!==value.plan.app || value.plan.machineId!==value.machine.id || value.plan.version!==value.machine.instance_id || canonicalConfigJson(value.plan.before)!==canonicalConfigJson(value.machine.config) || canonicalConfigJson(value.rollback)!==canonicalConfigJson(flyRollbackConfig(value.machine)) || value.artifact.deploymentId!==value.link.deployment.id || value.artifact.service!==value.link.service || canonicalConfigJson(value.artifact.document)!==canonicalConfigJson(value.link.document) || value.artifact.instance.sequence!==value.link.desiredSequence || value.artifact.instance.configurationVersion!==value.link.configurationVersion || value.artifact.vectorVersion!==VECTOR_VERSION || !/^vol_[a-z0-9]+$/.test(value.volume))throw new Error();
    if(value.link.target?.fly?.machineId!==value.machine.id)throw new Error();
    immutableFlyImage(value.plan.after.image);
    if(value.completion!==undefined){
      const c=value.completion;if(!c || typeof c!=="object" || Array.isArray(c) || Object.keys(c).length!==3 || Object.keys(c).some(k=>!["binding","link","replacement"].includes(k)))throw new Error();
      c.binding=validateFlyBindingReceipt(c.binding);c.link=await validateDeploymentLink(c.link);
      const r=c.binding.request;
      if(r.requestId!==value.artifact.instance.requestId || r.instanceId!==value.artifact.instance.instanceId || r.expectedConfigurationVersion!==value.link.configurationVersion || r.expectedSequence!==value.link.desiredSequence || r.revision!==value.link.revision || r.appName!==value.plan.app || r.region!==value.machine.region || r.previousMachineId!==value.machine.id || r.expectedImageDigest!==(value.link.target?.imageDigest??null) || r.imageDigest!==value.plan.after.image.split("@")[1] || r.previousImageDigest!==value.machine.image_ref.digest || r.previousConfigDigest!==await hashConfigDocument(value.rollback))throw new Error();
      const projected={...value.link,configurationVersion:c.binding.configurationVersion,target:{kind:"fly",managed:false,imageDigest:r.imageDigest,fly:{appName:r.appName,machineId:r.machineId,region:r.region,orgSlug:r.orgSlug}}};
      if(canonicalConfigJson(c.link)!==canonicalConfigJson(projected))throw new Error();
      if(r.machineId===value.machine.id){if(c.replacement!==null)throw new Error();}
      else{
        if(!c.replacement)throw new Error();c.replacement=validateFlyReplacementState(c.replacement);
        const expected=planFlyReplacement({id:value.artifact.instance.instanceId,app:value.plan.app,org:r.orgSlug,machine:value.machine,config:value.plan.after,volume:value.volume,volumes:[{id:value.volume,region:value.machine.region,state:"created",encrypted:true,attached_machine_id:null}]});
        if(c.replacement.phase!=="installed" || c.replacement.machineId!==r.machineId || canonicalConfigJson(c.replacement.plan)!==canonicalConfigJson(expected))throw new Error();
      }
    }
  }catch{throw new Error("Invalid private apply state; retain it for recovery");}
  return value;
}
async function unchanged(config:string,link:DeploymentLink,client:LogturaServiceClient,projected?:DeploymentLink):Promise<void> {
  if(client.url!==link.service || (await client.whoami()).id!==link.accountId)throw new Error("Apply account or origin does not match the linked deployment");
  const current=await readDeploymentLink(config),status=await deploymentStatus(config);
  if((canonicalConfigJson(current)!==canonicalConfigJson(link) && (!projected || canonicalConfigJson(current)!==canonicalConfigJson(projected))) || !status.linked || status.changes.length || status.privateChanges.length)throw new Error("Local configuration changed; retain apply state for recovery");
}
function bundle(config:string,link:DeploymentLink) {
  const parsed=parseDeploymentManifest(link.document,{env:readConfigEnvironment(config),providers:listProviders(),destinations:listDestinations()});
  if(parsed.missingEnv.length)throw new Error("Linked apply requires all referenced private payloads");return generateBundle(parsed.input);
}
async function inspect(client:LogturaServiceClient,fly:FlyMachinesClient,link:DeploymentLink,options:FlyTargetOptions & {machine?:string;volume?:string}) {
  const target=linkedFlyTarget(link,options),app=await fly.app(target.appName);
  if(target.org!==undefined && app.organization.slug!==target.org)throw new Error("Fly organization does not match the linked target");
  const machines=await fly.machines(target.appName);
  const capabilities=await client.request<{schemaVersion:unknown;features:unknown}>(`/deployments/${encodeURIComponent(link.deployment.id)}/config/fly-capabilities`);
  if(capabilities?.schemaVersion!==1 || !Array.isArray(capabilities.features) || !capabilities.features.includes("replacement") || !capabilities.features.includes("image-update"))throw new Error("Update the service before applying linked Fly replacements or image updates");
  const bound=link.target?.fly?.machineId;
  if(bound && options.machine!==undefined && options.machine!==bound)throw new Error("Fly machine option conflicts with the linked target");
  const selected=options.machine??bound,machine=machines.find(m=>m.id===selected);
  if(!machine || !/^[a-f0-9]{1,32}$/.test(machine.id) || !bound)throw new Error("Linked apply requires a bound existing Fly forwarder machine; pull its target before applying");
  if(machine.region!==target.region)throw new Error("Fly machine region does not match the linked target");
  if(machines.length!==1){
    const receipt=await client.getFlyBinding(link.deployment.id),r=receipt?.request,standby=machines.find(m=>m.id===r?.previousMachineId);
    if(machines.length!==2 || !r || r.appName!==target.appName || r.orgSlug!==app.organization.slug || r.region!==machine.region || r.machineId!==machine.id || !standby || standby.id===machine.id || standby.state!=="stopped" || standby.region!==r.region || standby.image_ref.digest!==r.previousImageDigest || await hashConfigDocument(flyRollbackConfig(standby))!==r.previousConfigDigest)throw new Error("Linked apply requires only its bound machine and verified stopped retained forwarder");
  }
  const volumes=await fly.volumes(target.appName),volume=validateFlyRuntimeVolume(machine,volumes,options.volume);
  flyRollbackConfig(machine);return {target,machine,volume,volumes,org:app.organization.slug};
}
async function current(client:LogturaServiceClient,pending:PendingFlyApply) {
  const state=await client.getDeploymentConfigurationState(pending.link.deployment.id);
  if(!state || state.activeInstanceId!==pending.artifact.instance.instanceId || state.desired.sequence!==pending.link.desiredSequence || state.desired.revision!==pending.link.revision)throw new Error("Issued runtime is no longer current; retain apply state for recovery");return state;
}
/** Read-only preflight precedes issuance. Installation intent, including immutable
 * rollback image/config, is flushed before any Fly write. Resume reuses the exact
 * descriptor and checkpoint volume and observes an accepted report before success.
 * Caller may cancel waiting; it never discards an uncertain installation. */
export async function applyLinkedFlyDeployment(client:LogturaServiceClient,config:string,options:FlyTargetOptions & {fly:FlyMachinesClient;image?:string;imageFetch?:typeof fetch;registryToken?:string;volume?:string;machine?:string;resume?:boolean;waitMs?:number;pollMs?:number;signal?:AbortSignal}):Promise<{app:string;machineId:string;instanceId:string;revision:string;image:string;rollbackFile:string}> {
  return withPrivateDirectoryLock(resolve(dirname(resolve(config)),".logtura-apply.lock"),async()=>{
    assertTransactionClear(config);
    const waitMs=options.waitMs??300_000,pollMs=options.pollMs??2_000;
    if(!Number.isSafeInteger(waitMs) || waitMs<1 || waitMs>600_000 || !Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>30_000)throw new Error("Invalid apply wait interval");
    let pending=await readPendingFlyApply(config);const activation=await readPendingActivation(config);
    if(!!(pending || activation)!==(options.resume===true))throw new Error(pending || activation?"Pending apply; run deploy fly --resume":"No pending apply to resume");
    const link=pending?.link??activation?.link??await readDeploymentLink(config);if(!link)throw new Error("Pull a hosted deployment before applying");
    await unchanged(config,link,client,pending?.completion?.link);
    if(options.signal?.aborted)throw new Error("Apply interrupted; resume when ready");
    if(!pending){
      if(!activation)assertNoPendingPush(config);
      const {image}=await resolveFlyImage(options.image??"",{fetch:options.imageFetch,token:options.registryToken});
      const inspected=await inspect(client,options.fly,link,options);
      // Render/size/credential/target checks before retiring the previous instance.
      const dry={requestId:randomUUID(),instanceId:randomUUID(),configurationVersion:link.configurationVersion,sequence:link.desiredSequence,revision:link.revision};
      const compiled=await compileForwarderRuntime({service:link.service,deploymentId:link.deployment.id,document:link.document,instance:dry,env:readConfigEnvironment(config),providers:listProviders(),destinations:listDestinations()});
      const dryPlan=await planFlyRuntime({app:inspected.target.appName,machine:inspected.machine,volume:inspected.volume,image,...compiled});
      if(!(inspected.machine.config.mounts as unknown[]|undefined)?.length)planFlyReplacement({id:dry.instanceId,app:inspected.target.appName,org:inspected.org,machine:inspected.machine,config:dryPlan.after,volume:inspected.volume,volumes:inspected.volumes});
      if(options.signal?.aborted)throw new Error("Apply interrupted; resume when ready");
      const receipt=await activateLinkedDeployment(client,config,{resume:!!activation});
      const issued=await compileForwarderRuntime({service:link.service,deploymentId:link.deployment.id,document:link.document,instance:receipt,env:readConfigEnvironment(config),providers:listProviders(),destinations:listDestinations()});
      const plan=await planFlyRuntime({app:inspected.target.appName,machine:inspected.machine,volume:inspected.volume,image,...issued});
      pending={schemaVersion:1,config:resolve(config),link,machine:inspected.machine,volume:inspected.volume,artifact:issued.artifact,plan,rollback:flyRollbackConfig(inspected.machine)};
      await unchanged(config,link,client,pending?.completion?.link);save(pendingFlyApplyPath(config),pending);
    } else {
      const image=options.image===undefined?pending.plan.after.image:(await resolveFlyImage(options.image,{fetch:options.imageFetch,token:options.registryToken})).image;
      if((image!==pending.plan.after.image) || (options.volume!==undefined && options.volume!==pending.volume) || (options.machine!==undefined && options.machine!==pending.machine.id))throw new Error("Resume options conflict with the saved apply intent");
      linkedFlyTarget(link,{...options,app:options.app??pending.plan.app,region:options.region??pending.machine.region});
      if(!readPrivateFlyReplacement(config) && !pending.completion)await inspect(client,options.fly,link,{...options,app:options.app??pending.plan.app,volume:pending.volume,machine:pending.machine.id});
      const expected=await planFlyRuntime({app:pending.plan.app,machine:pending.machine,volume:pending.volume,image:pending.plan.after.image,artifact:pending.artifact,bundle:bundle(config,link)});
      if(canonicalConfigJson(expected)!==canonicalConfigJson(pending.plan))throw new Error("Private installation plan differs from its issued artifact");
    }
    const active=pending;
    const deadline=Date.now()+waitMs;
    let binding=active.completion?.binding??await client.getFlyBindingReceipt(link.deployment.id,active.artifact.instance.requestId);
    const verifyBinding=(receipt:FlyBindingReceipt,org:string,machineId:string)=>{
      const r=receipt.request;
      if(r.requestId!==active.artifact.instance.requestId || r.instanceId!==active.artifact.instance.instanceId || r.machineId!==machineId || r.imageDigest!==active.plan.after.image.split("@")[1] || r.previousMachineId!==active.machine.id || r.expectedConfigurationVersion!==link.configurationVersion || r.expectedSequence!==link.desiredSequence || r.revision!==link.revision || r.appName!==active.plan.app || r.orgSlug!==org || r.region!==active.machine.region || r.expectedImageDigest!==(link.target?.imageDigest??null) || r.previousImageDigest!==active.machine.image_ref.digest)throw new Error("Binding receipt differs from the saved apply intent; retain it for recovery");
    };
    const org=(await options.fly.app(active.plan.app)).organization.slug;
    if(link.target?.fly?.orgSlug!==undefined && link.target.fly.orgSlug!==org)throw new Error("Fly organization does not match the linked target");
    const guard=async()=>{
      await unchanged(config,link,client,active.completion?.link);const state=await current(client,active);
      if(state.stale || state.desired.configurationVersion!==(binding?.configurationVersion??link.configurationVersion))throw new Error("Configuration changed; retain apply state for recovery");
      if(options.signal?.aborted)throw new Error("Apply interrupted; resume when ready");
    };
    await guard();
    let replacement=readPrivateFlyReplacement(config),machineId=active.machine.id;
    const replacing=!(active.machine.config.mounts as unknown[]|undefined)?.length;
    if(replacement && !replacing)throw new Error("Unexpected replacement state; retain it for recovery");
    if(replacement){
      const plan=planFlyReplacement({id:active.artifact.instance.instanceId,app:active.plan.app,org,machine:active.machine,config:active.plan.after,volume:active.volume,volumes:[{id:active.volume,region:active.machine.region,state:"created",encrypted:true,attached_machine_id:null}]});
      if(canonicalConfigJson(replacement.plan)!==canonicalConfigJson(plan))throw new Error("Replacement state differs from the issued apply; retain it for recovery");
    }
    if(binding){
      const boundMachine=active.completion?.binding.request.machineId??(replacing?replacement?.machineId:active.machine.id);
      if(!boundMachine)throw new Error("Bound replacement state is missing; retain it for recovery");
      verifyBinding(binding,org,boundMachine);
      if(binding.request.previousConfigDigest!==await hashConfigDocument(active.rollback))throw new Error("Binding receipt differs from the saved rollback; retain it for recovery");
    }
    if(active.completion){replacement=active.completion.replacement;machineId=active.completion.binding.request.machineId;}
    else if(replacing){
      const store=new PrivateFlyReplacementStore(config);
      if(!replacement){
        const app=await options.fly.app(active.plan.app),plan=planFlyReplacement({id:active.artifact.instance.instanceId,app:active.plan.app,org:app.organization.slug,machine:active.machine,config:active.plan.after,volume:active.volume,volumes:await options.fly.volumes(active.plan.app)});
        await guard();await store.prepare({plan,phase:"prepared",machineId:null});
      }
      for(;;){
        try{replacement=await executeFlyReplacement(store,options.fly,{assertCurrent:guard});break;}
        catch(error){if(!(error instanceof FlyReplacementPending))throw error;if(Date.now()>=deadline)throw new Error("Fly handoff pending; run deploy fly --resume");await pause(pollMs,options.signal);}
      }
      machineId=replacement.machineId!;
    }else{await applyFlyMachine(options.fly,active.plan,{assertCurrent:guard});}
    const expected=replacement?.plan.after??active.plan.after;
    if(!binding){
      await guard();
      binding=await client.bindFlyReplacement(link.deployment.id,{requestId:active.artifact.instance.requestId,instanceId:active.artifact.instance.instanceId,expectedConfigurationVersion:link.configurationVersion,expectedSequence:link.desiredSequence,revision:link.revision,appName:active.plan.app,orgSlug:org,region:active.machine.region,previousMachineId:active.machine.id,expectedImageDigest:link.target?.imageDigest??null,previousImageDigest:active.machine.image_ref.digest,previousConfigDigest:await hashConfigDocument(active.rollback),machineId,imageDigest:active.plan.after.image.split("@")[1]!});
    }
    const bindingRequest=binding.request;
    verifyBinding(binding,org,machineId);
    const acknowledged=async()=>{
      await guard();const state=await current(client,active),machine=await options.fly.machine(active.plan.app,machineId);
      if(!matchesFlyConfig(machine.config,expected) || machine.image_ref.digest!==active.plan.after.image.split("@")[1])throw new Error("Fly machine changed while awaiting acknowledgement; retain apply state for recovery");
      return machine.state==="started" && state.lastReportSequence>0 && state.applied?.sequence===link.desiredSequence && state.applied.revision===link.revision;
    };
    while(!await acknowledged()){if(Date.now()>=deadline)throw new Error("Runtime acknowledgement pending; run deploy fly --resume");await pause(pollMs,options.signal);}
    const assertAccepted=async()=>{if(!await acknowledged())throw new Error("Accepted runtime changed; retain apply state for recovery");};
    if(!active.completion){
      if(await readPendingActivation(config))await finishLinkedActivation(client,config);
      const snapshot=await client.pullDeploymentConfig(link.deployment.id);
      const projected=await validateDeploymentLink({...link,configurationVersion:binding.configurationVersion,target:{kind:"fly",managed:false,imageDigest:bindingRequest.imageDigest,fly:{appName:bindingRequest.appName,machineId,region:bindingRequest.region,orgSlug:bindingRequest.orgSlug}}});
      if(snapshot.configurationVersion!==projected.configurationVersion || snapshot.desiredSequence!==link.desiredSequence || snapshot.revision!==link.revision || canonicalConfigJson(snapshot.target)!==canonicalConfigJson(projected.target))throw new Error("Remote binding changed before local synchronization; retain it for recovery");
      active.completion={binding,link:projected,replacement};await assertAccepted();save(pendingFlyApplyPath(config),active,true);
    }
    await assertAccepted();
    if(canonicalConfigJson(await readDeploymentLink(config))!==canonicalConfigJson(active.completion.link)){
      const path=`${resolve(config)}.logtura-link.json`,stage=`${path}.${randomUUID()}.tmp`;
      try{writeFileSync(stage,JSON.stringify(active.completion.link)+"\n",{flag:"wx",mode:0o600});flush(stage);await assertAccepted();renameSync(stage,path);flushParent(path);}finally{rmSync(stage,{force:true});}
    }
    if(replacement){
      const store=new PrivateFlyReplacementStore(config),assertAccepted=async()=>{if(!await acknowledged())throw new Error("Accepted runtime changed; retain replacement state for recovery");};
      if(readPrivateFlyReplacement(config))await store.archive(replacement,assertAccepted);
      else if(canonicalConfigJson(readPrivateFlyReplacementArchive(config,replacement.plan.id))!==canonicalConfigJson(replacement))throw new Error("Replacement archive is missing or changed; retain apply state for recovery");
    }
    await assertAccepted();
    const path=pendingFlyApplyPath(config),rollbackFile=resolve(dirname(path),`.logtura-applied-${active.artifact.instance.instanceId}.json`);
    try{linkSync(path,rollbackFile);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST" || !lstatSync(rollbackFile).isFile() || (process.platform!=="win32" && (lstatSync(rollbackFile).mode&0o077)!==0) || readFileSync(path,"utf8")!==readFileSync(rollbackFile,"utf8"))throw error;}
    flushParent(rollbackFile);rmSync(path);flushParent(path);
    return {app:active.plan.app,machineId,instanceId:active.artifact.instance.instanceId,revision:link.revision,image:active.plan.after.image,rollbackFile};
  },"Apply");
}

/** Explicitly archive an owned apply made obsolete by a newer instance/revision
 * or verified deployment deletion. Does not stop machines or change activation. */
export async function abandonObsoleteFlyApply(client:LogturaServiceClient,config:string):Promise<string> {
  return withPrivateDirectoryLock(resolve(dirname(resolve(config)),".logtura-apply.lock"),async()=>{
    assertTransactionClear(config);const pending=await readPendingFlyApply(config);
    if(!pending)throw new Error("No pending Fly apply to abandon");
    if(client.url!==pending.link.service || (await client.whoami()).id!==pending.link.accountId)throw new Error("Apply account or origin does not match the linked deployment");
    let obsolete=false;
    try{const state=await client.getDeploymentConfigurationState(pending.link.deployment.id);obsolete=!!state && (state.activeInstanceId!==pending.artifact.instance.instanceId || state.desired.sequence!==pending.link.desiredSequence || state.desired.revision!==pending.link.revision);}
    catch(error){if(error instanceof ServiceError && error.status===404 && error.code==="not_found")obsolete=true;else throw error;}
    if(!obsolete)throw new Error("Issued apply is still current; resume before recovery");
    if(readPrivateFlyReplacement(config))throw new Error("Pending replacement must be reconciled or rolled back before abandoning its apply; retain all recovery journals");
    if(await readPendingActivation(config))await abandonObsoleteLinkedActivation(client,config);
    const path=pendingFlyApplyPath(config),archive=resolve(dirname(path),`.logtura-abandoned-${pending.artifact.instance.instanceId}.json`);
    try{linkSync(path,archive);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST" || !lstatSync(archive).isFile() || (process.platform!=="win32" && (lstatSync(archive).mode&0o077)!==0) || readFileSync(path,"utf8")!==readFileSync(archive,"utf8"))throw error;}
    flushParent(archive);rmSync(path);flushParent(path);return archive;
  },"Apply");
}

async function pause(ms:number,signal?:AbortSignal):Promise<void>{
 if(signal?.aborted)throw new Error("Apply interrupted; resume when ready");
 await new Promise<void>(done=>{const onAbort=()=>{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);done();},timer=setTimeout(()=>{signal?.removeEventListener("abort",onAbort);done();},ms);signal?.addEventListener("abort",onAbort,{once:true});if(signal?.aborted)onAbort();});
}
