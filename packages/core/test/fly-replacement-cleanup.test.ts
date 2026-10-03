import {expect,it,vi} from "vitest";
import {FlyMachinesClient,type FlyMachine,type FlyVolume} from "../src/fly";
import {planFlyReplacement,type FlyReplacementState} from "../src/fly-replacement";
import {executeFlyReplacementCleanup,planFlyReplacementCleanup,validateFlyReplacementCleanupState,FlyReplacementCleanupPending,type FlyReplacementCleanupState,type FlyReplacementCleanupStore} from "../src/fly-replacement-cleanup";
const id="00000000-0000-4000-8000-000000000001",image=`registry.test/new@sha256:${"a".repeat(64)}`;
function fixture(rollback=false){
 const before:FlyMachine & {name:string}={id:"old",name:"forwarder",instance_id:"old_version",state:"started",region:"ord",config:{image:"registry.test/old:latest",env:{PRIVATE:"preserve-exact"},files:[{guest_path:"/etc/vector/vector.yaml",raw_value:"b2xk",mode:0o400}],guest:{memory_mb:512},init:{cmd:["--config","/etc/vector/vector.yaml"]}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};
 const volume:FlyVolume={id:"vol_new",region:"ord",encrypted:true,state:"created",attached_machine_id:null};
 const plan=planFlyReplacement({id,app:"app",org:"personal",machine:before,volume:volume.id,volumes:[volume],config:{...before.config,image,mounts:[{path:"/var/lib/logtura",volume:volume.id}],env:{PRIVATE:"new"}}});
 const candidate:FlyMachine & {name:string}={id:"new",name:plan.name,instance_id:"new_version",state:rollback?"stopped":"started",region:"ord",config:structuredClone(plan.after),image_ref:{registry:"registry.test",repository:"new",digest:`sha256:${"a".repeat(64)}`}};
 const replacement:FlyReplacementState={plan,phase:rollback?"rolled_back":"installed",machineId:candidate.id};
 let machines:FlyMachine[]=[{...before,state:rollback?"started":"stopped",...(rollback?{config:structuredClone(plan.rollback),instance_id:"restored_version"}:{})},candidate],volumes=[{...volume,attached_machine_id:"new"}];
 let state:FlyReplacementCleanupState={plan:planFlyReplacementCleanup({replacement,machines}),phase:"prepared"},mode="normal",claimed=false,casCount=0,casFailAt=0,guardCount=0;
 const calls:Array<{method:string;path:string;nonce?:string}>=[],events:string[]=[];
 let onGuard:undefined|(()=>Promise<void>),onLease:undefined|((machine:FlyMachine)=>void);
 const fetcher:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname,method=init!.method!,match=path.match(/\/machines\/([^/]+)(?:\/(.*))?$/),machine=machines.find(item=>item.id===match?.[1]);
  calls.push({path,method,nonce:(init!.headers as Record<string,string>)["fly-machine-lease-nonce"]});
  if(path.endsWith("/lease")){
   if(method==="DELETE"){
    if(mode==="release-failed")return new Response("private provider payload",{status:500});
    return new Response(null,{status:204});
   }
   if(mode==="retired-lease-failed" && match![1]===state.plan.retired.id)return new Response("private",{status:409});
   if(machine)onLease?.(machine);
   return Response.json({data:{nonce:`lease-${match![1]}`}});
  }
  if(path.endsWith("/volumes"))return Response.json(volumes);
  if(path.endsWith("/machines"))return Response.json(machines);
  if(method==="DELETE" && machine){
   expect(new URL(String(url)).search).toBe("");expect(state.phase).toBe("deleting");expect(claimed).toBe(true);
   expect(machine.state).toMatch(/^(created|stopped)$/);expect((init!.headers as Record<string,string>)["fly-machine-lease-nonce"]).toBe(`lease-${machine.id}`);
   events.push("delete");if(mode==="delete-before-commit-loss")throw new Error("lost delete");
   if(mode!=="delete-pending"){
    machines=machines.filter(item=>item.id!==machine.id);for(const v of volumes)if(v.attached_machine_id===machine.id)v.attached_machine_id=null;
   }
   if(mode==="delete-loss")throw new Error("lost delete");
   if(mode==="delete-survivor-edit")machines[0]!.config.env={PRIVATE:"changed"};
   return new Response(null,{status:204});
  }
  return Response.json({name:"app",organization:{slug:mode==="org-changed"?"foreign":"personal"}});
 };
 const store:FlyReplacementCleanupStore={async runExclusive(operation){if(claimed)throw new Error("busy");claimed=true;try{return await operation({read:async()=>structuredClone(state),compareAndSwap:async(expected,next)=>{expect(state).toEqual(expected);casCount++;events.push(`save:${next.phase}`);if(casCount===casFailAt)return false;state=structuredClone(next);return true;}});}finally{claimed=false;}}};
 const guard=vi.fn(async()=>{guardCount++;await onGuard?.();if(mode==="not-current")throw new Error("ownership changed");});
 const client=new FlyMachinesClient({token:"private",fetch:fetcher});
 return {replacement,client,store,guard,calls,events,run:()=>executeFlyReplacementCleanup(store,client,{assertCurrent:guard}),get state(){return state;},set state(value:FlyReplacementCleanupState){state=value;},get machines(){return machines;},set machines(value:FlyMachine[]){machines=value;},get volumes(){return volumes;},set volumes(value:FlyVolume[]){volumes=value as typeof volumes;},set mode(value:string){mode=value;},set casFailAt(value:number){casFailAt=value;},set onGuard(value:typeof onGuard){onGuard=value;},set onLease(value:typeof onLease){onLease=value;},get guardCount(){return guardCount;},get claimed(){return claimed;}};
}
function deletions(f:ReturnType<typeof fixture>){return f.calls.filter(call=>call.method==="DELETE" && !call.path.endsWith("/lease"));}
it.each([false,true])("retires only the saved quiescent machine after rollback=%s, retains storage, and rechecks completed work",async rollback=>{
 const f=fixture(rollback),saved=structuredClone(f.state),result=await f.run();
 expect(result.phase).toBe("deleted");expect(f.events).toEqual(["save:deleting","delete","save:deleted"]);
 expect(f.machines.map(machine=>[machine.id,machine.state])).toEqual([[rollback?"old":"new","started"]]);expect(result.plan).toEqual(saved.plan);
 expect(f.volumes).toHaveLength(1);expect(f.volumes[0]!.attached_machine_id).toBe(rollback?null:"new");
 expect(deletions(f)).toEqual([{method:"DELETE",path:`/v1/apps/app/machines/${rollback?"new":"old"}`,nonce:`lease-${rollback?"new":"old"}`}]);
 const guardCount=f.guardCount;await f.run();expect(f.guardCount).toBeGreaterThan(guardCount);expect(deletions(f)).toHaveLength(1);
 expect(f.calls.filter(call=>call.path.endsWith("/lease") && call.method==="DELETE")).toHaveLength(1);
});
it("captures a created unlaunched retired candidate for explicit rollback cleanup",async()=>{
 const f=fixture(true);f.machines[1]!.state="created";f.state={plan:planFlyReplacementCleanup({replacement:f.replacement,machines:f.machines}),phase:"prepared"};await f.run();expect(f.state.phase).toBe("deleted");
});
it("clones private snapshots and refuses unknown fields or tampered identities",()=>{
 const f=fixture(),saved=structuredClone(f.state);const decoded=validateFlyReplacementCleanupState(f.state);decoded.plan.retired.config.env={PRIVATE:"changed"};expect(f.state).toEqual(saved);
 for(const mutate of [
  (s:FlyReplacementCleanupState)=>{(s as unknown as Record<string,unknown>).extra=true;},
  (s:FlyReplacementCleanupState)=>{s.phase="unknown" as typeof s.phase;},
  (s:FlyReplacementCleanupState)=>{s.plan.schemaVersion=2 as 1;},
  (s:FlyReplacementCleanupState)=>{(s.plan as unknown as Record<string,unknown>).extra=true;},
  (s:FlyReplacementCleanupState)=>{s.plan.survivor=s.plan.retired;},
  (s:FlyReplacementCleanupState)=>{s.plan.replacement.plan.rollback.env={PRIVATE:"tampered"};},
 ]){const corrupt=structuredClone(saved);mutate(corrupt);expect(()=>validateFlyReplacementCleanupState(corrupt)).toThrow("Invalid private Fly cleanup state");}
 for(const malformed of [null,[],{}, {phase:"prepared",plan:null}])expect(()=>validateFlyReplacementCleanupState(malformed as FlyReplacementCleanupState)).toThrow("Invalid private");
});
it.each(["prepared","creating","created","switching","rolling_back"] as const)("rejects cleanup of nonterminal %s before provider work",phase=>{
 const f=fixture(),replacement={...f.replacement,phase,machineId:["prepared","creating"].includes(phase)?null:"new"};expect(()=>planFlyReplacementCleanup({replacement,machines:f.machines})).toThrow("terminal");expect(f.calls).toHaveLength(0);
});
it.each(["missing","duplicate","foreign","old-region","old-digest","old-config","old-version","candidate-name","candidate-region","candidate-digest","candidate-config","retired-running","retired-suspended","survivor-stopped"])("refuses unsafe planning snapshot %s",mode=>{
 const f=fixture(),machines=structuredClone(f.machines);
 if(mode==="missing")machines.pop();if(mode==="duplicate")machines.push(machines[0]!);if(mode==="foreign")machines[0]!.id="foreign";
 if(mode==="old-region")machines[0]!.region="iad";if(mode==="old-digest")machines[0]!.image_ref.digest=`sha256:${"c".repeat(64)}`;
 if(mode==="old-config")machines[0]!.config.env={PRIVATE:"changed"};if(mode==="old-version")machines[0]!.instance_id="foreign";
 if(mode==="candidate-name")(machines[1] as FlyMachine & {name:string}).name="forwarder";if(mode==="candidate-region")machines[1]!.region="iad";
 if(mode==="candidate-digest")machines[1]!.image_ref.digest=`sha256:${"c".repeat(64)}`;if(mode==="candidate-config")machines[1]!.config.env={PRIVATE:"changed"};
 if(mode==="retired-running")machines[0]!.state="started";if(mode==="retired-suspended")machines[0]!.state="suspended";if(mode==="survivor-stopped")machines[1]!.state="stopped";
 expect(()=>planFlyReplacementCleanup({replacement:f.replacement,machines})).toThrow();
});
it("requires the exact immutable restoration image before retiring the candidate",()=>{
 const f=fixture(true);f.machines[0]!.config=structuredClone(f.replacement.plan.before.config);f.machines[0]!.instance_id=f.replacement.plan.before.instance_id;expect(()=>planFlyReplacementCleanup({replacement:f.replacement,machines:f.machines})).toThrow("running survivor");
});
it.each(["delete-loss","delete-pending","delete-before-commit-loss"])("does not duplicate deletion after %s",async mode=>{
 const f=fixture(true);f.mode=mode;await expect(f.run()).rejects.toThrow(mode==="delete-pending"?"pending":"lost delete");expect(f.state.phase).toBe("deleting");expect(f.claimed).toBe(false);
 f.mode="normal";if(mode==="delete-loss")await f.run();else{
  await expect(f.run()).rejects.toBeInstanceOf(FlyReplacementCleanupPending);expect(deletions(f)).toHaveLength(1);
  // The next read observes independently completed deletion, not a second DELETE.
  f.machines=f.machines.filter(machine=>machine.id!=="new");f.volumes[0]!.attached_machine_id=null;await f.run();
 }
 expect(f.state.phase).toBe("deleted");expect(deletions(f)).toHaveLength(1);
});
it("does not dispatch an uncertain deletion after death between journal fsync and DELETE",async()=>{
 const f=fixture();f.state={...f.state,phase:"deleting"};await expect(f.run()).rejects.toBeInstanceOf(FlyReplacementCleanupPending);expect(deletions(f)).toHaveLength(0);
});
it.each([1,2])("retains a failed durable CAS at transition %s without repeating physical deletion",async transition=>{
 const f=fixture();f.casFailAt=transition;await expect(f.run()).rejects.toThrow("before transition");expect(f.state.phase).toBe(transition===1?"prepared":"deleting");expect(deletions(f)).toHaveLength(transition===1?0:1);
 f.casFailAt=0;await f.run();expect(f.state.phase).toBe("deleted");expect(deletions(f)).toHaveLength(1);
});
it.each(["org-changed","not-current","retired-lease-failed"])("rejects %s before deletion with static diagnostics",async mode=>{
 const f=fixture();f.mode=mode;await expect(f.run()).rejects.toThrow(mode==="org-changed"?"organization changed":mode==="not-current"?"ownership changed":"HTTP 409");expect(deletions(f)).toHaveLength(0);expect(f.state.phase).toBe("prepared");expect(f.claimed).toBe(false);
});
it.each(["foreign","duplicate-survivor","duplicate-retired","missing-survivor","retired-running","retired-suspended","survivor-stopped","config","version","region","digest","name","volume-missing","volume-duplicate","volume-foreign","volume-unencrypted","volume-region","volume-state"])("refuses changed provider inventory %s",async mode=>{
 const f=fixture();
 if(mode==="foreign")f.machines.push({...structuredClone(f.machines[0]!),id:"foreign"});
 if(mode==="duplicate-survivor")f.machines.push(structuredClone(f.machines[1]!));if(mode==="duplicate-retired")f.machines.push(structuredClone(f.machines[0]!));if(mode==="missing-survivor")f.machines=f.machines.filter(machine=>machine.id!=="new");
 if(mode==="retired-running")f.machines[0]!.state="started";if(mode==="retired-suspended")f.machines[0]!.state="suspended";if(mode==="survivor-stopped")f.machines[1]!.state="stopped";
 if(mode==="config")f.machines[0]!.config.env={PRIVATE:"changed"};if(mode==="version")f.machines[0]!.instance_id="changed";if(mode==="region")f.machines[0]!.region="iad";
 if(mode==="digest")f.machines[0]!.image_ref.repository="foreign";if(mode==="name")(f.machines[0] as FlyMachine & {name:string}).name="foreign";
 if(mode==="volume-missing")f.volumes=[];if(mode==="volume-duplicate")f.volumes.push(structuredClone(f.volumes[0]!));if(mode==="volume-foreign")f.volumes[0]!.attached_machine_id="foreign";
 if(mode==="volume-unencrypted")f.volumes[0]!.encrypted=false;if(mode==="volume-region")f.volumes[0]!.region="iad";if(mode==="volume-state")f.volumes[0]!.state="destroying";
 await expect(f.run()).rejects.toThrow();expect(deletions(f)).toHaveLength(0);
});
it("refuses disappearance without a durable dispatch marker",async()=>{
 const f=fixture();f.machines=f.machines.filter(machine=>machine.id!=="old");await expect(f.run()).rejects.toThrow("disappeared before dispatch");expect(deletions(f)).toHaveLength(0);
});
it("does not trust a completed journal if the retired machine reappears or ownership changes",async()=>{
 const f=fixture(),old=structuredClone(f.machines[0]!);await f.run();f.machines.push(old);await expect(f.run()).rejects.toThrow("reappeared");f.machines.pop();f.mode="not-current";await expect(f.run()).rejects.toThrow("ownership changed");expect(deletions(f)).toHaveLength(1);
});
it("rechecks both identities under leases and releases the survivor when the retired lease fails",async()=>{
 const f=fixture();f.mode="retired-lease-failed";await expect(f.run()).rejects.toThrow("HTTP 409");expect(f.calls.filter(call=>call.path.endsWith("/lease") && call.method==="DELETE")).toEqual([{method:"DELETE",path:"/v1/apps/app/machines/new/lease",nonce:"lease-new"}]);
});
it.each(["edit","start","disappear"])("rejects retired %s between inventory and provider leases",async mode=>{
 const f=fixture();f.onLease=machine=>{if(machine.id!=="old")return;if(mode==="edit")machine.config.env={PRIVATE:"external"};if(mode==="start")machine.state="started";if(mode==="disappear")f.machines=f.machines.filter(item=>item.id!=="old");};
 await expect(f.run()).rejects.toThrow(mode==="edit"?"changed after planning":mode==="start"?"no longer quiescent":"disappeared before dispatch");expect(deletions(f)).toHaveLength(0);
});
it("holds the exclusive claim across awaited provider authorization and rejects another invocation",async()=>{
 const f=fixture();let entered!:()=>void,resume!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{resume=resolve;});let first=true;
 f.onGuard=async()=>{if(first){first=false;entered();await hold;}};const pending=f.run();await reached;await expect(f.run()).rejects.toThrow("busy");resume();await pending;expect(deletions(f)).toHaveLength(1);
});
it("stops on journal replacement and on expired ownership after the deleting marker",async()=>{
 const f=fixture();f.onGuard=async()=>{if(f.state.phase==="deleting")throw new Error("claim expired");};await expect(f.run()).rejects.toThrow("claim expired");expect(f.state.phase).toBe("deleting");expect(deletions(f)).toHaveLength(0);
 const g=fixture();g.onGuard=async()=>{g.state={...g.state,phase:"deleting"};};await expect(g.run()).rejects.toThrow("journal changed during");expect(deletions(g)).toHaveLength(0);
});
it("retains deletion pending if the surviving configuration changed afterward",async()=>{
 const f=fixture();f.mode="delete-survivor-edit";await expect(f.run()).rejects.toThrow("changed after planning");expect(f.state.phase).toBe("deleting");expect(deletions(f)).toHaveLength(1);
});
it("surfaces release failure after completion but preserves the primary failure",async()=>{
 const f=fixture();f.mode="release-failed";await expect(f.run()).rejects.toThrow("HTTP 500");expect(f.state.phase).toBe("deleted");f.mode="normal";await f.run();expect(deletions(f)).toHaveLength(1);
 const g=fixture();g.onLease=machine=>{if(machine.id==="old")machine.state="started";};g.mode="release-failed";await expect(g.run()).rejects.toThrow("no longer quiescent");expect(deletions(g)).toHaveLength(0);
});
it("rejects a valid but reversed private cleanup plan",()=>{
 const f=fixture(),corrupt=structuredClone(f.state);[corrupt.plan.survivor,corrupt.plan.retired]=[corrupt.plan.retired,corrupt.plan.survivor];expect(()=>validateFlyReplacementCleanupState(corrupt)).toThrow("Invalid private");
});
it("does not mark deletion complete if the retired machine reappears under the survivor lease",async()=>{
 const f=fixture(),old=structuredClone(f.machines[0]!);f.state={...f.state,phase:"deleting"};f.machines=f.machines.filter(machine=>machine.id!=="old");f.onLease=machine=>{if(machine.id==="new")f.machines.push(old);};await expect(f.run()).rejects.toBeInstanceOf(FlyReplacementCleanupPending);expect(deletions(f)).toHaveLength(0);expect(f.state.phase).toBe("deleting");
});
