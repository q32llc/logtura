import {canonicalConfigJson} from "./config";
import {FlyMachinesClient,matchesFlyConfig,validateFlyMachine,type FlyMachine,type FlyVolume} from "./fly";
import {validateFlyRuntimeVolume} from "./fly-runtime";
import {validateFlyReplacementState,type FlyReplacementState} from "./fly-replacement";

export interface FlyReplacementCleanupPlan {
 schemaVersion:1;replacement:FlyReplacementState;survivor:FlyMachine;retired:FlyMachine;
}
export interface FlyReplacementCleanupState {
 plan:FlyReplacementCleanupPlan;phase:"prepared"|"deleting"|"deleted";
}
export interface FlyReplacementCleanupTransaction {
 read():Promise<FlyReplacementCleanupState>;
 compareAndSwap(expected:FlyReplacementCleanupState,next:FlyReplacementCleanupState):Promise<boolean>;
}
/** Exclusive durable claim for the whole operation; CAS must commit/fsync before
 * resolving. Complete provider configurations contain secrets: keep them private. */
export interface FlyReplacementCleanupStore {
 runExclusive<T>(operation:(transaction:FlyReplacementCleanupTransaction)=>Promise<T>):Promise<T>;
}
export class FlyReplacementCleanupPending extends Error {
 constructor(){super("Fly deletion outcome is pending or unknown; observe the saved cleanup without repeating deletion");this.name="FlyReplacementCleanupPending";}
}
function same(a:unknown,b:unknown):boolean{return canonicalConfigJson(a)===canonicalConfigJson(b);}
function quiescent(machine:FlyMachine):boolean{return ["created","stopped"].includes(machine.state);}
/** Explicit irreversible retirement after a terminal replacement or restoration.
 * Adapter authorization must additionally establish ownership and, for installed
 * candidates, accepted reporting from the current issued instance. Names/health
 * alone cannot authorize cleanup. The checkpoint volume is always retained. */
export function planFlyReplacementCleanup(input:{replacement:FlyReplacementState;machines:FlyMachine[]}):FlyReplacementCleanupPlan {
 const replacement=validateFlyReplacementState(input.replacement),plan=replacement.plan;
 if(!["installed","rolled_back"].includes(replacement.phase))throw new Error("Fly cleanup requires a terminal replacement or restoration");
 const machines=input.machines.map(validateFlyMachine),old=machines.find(machine=>machine.id===plan.before.id),candidate=machines.find(machine=>machine.id===replacement.machineId);
 if(machines.length!==2 || !old || !candidate || old.id===candidate.id)throw new Error("Fly cleanup requires exactly the saved old and candidate machines");
 if(old.region!==plan.before.region || old.image_ref.digest!==plan.before.image_ref.digest || !(same(old.config,plan.rollback) || old.instance_id===plan.before.instance_id && same(old.config,plan.before.config)))throw new Error("Previous Fly forwarder differs from its replacement journal");
 if(candidate.region!==plan.before.region || candidate.image_ref.digest!==plan.after.image.split("@")[1] || (candidate as FlyMachine & {name?:string}).name!==plan.name || !matchesFlyConfig(candidate.config,plan.after))throw new Error("Fly candidate differs from its replacement journal");
 const [survivor,retired]=replacement.phase==="installed"?[candidate,old]:[old,candidate];
 if(survivor!.state!=="started" || !quiescent(retired!) || replacement.phase==="rolled_back" && !same(old.config,plan.rollback))throw new Error("Fly cleanup requires its saved running survivor and quiescent retired machine");
 return {schemaVersion:1,replacement,survivor:survivor!,retired:retired!};
}
export function validateFlyReplacementCleanupState(value:FlyReplacementCleanupState):FlyReplacementCleanupState {
 try {
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==2 || !["prepared","deleting","deleted"].includes(value.phase) || !value.plan || Object.keys(value.plan).length!==4 || value.plan.schemaVersion!==1)throw new Error();
  const expected=planFlyReplacementCleanup({replacement:value.plan.replacement,machines:[value.plan.survivor,value.plan.retired]});
  if(!same(expected,value.plan))throw new Error();
  return structuredClone(value);
 }catch{throw new Error("Invalid private Fly cleanup state; retain it for recovery");}
}
function checkSnapshot(machine:FlyMachine,snapshot:FlyMachine):void {
 if(machine.instance_id!==snapshot.instance_id || machine.region!==snapshot.region || !same(machine.image_ref,snapshot.image_ref) || !same(machine.config,snapshot.config) || (machine as FlyMachine & {name?:string}).name!==(snapshot as FlyMachine & {name?:string}).name)throw new Error("Fly cleanup machine changed after planning; retain the journal");
}
/** Durable dispatch precedes DELETE. A deleting intent only observes outcomes;
 * it never dispatches a second DELETE, including after an uncertain response or
 * process death before dispatch. Both provider leases protect the handoff's
 * survivor/retired identities. No volume deletion or force-stop is performed. */
export async function executeFlyReplacementCleanup(store:FlyReplacementCleanupStore,client:FlyMachinesClient,options:{assertCurrent:()=>Promise<void>}):Promise<FlyReplacementCleanupState> {
 return store.runExclusive(async transaction=>{
  let state=validateFlyReplacementCleanupState(await transaction.read());const plan=state.plan,app=plan.replacement.plan.app;
  const guard=async()=>{await options.assertCurrent();if(!same(await transaction.read(),state))throw new Error("Fly cleanup journal changed during execution");};
  const save=async(phase:FlyReplacementCleanupState["phase"])=>{const next={plan,phase};await guard();if(!await transaction.compareAndSwap(state,next))throw new Error("Fly cleanup journal changed before transition");state=validateFlyReplacementCleanupState(next);};
  const observe=async()=>{
   await guard();const inventory=await client.machines(app),survivors=inventory.filter(machine=>machine.id===plan.survivor.id),retired=inventory.filter(machine=>machine.id===plan.retired.id);
   if(survivors.length!==1 || retired.length>1 || inventory.length!==survivors.length+retired.length)throw new Error("Fly cleanup inventory differs from its saved identities");
   const survivor=survivors[0]!;checkSnapshot(survivor,plan.survivor);
   if(survivor.state!=="started")throw new Error("Fly cleanup survivor is no longer running");
   if(retired[0]){checkSnapshot(retired[0],plan.retired);if(!quiescent(retired[0]))throw new Error("Fly cleanup retired machine is no longer quiescent");}
   const candidate=plan.replacement.phase==="installed"?survivor:retired[0],volumes=await client.volumes(app),volume=volumes.filter(item=>item.id===plan.replacement.plan.volume);
   if(volume.length!==1 || volume[0]!.attached_machine_id!==(candidate?.id??null))throw new Error("Fly cleanup checkpoint attachment changed");
   validateFlyRuntimeVolume(candidate??survivor,volumes,plan.replacement.plan.volume);
   await guard();return retired[0];
  };
  await guard();if((await client.app(app)).organization.slug!==plan.replacement.plan.org)throw new Error("Fly cleanup organization changed");
  let retired=await observe();
  if(state.phase==="deleted"){if(retired)throw new Error("Deleted Fly machine reappeared; retain the cleanup journal");return state;}
  if(state.phase==="prepared" && !retired)throw new Error("Fly cleanup machine disappeared before dispatch; retain the journal");
  if(state.phase==="deleting" && retired)throw new FlyReplacementCleanupPending();
  const survivorNonce=await client.lease(app,plan.survivor.id);let retiredNonce:string|undefined,confirmedAbsent=false,failure:unknown;
  try {
   if(retired)retiredNonce=await client.lease(app,plan.retired.id);
   retired=await observe();
   if(state.phase==="prepared"){
    if(!retired)throw new Error("Fly cleanup machine disappeared before dispatch; retain the journal");
    await save("deleting");await guard();await client.destroy(app,plan.retired.id,retiredNonce!);
    retired=await observe();if(retired)throw new FlyReplacementCleanupPending();
   }else if(retired)throw new FlyReplacementCleanupPending();
   confirmedAbsent=true;await save("deleted");return state;
  }catch(error){failure=error;throw error;}
  finally {
   let releaseFailure:unknown;
   if(retiredNonce!==undefined && !confirmedAbsent)try{await client.release(app,plan.retired.id,retiredNonce);}catch(error){releaseFailure=error;}
   try{await client.release(app,plan.survivor.id,survivorNonce);}catch(error){releaseFailure??=error;}
   if(failure===undefined && releaseFailure!==undefined)throw releaseFailure;
  }
 });
}
