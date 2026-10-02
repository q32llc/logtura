import {expect,it,vi} from "vitest";
import {FlyMachinesClient,type FlyMachine,type FlyVolume} from "../src/fly";
import {planFlyReplacement,validateFlyReplacementState,executeFlyReplacement,type FlyReplacementState,type FlyReplacementStore} from "../src/fly-replacement";
const id="00000000-0000-4000-8000-000000000001",image=`registry.test/new@sha256:${"a".repeat(64)}`;
function fixture(){
 const before={id:"old",name:"forwarder",instance_id:"old_version",state:"started",region:"ord",config:{image:"registry.test/old:latest",env:{PRIVATE:"preserve-exact"},files:[{guest_path:"/etc/vector/vector.yaml",raw_value:"b2xk",mode:0o400}],guest:{memory_mb:512},checks:{old:{port:8686}},init:{cmd:["--config","/etc/vector/vector.yaml"]},restart:{policy:"always"}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};
 let machines:FlyMachine[]=[structuredClone(before)],volumes:FlyVolume[]=[{id:"vol_new",region:"ord",encrypted:true,state:"created",attached_machine_id:null}],mode="normal",claimed=false,casFail=false,journalRace=false,guards=0;
 const plan=planFlyReplacement({id,app:"app",org:"personal",machine:before,volume:"vol_new",volumes,config:{...before.config,image,mounts:[{path:"/var/lib/logtura",volume:"vol_new"}],env:{PRIVATE:"new"}}});
 let state:FlyReplacementState={plan,phase:"prepared",machineId:null};
 const calls:Array<{path:string;method:string;body:Record<string,unknown>|null;nonce?:string}>=[];
 const fetcher:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname,method=init!.method!,body=init!.body?JSON.parse(init!.body as string):null;
  calls.push({path,method,body,nonce:(init!.headers as Record<string,string>)["fly-machine-lease-nonce"]});
  const match=path.match(/\/machines\/([^/]+)(?:\/(.*))?$/),machine=machines.find(item=>item.id===match?.[1]);
  if(path.endsWith("/lease")){
   if(method==="DELETE"){if(["release-error","primary-and-release-error"].includes(mode))return new Response("private",{status:500});return new Response(null,{status:204});}
   if(mode==="candidate-lease-error" && machine?.id==="new")return new Response("private",{status:409});
   if(["leased-edit","primary-and-release-error"].includes(mode) && machine?.id==="new")machine.config.env={PRIVATE:"external"};
   if(mode==="checkpoint-leased-edit" && machine?.id==="new")volumes[0]!.attached_machine_id="foreign";
   return Response.json({data:{nonce:`lease-${match![1]}`}});
  }
  if(path.endsWith("/volumes"))return Response.json(volumes);
  if(path.endsWith("/machines")){
   if(method==="POST"){
    expect(body.skip_launch).toBe(true);expect(machines[0]!.state).toBe("started");
    if(mode==="create-before-commit-loss")throw new Error("lost create");
    const created={id:"new",name:body.name,instance_id:"new_version",region:body.region,state:mode==="unexpected-launch"?"started":"created",config:body.config,image_ref:{registry:"registry.test",repository:"new",digest:`sha256:${"a".repeat(64)}`}};
    machines.push(created);volumes[0]!.attached_machine_id="new";
    if(mode==="create-loss")throw new Error("lost create");
    return Response.json(created);
   }return Response.json(machines);
  }
  if(path.endsWith("/stop")){
   expect(body).toEqual({signal:"SIGTERM",timeout:"35s"});expect((init!.headers as Record<string,string>)["fly-machine-lease-nonce"]).toBe(`lease-${machine!.id}`);
   if(mode!=="stop-pending")machine!.state="stopped";
   if(mode==="stop-loss")throw new Error("lost stop");
   return new Response(null,{status:204});
  }
  if(path.endsWith("/start")){
   expect(machines.find(item=>item.id===(machine!.id==="new"?"old":"new"))!.state).toMatch(/^(stopped|created)$/);
   if(mode!=="start-pending")machine!.state="started";
   if(mode==="start-loss")throw new Error("lost start");
   return new Response(null,{status:204});
  }
  if(machine){
   if(method==="POST"){
    expect(body.current_version).toBe(machine.instance_id);machine.config=body.config;machine.instance_id="rollback_version";
    if(mode==="rollback-no-install"){machine.config=before.config;machine.instance_id=before.instance_id;}
    if(mode==="rollback-update-loss")throw new Error("lost rollback update");
   }
   return Response.json(machine);
  }
  return Response.json({name:"app",organization:{slug:mode==="org-changed"?"other":"personal"}});
 };
 const store:FlyReplacementStore={async runExclusive(operation){if(claimed)throw new Error("busy");claimed=true;try{return await operation({read:async()=>structuredClone(state),compareAndSwap:async(expected,next)=>{expect(state).toEqual(expected);if(casFail)return false;state=structuredClone(next);return true;}});}finally{claimed=false;}}};
 const guard=vi.fn(async()=>{guards++;if(journalRace)state={...state,phase:"rolling_back"};if(mode==="not-current")throw new Error("issued instance changed");});
 const client=new FlyMachinesClient({token:"private",fetch:fetcher});
 return {before,plan,client,store,guard,calls,fetcher,run:(rollback=false)=>executeFlyReplacement(store,client,{rollback,assertCurrent:guard}),get state(){return state;},set state(value:FlyReplacementState){state=value;},get machines(){return machines;},set machines(value:FlyMachine[]){machines=value;},get volumes(){return volumes;},set mode(value:string){mode=value;},set casFail(value:boolean){casFail=value;},set journalRace(value:boolean){journalRace=value;},get guards(){return guards;}};
}
it("creates stopped, journals before POST, stops old before starting new, and preserves immutable rollback",async()=>{
 const f=fixture(),original=structuredClone(f.before),result=await f.run();
 expect(result).toMatchObject({phase:"installed",machineId:"new"});expect(f.before).toEqual(original);expect(result.plan.rollback).toEqual({...original.config,image:`registry.test/old@${original.image_ref.digest}`});
 expect(f.machines.map(machine=>[machine.id,machine.state])).toEqual([["old","stopped"],["new","started"]]);
 const writes=f.calls.filter(call=>call.method!=="GET" && !call.path.endsWith("/lease"));expect(writes.map(call=>call.path)).toEqual(["/v1/apps/app/machines","/v1/apps/app/machines/old/stop","/v1/apps/app/machines/new/start"]);
 expect(f.guards).toBeGreaterThan(6);await f.run();expect(f.calls.filter(call=>call.path.endsWith("/machines") && call.method==="POST")).toHaveLength(1);expect(f.calls.filter(call=>call.path.endsWith("/start"))).toHaveLength(1);
});
it.each(["create-loss","stop-loss","start-loss"])("recovers %s by observation without duplicate provider mutation",async mode=>{
 const f=fixture();f.mode=mode;await expect(f.run()).rejects.toThrow("lost");f.mode="normal";await f.run();
 expect(f.state.phase).toBe("installed");for(const suffix of ["/machines","/old/stop","/new/start"])expect(f.calls.filter(call=>call.path.endsWith(suffix) && call.method==="POST")).toHaveLength(1);
});
it("never repeats an uncertain create with no matching candidate, even for rollback",async()=>{
 const f=fixture();f.mode="create-before-commit-loss";await expect(f.run()).rejects.toThrow("lost");expect(f.state.phase).toBe("creating");f.mode="normal";
 await expect(f.run()).rejects.toThrow("outcome is unknown");await expect(f.run(true)).rejects.toThrow("outcome is unknown");expect(f.calls.filter(call=>call.path.endsWith("/machines") && call.method==="POST")).toHaveLength(1);expect(f.machines[0]!.state).toBe("started");
});
it.each(["stop-pending","start-pending"])("retains %s as a bounded recoverable handoff",async mode=>{
 const f=fixture();f.mode=mode;await expect(f.run()).rejects.toThrow("pending");expect(f.state.phase).toBe("switching");f.mode="normal";await f.run();expect(f.state.phase).toBe("installed");
});
it("rolls back exact old settings and image after stopping the new process, retaining both recovery machines",async()=>{
 const f=fixture();await f.run();const rollback=await f.run(true);
 expect(rollback.phase).toBe("rolled_back");expect(f.machines[0]!.config).toEqual(f.plan.rollback);expect(f.machines[0]!.state).toBe("started");expect(f.machines[1]!.state).toBe("stopped");
 await f.run(true);expect(f.calls.filter(call=>call.path.endsWith("/old") && call.method==="POST")).toHaveLength(1);
 await expect(f.run()).rejects.toThrow("rolled back");
});
it.each(["rollback-update-loss","stop-loss","start-loss"])("recovers rollback after %s without duplicate committed writes",async mode=>{
 const f=fixture();await f.run();f.mode=mode;await expect(f.run(true)).rejects.toThrow("lost");expect(f.state.phase).toBe("rolling_back");f.mode="normal";await f.run(true);expect(f.state.phase).toBe("rolled_back");
 expect(f.calls.filter(call=>call.path.endsWith("/old") && call.method==="POST")).toHaveLength(1);expect(f.calls.filter(call=>call.path.endsWith("/new/stop"))).toHaveLength(1);expect(f.calls.filter(call=>call.path.endsWith("/old/start"))).toHaveLength(1);
});
it("can roll back an observed candidate whose create response was lost before any handoff",async()=>{
 const f=fixture();f.mode="create-loss";await expect(f.run()).rejects.toThrow("lost");f.mode="normal";await f.run(true);expect(f.state.phase).toBe("rolled_back");expect(f.calls.some(call=>call.path.endsWith("/old/stop"))).toBe(false);expect(f.calls.some(call=>call.path.endsWith("/new/start"))).toBe(false);
});
it("rejects competing journal/issuance transitions before machine writes",async()=>{
 for(const setting of ["cas","journal","not-current"]){const f=fixture();if(setting==="cas")f.casFail=true;if(setting==="journal")f.journalRace=true;if(setting==="not-current")f.mode="not-current";await expect(f.run()).rejects.toThrow(/journal changed|instance changed/);expect(f.calls.some(call=>call.path.endsWith("/machines") && call.method==="POST")).toBe(false);}
});
it.each(["org-changed","leased-edit","candidate-lease-error","unexpected-launch"])("rejects %s without unsafe process overlap",async mode=>{
 const f=fixture();f.mode=mode;await expect(f.run()).rejects.toThrow();expect(f.machines[0]!.state).toBe("started");expect(f.calls.some(call=>call.path.endsWith("/new/start"))).toBe(false);
 if(mode==="candidate-lease-error")expect(f.calls.filter(call=>call.path.endsWith("/old/lease") && call.method==="DELETE")).toHaveLength(1);
});
it("preserves primary errors while always attempting both lease releases",async()=>{
 const f=fixture();await f.run();f.mode="release-error";await expect(f.run()).rejects.toThrow("HTTP 500");
 const before=f.calls.length;f.mode="primary-and-release-error";
 await expect(f.run()).rejects.toThrow("differs from the saved replacement");
 expect(f.calls.slice(before).filter(call=>call.path.endsWith("/lease") && call.method==="DELETE")).toHaveLength(2);
});
it("checks every original setting/version/digest and candidate identity on recovery",async()=>{
 for(const change of [(f:ReturnType<typeof fixture>)=>{f.machines[0]!.instance_id="external";},(f:ReturnType<typeof fixture>)=>{f.machines[0]!.config.extra=true;},(f:ReturnType<typeof fixture>)=>{f.machines[0]!.image_ref.digest=`sha256:${"c".repeat(64)}`;},(f:ReturnType<typeof fixture>)=>{f.machines.push({...f.machines[0]!,id:"foreign"});},(f:ReturnType<typeof fixture>)=>{f.machines=[];}]){const f=fixture();change(f);await expect(f.run()).rejects.toThrow();expect(f.calls.some(call=>call.method==="POST")).toBe(false);}
 for(const change of [(m:FlyMachine)=>{m.region="iad";},(m:FlyMachine)=>{m.image_ref.digest=`sha256:${"c".repeat(64)}`;},(m:FlyMachine)=>{(m as FlyMachine & {name:string}).name="other";},(m:FlyMachine)=>{m.config.env={PRIVATE:"external"};}]){const f=fixture();await f.run();change(f.machines[1]!);await expect(f.run()).rejects.toThrow();}
 const missing=fixture();await missing.run();missing.machines=[missing.machines[0]!];await expect(missing.run()).rejects.toThrow("disappeared");
 const duplicate=fixture();duplicate.mode="create-loss";await expect(duplicate.run()).rejects.toThrow();duplicate.machines.push({...duplicate.machines[1]!,id:"duplicate"});await expect(duplicate.run()).rejects.toThrow("ambiguous");
});
it("requires an encrypted unattached checkpoint and refuses to clone attached storage or public routing",()=>{
 const f=fixture(),input={id,app:"app",org:"personal",machine:f.before,config:f.plan.after,volume:"vol_new",volumes:f.volumes};
 for(const change of [{id:"bad"},{app:"bad/app"},{org:"BAD"},{machine:{...f.before,config:{...f.before.config,mounts:[{path:"/data",volume:"vol_data"}]}}},{machine:{...f.before,config:{...f.before.config,services:[{autostart:true}]}}},{machine:{...f.before,state:"destroying"}},{config:{...f.plan.after,mounts:[]}},{config:{...f.plan.after,metadata:[]}},{config:{...f.plan.after,services:[{}]}},{volumes:[{...f.volumes[0]!,attached_machine_id:"old"}]},{volumes:[{...f.volumes[0]!,encrypted:false}]}])expect(()=>planFlyReplacement({...input,...change})).toThrow();
 for(const config of [{containers:[{}]},{processes:[{}]},{volumes:[{}]},{standbys:["other"]},{schedule:"daily"},{auto_destroy:true}]){expect(()=>planFlyReplacement({...input,machine:{...f.before,config:{...f.before.config,...config}}})).toThrow();expect(()=>planFlyReplacement({...input,config:{...f.plan.after,...config}})).toThrow();}
});
it("validates private recovery envelopes and immutable rollback inputs",()=>{
 const f=fixture();expect(validateFlyReplacementState(f.state)).toEqual(f.state);
 for(const value of [null,[],{...f.state,phase:"bad"},{...f.state,machineId:"bad/id"},{...f.state,machineId:"old"},{...f.state,extra:true},{...f.state,phase:"installed"},{...f.state,plan:{...f.plan,schemaVersion:2}},{...f.state,plan:{...f.plan,name:"other"}},{...f.state,plan:{...f.plan,rollback:{image}}}])expect(()=>validateFlyReplacementState(value as FlyReplacementState)).toThrow("private Fly replacement state");
});
it("rejects foreign or changed checkpoint attachment before provider writes",async()=>{
 for(const mutation of [(v:FlyVolume[])=>{v[0]!.attached_machine_id="other";},(v:FlyVolume[])=>{v[0]!.encrypted=false;},(v:FlyVolume[])=>{v.push({...v[0]!});},(v:FlyVolume[])=>{v.splice(0);}]){const f=fixture();mutation(f.volumes);await expect(f.run()).rejects.toThrow();expect(f.calls.some(call=>call.method==="POST")).toBe(false);}
});
it("requires explicit rollback resume and never claims readiness from provider state",async()=>{
 const f=fixture();await f.run();f.mode="stop-pending";await expect(f.run(true)).rejects.toThrow("pending");await expect(f.run()).rejects.toThrow("rollback is pending");f.mode="normal";await f.run(true);
});
it("rechecks checkpoint attachment under both leases before stopping the old process",async()=>{
 const f=fixture();f.mode="checkpoint-leased-edit";await expect(f.run()).rejects.toThrow("checkpoint attachment");expect(f.machines[0]!.state).toBe("started");expect(f.calls.filter(call=>call.path.endsWith("/lease") && call.method==="DELETE")).toHaveLength(2);
});
it("restores the old forwarder even if the candidate checkpoint has become unavailable",async()=>{
 const f=fixture();await f.run();f.volumes.splice(0);await f.run(true);expect(f.state.phase).toBe("rolled_back");expect(f.machines[0]!.state).toBe("started");expect(f.machines[1]!.state).toBe("stopped");
});
it.each(["stop-pending","start-pending","rollback-no-install"])("retains rollback recovery state for %s",async mode=>{
 const f=fixture();await f.run();f.mode=mode;await expect(f.run(true)).rejects.toThrow(/pending|restored/);expect(f.state.phase).toBe("rolling_back");f.mode="normal";await f.run(true);expect(f.state.phase).toBe("rolled_back");
});
it("rejects a candidate without durable dispatch and duplicate old machine observations",async()=>{
 const f=fixture();await f.run();f.state={...f.state,phase:"prepared",machineId:null};await expect(f.run()).rejects.toThrow("without a dispatched replacement");
 const duplicate=fixture();duplicate.machines.push(structuredClone(duplicate.machines[0]!));await expect(duplicate.run()).rejects.toThrow("saved old and candidate");
});
