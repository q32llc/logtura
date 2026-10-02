import {
  FlyMachinesClient, applyFlyMachine, compileForwarderRuntime, generateBundle, parseDeploymentManifest,
  planFlyRuntime, matchesFlyConfig, validateFlyRuntimeVolume, immutableFlyImage, flyRollbackConfig, validateFlyMachine,
  validateForwarderRuntimeArtifact, canonicalConfigJson, GENERATOR_VERSION, VECTOR_VERSION,
  ServiceError, type LogturaServiceClient, type FlyMachine, type FlyMachinePlan, type FlyMachineConfig, type ForwarderRuntimeArtifact,
} from "@logtura/core";
import { constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,linkSync,rmSync } from "node:fs";
import { resolve,dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { withPrivateDirectoryLock } from "./private-lock";
import { readDeploymentLink,validateDeploymentLink,deploymentStatus,type DeploymentLink } from "./deployment-link";
import { activateLinkedDeployment,readPendingActivation,finishLinkedActivation,abandonObsoleteLinkedActivation } from "./activation";
import { pendingFlyApplyPath,assertNoPendingPush,assertTransactionClear } from "./file-transaction";
import { linkedFlyTarget,type FlyTargetOptions } from "./fly-target";
import { readConfigEnvironment } from "./config";
import { listProviders,listDestinations } from "./registry";

/** Contains resolved machine payloads. Mode 0600, never public logs/CI artifacts. */
export interface PendingFlyApply {
  schemaVersion:1;config:string;link:DeploymentLink;machine:FlyMachine;volume:string;
  artifact:ForwarderRuntimeArtifact;plan:FlyMachinePlan;rollback:FlyMachineConfig;
}
function flush(path:string):void {const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function flushParent(path:string):void {if(process.platform!=="win32")flush(dirname(path));}
function save(path:string,value:PendingFlyApply):void {
  const stage=`${path}.${randomUUID()}.tmp`;
  try{const serialized=JSON.stringify(value)+"\n";if(Buffer.byteLength(serialized)>16_777_216)throw new Error("Private apply state exceeds its recovery reader limit");writeFileSync(stage,serialized,{flag:"wx",mode:0o600});flush(stage);linkSync(stage,path);}finally{rmSync(stage,{force:true});}
  flushParent(path);
}
export async function readPendingFlyApply(config:string):Promise<PendingFlyApply|null> {
  const path=pendingFlyApplyPath(config);
  try{if(!lstatSync(path).isFile())throw new Error();}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("Apply state must be a private regular file");}
  let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{throw new Error("Apply state must be a private regular file");}
  let value:PendingFlyApply;
  try{const stat=fstatSync(fd);if(!stat.isFile() || stat.size>16_777_216 || (process.platform!=="win32" && (stat.mode&0o077)!==0))throw new Error();value=JSON.parse(readFileSync(fd,"utf8")) as PendingFlyApply;}catch{throw new Error("Invalid private apply state; retain it for recovery");}finally{closeSync(fd);}
  try{
    if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==8 || Object.keys(value).some(key=>!["schemaVersion","config","link","machine","volume","artifact","plan","rollback"].includes(key)) || value.schemaVersion!==1 || value.config!==resolve(config))throw new Error();
    value.link=await validateDeploymentLink(value.link);value.machine=validateFlyMachine(value.machine);value.artifact=await validateForwarderRuntimeArtifact(value.artifact);
    const target=linkedFlyTarget(value.link,{app:value.plan.app,region:value.machine.region});
    if(target.appName!==value.plan.app || value.plan.machineId!==value.machine.id || value.plan.version!==value.machine.instance_id || canonicalConfigJson(value.plan.before)!==canonicalConfigJson(value.machine.config) || canonicalConfigJson(value.rollback)!==canonicalConfigJson(flyRollbackConfig(value.machine)) || value.artifact.deploymentId!==value.link.deployment.id || value.artifact.service!==value.link.service || canonicalConfigJson(value.artifact.document)!==canonicalConfigJson(value.link.document) || value.artifact.instance.sequence!==value.link.desiredSequence || value.artifact.instance.configurationVersion!==value.link.configurationVersion || value.artifact.generatorVersion!==GENERATOR_VERSION || value.artifact.vectorVersion!==VECTOR_VERSION || !/^vol_[a-z0-9]+$/.test(value.volume))throw new Error();
    immutableFlyImage(value.plan.after.image);
  }catch{throw new Error("Invalid private apply state; retain it for recovery");}
  return value;
}
async function unchanged(config:string,link:DeploymentLink,client:LogturaServiceClient):Promise<void> {
  if(client.url!==link.service || (await client.whoami()).id!==link.accountId)throw new Error("Apply account or origin does not match the linked deployment");
  const current=await readDeploymentLink(config),status=await deploymentStatus(config);
  if(canonicalConfigJson(current)!==canonicalConfigJson(link) || !status.linked || status.changes.length || status.privateChanges.length)throw new Error("Local configuration changed; retain apply state for recovery");
}
function bundle(config:string,link:DeploymentLink) {
  const parsed=parseDeploymentManifest(link.document,{env:readConfigEnvironment(config),providers:listProviders(),destinations:listDestinations()});
  if(parsed.missingEnv.length)throw new Error("Linked apply requires all referenced private payloads");return generateBundle(parsed.input);
}
async function inspect(fly:FlyMachinesClient,link:DeploymentLink,options:FlyTargetOptions & {machine?:string;volume?:string}) {
  const target=linkedFlyTarget(link,options),app=await fly.app(target.appName);
  if(target.org!==undefined && app.organization.slug!==target.org)throw new Error("Fly organization does not match the linked target");
  const machines=await fly.machines(target.appName);
  // One issuance/counter store can represent only one physical forwarder.
  if(machines.length!==1 || (options.machine!==undefined && machines[0]!.id!==options.machine))throw new Error("Linked apply requires exactly one existing Fly forwarder machine");
  const machine=machines[0]!;if(machine.region!==target.region)throw new Error("Fly machine region does not match the linked target");
  const volume=validateFlyRuntimeVolume(machine,await fly.volumes(target.appName),options.volume);
  flyRollbackConfig(machine);return {target,machine,volume};
}
async function current(client:LogturaServiceClient,pending:PendingFlyApply) {
  const state=await client.getDeploymentConfigurationState(pending.link.deployment.id);
  if(!state || state.activeInstanceId!==pending.artifact.instance.instanceId || state.desired.sequence!==pending.link.desiredSequence || state.desired.revision!==pending.link.revision)throw new Error("Issued runtime is no longer current; retain apply state for recovery");return state;
}
/** Read-only preflight precedes issuance. Installation intent, including immutable
 * rollback image/config, is flushed before any Fly write. Resume reuses the exact
 * descriptor and checkpoint volume and observes an accepted report before success.
 * Caller may cancel waiting; it never discards an uncertain installation. */
export async function applyLinkedFlyDeployment(client:LogturaServiceClient,config:string,options:FlyTargetOptions & {fly:FlyMachinesClient;image?:string;volume?:string;machine?:string;resume?:boolean;waitMs?:number;pollMs?:number;signal?:AbortSignal}):Promise<{app:string;machineId:string;instanceId:string;revision:string;image:string;rollbackFile:string}> {
  return withPrivateDirectoryLock(resolve(dirname(resolve(config)),".logtura-apply.lock"),async()=>{
    assertTransactionClear(config);
    const waitMs=options.waitMs??300_000,pollMs=options.pollMs??2_000;
    if(!Number.isSafeInteger(waitMs) || waitMs<1 || waitMs>600_000 || !Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>30_000)throw new Error("Invalid apply wait interval");
    let pending=await readPendingFlyApply(config);const activation=await readPendingActivation(config);
    if(!!(pending || activation)!==(options.resume===true))throw new Error(pending || activation?"Pending apply; run deploy fly --resume":"No pending apply to resume");
    const link=pending?.link??activation?.link??await readDeploymentLink(config);if(!link)throw new Error("Pull a hosted deployment before applying");
    await unchanged(config,link,client);
    if(options.signal?.aborted)throw new Error("Apply interrupted; resume when ready");
    if(!pending){
      if(!activation)assertNoPendingPush(config);
      const image=immutableFlyImage(options.image??"");
      const inspected=await inspect(options.fly,link,options);
      // Render/size/credential/target checks before retiring the previous instance.
      const dry={requestId:randomUUID(),instanceId:randomUUID(),configurationVersion:link.configurationVersion,sequence:link.desiredSequence,revision:link.revision};
      const compiled=await compileForwarderRuntime({service:link.service,deploymentId:link.deployment.id,document:link.document,instance:dry,env:readConfigEnvironment(config),providers:listProviders(),destinations:listDestinations()});
      await planFlyRuntime({app:inspected.target.appName,machine:inspected.machine,volume:inspected.volume,image,...compiled});
      const receipt=await activateLinkedDeployment(client,config,{resume:!!activation});
      const issued=await compileForwarderRuntime({service:link.service,deploymentId:link.deployment.id,document:link.document,instance:receipt,env:readConfigEnvironment(config),providers:listProviders(),destinations:listDestinations()});
      const plan=await planFlyRuntime({app:inspected.target.appName,machine:inspected.machine,volume:inspected.volume,image,...issued});
      pending={schemaVersion:1,config:resolve(config),link,machine:inspected.machine,volume:inspected.volume,artifact:issued.artifact,plan,rollback:flyRollbackConfig(inspected.machine)};
      await unchanged(config,link,client);save(pendingFlyApplyPath(config),pending);
    } else {
      if((options.image!==undefined && options.image!==pending.plan.after.image) || (options.volume!==undefined && options.volume!==pending.volume) || (options.machine!==undefined && options.machine!==pending.machine.id))throw new Error("Resume options conflict with the saved apply intent");
      await inspect(options.fly,link,{...options,app:options.app??pending.plan.app,volume:pending.volume,machine:pending.machine.id});
      const expected=await planFlyRuntime({app:pending.plan.app,machine:pending.machine,volume:pending.volume,image:pending.plan.after.image,artifact:pending.artifact,bundle:bundle(config,link)});
      if(canonicalConfigJson(expected)!==canonicalConfigJson(pending.plan))throw new Error("Private installation plan differs from its issued artifact");
    }
    await unchanged(config,link,client);await current(client,pending);
    if(options.signal?.aborted)throw new Error("Apply interrupted; resume when ready");
    await applyFlyMachine(options.fly,pending.plan);
    const deadline=Date.now()+waitMs;
    for(;;){
      await unchanged(config,link,client);const state=await current(client,pending),machine=await options.fly.machine(pending.plan.app,pending.machine.id);
      if(!matchesFlyConfig(machine.config,pending.plan.after))throw new Error("Fly machine changed while awaiting acknowledgement; retain apply state for recovery");
      if(machine.state==="started" && machine.image_ref.digest===pending.plan.after.image.split("@")[1] && state.lastReportSequence>0 && !state.stale && state.applied?.sequence===pending.link.desiredSequence && state.applied.revision===pending.link.revision){
        // If the previous process died after clearing activation, the apply journal
        // still fences writes and the same accepted state permits completion.
        if(await readPendingActivation(config))await finishLinkedActivation(client,config);
        const path=pendingFlyApplyPath(config),rollbackFile=resolve(dirname(path),`.logtura-applied-${pending.artifact.instance.instanceId}.json`);
        // Publish without overwriting a different recovery record.
        try{linkSync(path,rollbackFile);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST" || (!lstatSync(rollbackFile).isFile() || (process.platform!=="win32" && (lstatSync(rollbackFile).mode&0o077)!==0) || readFileSync(path,"utf8")!==readFileSync(rollbackFile,"utf8")))throw error;}
        flushParent(rollbackFile);rmSync(path);flushParent(path);
        return {app:pending.plan.app,machineId:pending.machine.id,instanceId:pending.artifact.instance.instanceId,revision:link.revision,image:pending.plan.after.image,rollbackFile};
      }
      if(options.signal?.aborted || Date.now()>=deadline)throw new Error("Runtime acknowledgement pending; run deploy fly --resume");
      await new Promise<void>(done=>{const signal=options.signal,onAbort=()=>{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);done();},timer=setTimeout(()=>{signal?.removeEventListener("abort",onAbort);done();},Math.min(pollMs,Math.max(1,deadline-Date.now())));signal?.addEventListener("abort",onAbort,{once:true});if(signal?.aborted)onAbort();});
    }
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
    if(await readPendingActivation(config))await abandonObsoleteLinkedActivation(client,config);
    const path=pendingFlyApplyPath(config),archive=resolve(dirname(path),`.logtura-abandoned-${pending.artifact.instance.instanceId}.json`);
    try{linkSync(path,archive);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST" || !lstatSync(archive).isFile() || (process.platform!=="win32" && (lstatSync(archive).mode&0o077)!==0) || readFileSync(path,"utf8")!==readFileSync(archive,"utf8"))throw error;}
    flushParent(archive);rmSync(path);flushParent(path);return archive;
  },"Apply");
}
