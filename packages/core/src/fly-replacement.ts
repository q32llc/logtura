import {canonicalConfigJson} from "./config";
import {FlyMachinesClient,flyRollbackConfig,immutableFlyImage,matchesFlyConfig,validateFlyMachine,type FlyMachine,type FlyMachineConfig,type FlyVolume} from "./fly";
import {FLY_RUNTIME_DIRECTORY,validateFlyRuntimeVolume} from "./fly-runtime";

export interface FlyReplacementPlan {
  schemaVersion:1;id:string;app:string;org:string;name:string;
  before:FlyMachine;after:FlyMachineConfig;rollback:FlyMachineConfig;volume:string;
}
export type FlyReplacementPhase="prepared"|"creating"|"created"|"switching"|"installed"|"rolling_back"|"rolled_back";
export interface FlyReplacementState {plan:FlyReplacementPlan;phase:FlyReplacementPhase;machineId:string|null;}
/** The adapter must hold an exclusive durable claim for the whole operation.
 * compareAndSwap must commit/fsync before resolving. Unknown create dispatches
 * are never repeated, including a crash between the journal write and POST.
 * Generated files, environment and rollback payloads require private storage. */
export interface FlyReplacementTransaction {
  read():Promise<FlyReplacementState>;
  compareAndSwap(expected:FlyReplacementState,next:FlyReplacementState):Promise<boolean>;
}
export interface FlyReplacementStore {
  runExclusive<T>(operation:(transaction:FlyReplacementTransaction)=>Promise<T>):Promise<T>;
}
const phases:FlyReplacementPhase[]=["prepared","creating","created","switching","installed","rolling_back","rolled_back"];
function empty(value:unknown):boolean{return value===undefined || Array.isArray(value) && value.length===0;}
function exact(actual:FlyMachineConfig,planned:FlyMachineConfig):boolean{return canonicalConfigJson(actual)===canonicalConfigJson(planned);}
/** Mountless, private forwarders can be replaced while keeping their old VM
 * intact for rollback. Existing volumes/public routing require a separate
 * transfer strategy; this operation never copies or shares attached storage. */
export function planFlyReplacement(input:{id:string;app:string;org:string;machine:FlyMachine;config:FlyMachineConfig;volume:string;volumes:FlyVolume[]}):FlyReplacementPlan {
  const before=validateFlyMachine(input.machine);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.app) || !/^[a-z0-9-]{1,63}$/.test(input.org))throw new Error("Invalid Fly replacement identity");
  if(!empty(before.config.mounts) || !empty(before.config.services) || !empty(before.config.containers) || !empty(before.config.processes) || !empty(before.config.volumes) || !empty(before.config.standbys) || before.config.schedule || before.config.auto_destroy || !["started","stopped","created","suspended"].includes(before.state))throw new Error("Fly replacement requires one mountless private forwarder");
  immutableFlyImage(input.config.image);
  const volume=validateFlyRuntimeVolume(before,input.volumes,input.volume),selected=input.volumes.find(candidate=>candidate.id===volume)!;
  if(selected.attached_machine_id!==null)throw new Error("Fly replacement checkpoint must be unattached");
  const after=structuredClone(input.config);
  if(!Array.isArray(after.mounts) || after.mounts.length!==1 || canonicalConfigJson(after.mounts[0])!==canonicalConfigJson({path:FLY_RUNTIME_DIRECTORY,volume}) || !empty(after.services) || !empty(after.containers) || !empty(after.processes) || !empty(after.volumes) || !empty(after.standbys) || after.schedule || after.auto_destroy)throw new Error("Fly replacement configuration conflicts with the checkpoint or private lifecycle");
  if(after.metadata!==undefined && (!after.metadata || typeof after.metadata!=="object" || Array.isArray(after.metadata)))throw new Error("Invalid Fly replacement metadata");
  after.metadata={...(after.metadata as Record<string,unknown>??{}),"logtura.replacement":input.id};
  return {schemaVersion:1,id:input.id,app:input.app,org:input.org,name:`forwarder-${input.id}`,before,after,rollback:flyRollbackConfig(before),volume};
}
/** Reconstruct and compare immutable recovery inputs, including the actual old
 * OCI digest and every setting/file/environment byte. Caller data is cloned. */
export function validateFlyReplacementState(value:FlyReplacementState):FlyReplacementState {
  try {
    if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==3 || !phases.includes(value.phase) || (value.machineId!==null && !/^[a-zA-Z0-9_-]{1,128}$/.test(value.machineId)) || !value.plan || Object.keys(value.plan).length!==9 || value.plan.schemaVersion!==1)throw new Error();
    const plan=value.plan,expected=planFlyReplacement({id:plan.id,app:plan.app,org:plan.org,machine:plan.before,config:plan.after,volume:plan.volume,volumes:[{id:plan.volume,region:plan.before.region,state:"created",encrypted:true,attached_machine_id:null}]});
    if(canonicalConfigJson(expected)!==canonicalConfigJson(plan) || (["prepared","creating"].includes(value.phase)?value.machineId!==null:value.machineId===null) || value.machineId===plan.before.id)throw new Error();
    return structuredClone(value);
  }catch{throw new Error("Invalid private Fly replacement state; retain it for recovery");}
}
function checkOld(machine:FlyMachine,plan:FlyReplacementPlan):void {
  if(machine.id!==plan.before.id || machine.region!==plan.before.region || machine.image_ref.digest!==plan.before.image_ref.digest || !(exact(machine.config,plan.rollback) || machine.instance_id===plan.before.instance_id && exact(machine.config,plan.before.config)))throw new Error("Previous Fly forwarder changed; retain replacement state for recovery");
}
function checkCandidate(machine:FlyMachine,plan:FlyReplacementPlan):void {
  if(machine.id===plan.before.id || machine.region!==plan.before.region || machine.image_ref.digest!==plan.after.image.split("@")[1] || (machine as FlyMachine & {name?:string}).name!==plan.name || !matchesFlyConfig(machine.config,plan.after))throw new Error("Fly candidate differs from the saved replacement");
}
/** One bounded provider step. Async transitions remain recoverable by the next
 * invocation. No ownership, issuance, acknowledgement or success is inferred
 * from health; assertCurrent must fence the adapter's desired instance/target. */
export async function executeFlyReplacement(store:FlyReplacementStore,client:FlyMachinesClient,options:{rollback?:boolean;assertCurrent:()=>Promise<void>}):Promise<FlyReplacementState> {
  return store.runExclusive(async transaction=>{
    let state=validateFlyReplacementState(await transaction.read());const plan=state.plan;
    const guard=async()=>{await options.assertCurrent();if(canonicalConfigJson(await transaction.read())!==canonicalConfigJson(state))throw new Error("Fly replacement journal changed during execution");};
    const save=async(phase:FlyReplacementPhase,machineId=state.machineId)=>{const next={plan,phase,machineId};await guard();if(!await transaction.compareAndSwap(state,next))throw new Error("Fly replacement journal changed before transition");state=validateFlyReplacementState(next);};
    await guard();
    if((await client.app(plan.app)).organization.slug!==plan.org)throw new Error("Fly replacement organization changed");
    const inventory=await client.machines(plan.app),old=inventory.find(machine=>machine.id===plan.before.id);
    if(!old || inventory.filter(machine=>machine.id===plan.before.id).length!==1 || inventory.some(machine=>machine.id!==plan.before.id && (state.machineId===null?(machine as FlyMachine & {name?:string}).name!==plan.name:machine.id!==state.machineId)))throw new Error("Fly replacement requires exactly its saved old and candidate machines");
    checkOld(old,plan);
    const candidates=inventory.filter(machine=>machine.id!==plan.before.id);
    if(candidates.length>1)throw new Error("Fly replacement candidate observation is ambiguous");
    let candidate=candidates[0];if(candidate)checkCandidate(candidate,plan);
    if(state.machineId!==null && candidate?.id!==state.machineId)throw new Error("Fly replacement candidate disappeared; retain state for recovery");
    const checkpoint=async(machine:FlyMachine|undefined)=>{
      const volumes=await client.volumes(plan.app),volume=volumes.filter(item=>item.id===plan.volume);
      if(volume.length!==1 || volume[0]!.attached_machine_id!==(machine?.id??null))throw new Error("Fly replacement checkpoint attachment changed");
      validateFlyRuntimeVolume(machine??plan.before,volumes,plan.volume);
    };
    if(!options.rollback)await checkpoint(candidate);
    if(options.rollback && ["prepared","creating"].includes(state.phase)) {
      // A lost create response must first be reconciled, even for rollback.
      if(!candidate)throw new Error("Fly replacement create outcome is unknown; retain state for recovery");
      await save("created",candidate.id);
    }
    if(!options.rollback && state.phase==="rolled_back")throw new Error("Fly replacement was rolled back; prepare a new issued instance");
    if(!options.rollback && state.phase==="rolling_back")throw new Error("Fly replacement rollback is pending; resume rollback");
    if(!options.rollback && ["prepared","creating"].includes(state.phase)) {
      if(candidate){if(state.phase!=="creating")throw new Error("Fly candidate exists without a dispatched replacement");await save("created",candidate.id);}
      else {
        if(state.phase!=="prepared")throw new Error("Fly replacement create outcome is unknown; retain state for recovery");
        await save("creating");await guard();
        candidate=await client.create(plan.app,{name:plan.name,region:plan.before.region,config:plan.after,skipLaunch:true});
        checkCandidate(candidate,plan);if(!["created","stopped"].includes(candidate.state))throw new Error("Fly replacement candidate launched before handoff");
        await save("created",candidate.id);
      }
    }
    if(!candidate)throw new Error("Fly replacement candidate is unavailable");
    // Keep both provider leases during handoff. Re-read after each lease because
    // an inventory is only a snapshot, not authority to stop/start a machine.
    const oldNonce=await client.lease(plan.app,old.id);let candidateNonce:string|undefined,failure:unknown;
    try {
      candidateNonce=await client.lease(plan.app,candidate.id);
      const rereadOld=await client.machine(plan.app,old.id),rereadCandidate=await client.machine(plan.app,candidate.id);
      checkOld(rereadOld,plan);checkCandidate(rereadCandidate,plan);await guard();
      if(!options.rollback)await checkpoint(rereadCandidate);
      if(options.rollback){
        if(state.phase!=="rolled_back")await save("rolling_back");
        if(!["created","stopped","suspended"].includes(rereadCandidate.state)){await guard();await client.stop(plan.app,candidate.id,candidateNonce);}
        const stopped=await client.machine(plan.app,candidate.id);checkCandidate(stopped,plan);
        if(!["created","stopped","suspended"].includes(stopped.state))throw new Error("Fly candidate stop is pending; resume rollback");
        await guard();
        if(!exact(rereadOld.config,plan.rollback)){await client.update(plan.app,old.id,plan.rollback,rereadOld.instance_id,oldNonce);}
        const restored=await client.machine(plan.app,old.id);checkOld(restored,plan);
        if(!exact(restored.config,plan.rollback))throw new Error("Previous Fly configuration was not restored");
        if(restored.state!=="started"){await guard();await client.start(plan.app,old.id,oldNonce);}
        const running=await client.machine(plan.app,old.id);checkOld(running,plan);
        if(running.state!=="started")throw new Error("Previous Fly start is pending; resume rollback");
        if(state.phase!=="rolled_back")await save("rolled_back");
      } else {
        if(state.phase==="created" && !["created","stopped"].includes(rereadCandidate.state))throw new Error("Fly candidate started outside the saved handoff");
        if(state.phase==="created")await save("switching");
        if(!["created","stopped"].includes(rereadOld.state)){await guard();await client.stop(plan.app,old.id,oldNonce);}
        const stopped=await client.machine(plan.app,old.id);checkOld(stopped,plan);
        if(!["created","stopped"].includes(stopped.state))throw new Error("Previous Fly stop is pending; resume replacement");
        if(rereadCandidate.state!=="started"){await guard();await client.start(plan.app,candidate.id,candidateNonce);}
        const running=await client.machine(plan.app,candidate.id);checkCandidate(running,plan);
        if(running.state!=="started" || running.image_ref.digest!==plan.after.image.split("@")[1])throw new Error("Fly candidate start is pending; resume replacement");
        if(state.phase!=="installed")await save("installed");
      }
      return state;
    } catch(error){failure=error;throw error;}
    finally {
      let releaseFailure:unknown;
      if(candidateNonce!==undefined)try{await client.release(plan.app,candidate.id,candidateNonce);}catch(error){releaseFailure=error;}
      try{await client.release(plan.app,old.id,oldNonce);}catch(error){releaseFailure??=error;}
      if(failure===undefined && releaseFailure!==undefined)throw releaseFailure;
    }
  });
}
