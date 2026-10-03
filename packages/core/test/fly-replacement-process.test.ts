import {expect,it} from "vitest";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {planFlyReplacement,type FlyReplacementState} from "../src/fly-replacement";
import {planFlyReplacementCleanup,type FlyReplacementCleanupState} from "../src/fly-replacement-cleanup";
import type {FlyMachine,FlyMachineConfig} from "../src/fly";
const image=`registry.test/new@sha256:${"a".repeat(64)}`;
async function fixture(){
 const temporary=mkdtempSync(join(tmpdir(),"logtura-replacement-process-")),journal=join(temporary,"private.json");
 const original={id:"old",name:"forwarder",instance_id:"old_version",state:"started",region:"ord",config:{image:"registry.test/old:tag",env:{PRIVATE:"retained-old"},files:[{guest_path:"/etc/vector/vector.yaml",raw_value:"b2xk",mode:0o400}],guest:{cpus:2,memory_mb:4096},checks:{vector_api:{port:8686}},init:{cmd:["--config","/etc/vector/vector.yaml"]},restart:{policy:"always"}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};
 const machines:FlyMachine[]=[structuredClone(original)],volume={id:"vol_checkpoint",region:"ord",encrypted:true,state:"created",attached_machine_id:null as string|null};
 const plan=planFlyReplacement({id:crypto.randomUUID(),app:"app",org:"personal",machine:original,volume:volume.id,volumes:[volume],config:{...original.config,image,env:{PRIVATE:"new-issued"},mounts:[{path:"/var/lib/logtura",volume:volume.id}]}});
 writeFileSync(journal,JSON.stringify({plan,phase:"prepared",machineId:null}),{mode:0o600,flag:"wx"});
 const counts={create:0,oldStop:0,newStart:0,newStop:0,oldUpdate:0,oldStart:0,delete:0};let failure:unknown,loseCreate=false,loseDelete=false;
 const state=()=>JSON.parse(readFileSync(journal,"utf8")) as FlyReplacementState;
 const server=createServer(async(request,response)=>{
  try{
   expect(request.headers.authorization).toBe("Bearer private-fixture");
   let text="";for await(const chunk of request)text+=chunk;const body=text?JSON.parse(text):null,path=request.url!;
   const match=path.match(/\/machines\/([^/]+)(?:\/(.*))?$/),machine=machines.find(value=>value.id===match?.[1]);
   const reply=(value:unknown)=>{response.setHeader("content-type","application/json");response.end(JSON.stringify(value));};
   if(path.endsWith("/lease")){if(request.method==="DELETE"){response.writeHead(204);response.end();}else reply({data:{nonce:`lease-${machine!.id}`}});return;}
   if(path.endsWith("/volumes")){reply([volume]);return;}
   if(path.endsWith("/machines")){
    if(request.method==="POST"){
     expect(state().phase).toBe("creating");expect(body.skip_launch).toBe(true);expect(machines[0]!.state).toBe("started");counts.create++;
     const candidate={id:"new",name:body.name,region:body.region,instance_id:"new_version",state:"created",config:body.config,image_ref:{registry:"registry.test",repository:"new",digest:`sha256:${"a".repeat(64)}`}};
     machines.push(candidate);volume.attached_machine_id="new";if(loseCreate){loseCreate=false;request.socket.destroy();return;}reply(candidate);
    }else reply(machines);return;
   }
   if(machine){
    if(request.method==="DELETE"){
     expect((JSON.parse(readFileSync(journal,"utf8")) as FlyReplacementCleanupState).phase).toBe("deleting");
     expect(request.headers["fly-machine-lease-nonce"]).toBe(`lease-${machine.id}`);
     expect(machine.state).toMatch(/^(stopped|created)$/);expect(machines.find(item=>item.id!==machine.id)!.state).toBe("started");counts.delete++;
     machines.splice(machines.indexOf(machine),1);if(volume.attached_machine_id===machine.id)volume.attached_machine_id=null;
     if(loseDelete){loseDelete=false;request.socket.destroy();return;}response.writeHead(204);response.end();return;
    }
    if(request.method==="POST"){
     expect(request.headers["fly-machine-lease-nonce"]).toBe(`lease-${machine.id}`);
     if(path.endsWith("/stop")){expect(body).toEqual({signal:"SIGTERM",timeout:"35s"});counts[machine.id==="old"?"oldStop":"newStop"]++;machine.state="stopped";}
     else if(path.endsWith("/start")){expect(machines.find(item=>item.id!==machine.id)!.state).toMatch(/^(stopped|created)$/);counts[machine.id==="old"?"oldStart":"newStart"]++;machine.state="started";}
     else{expect(body.current_version).toBe(machine.instance_id);expect(machine.id).toBe("old");expect(machines[1]!.state).toBe("stopped");counts.oldUpdate++;machine.config=body.config as FlyMachineConfig;machine.instance_id="rollback_version";machine.state="started";}
    }reply(machine);return;
   }
   expect(path).toBe("/v1/apps/app");reply({name:"app",organization:{slug:"personal"}});
  }catch(error){failure=error;response.writeHead(500);response.end("fixture rejected request");}
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 async function run(killPhase="none",rollback=false,cleanup=false){
  const child=spawn(process.execPath,[fileURLToPath(new URL("./fixtures/fly-replacement-child.mjs",import.meta.url)),journal,origin,killPhase,cleanup?"cleanup":rollback?"rollback":"replace"],{stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
  const timer=setTimeout(()=>child.kill("SIGKILL"),15000);
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on("error",reject);child.on("close",(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
  // This fixture has exactly one executor. Reap only its owned abandoned lock
  // after the OS confirms exit; never infer that a live process has stopped.
  rmSync(journal+".lock",{recursive:true,force:true});if(failure)throw failure;
  expect(statSync(journal).mode&0o777).toBe(0o600);return {...result,stdout,stderr};
 }
 return {plan,state,run,machines,counts,volume,cleanupState:()=>JSON.parse(readFileSync(journal,"utf8")) as FlyReplacementCleanupState,
  prepareCleanup(){const replacement=state();writeFileSync(journal,JSON.stringify({plan:planFlyReplacementCleanup({replacement,machines}),phase:"prepared"}));},
  set loseCreate(value:boolean){loseCreate=value;},set loseDelete(value:boolean){loseDelete=value;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(temporary,{recursive:true,force:true});expect(existsSync(temporary)).toBe(false);}};
}
it.each(["creating","created","switching","installed"])("recovers a real HTTP replacement process killed after durable %s",async phase=>{
 const f=await fixture();try{
  expect(await f.run(phase)).toMatchObject({code:null,signal:"SIGKILL"});expect(f.state().phase).toBe(phase);
  const resumed=await f.run();
  if(phase==="creating"){expect(resumed.code).toBe(1);expect(resumed.stderr).toContain("outcome is unknown");expect(f.counts.create).toBe(0);expect(f.machines[0]!.state).toBe("started");}
  else{expect(resumed,{stderr:resumed.stderr}).toMatchObject({code:0,signal:null});expect(f.state().phase).toBe("installed");expect(f.counts).toMatchObject({create:1,oldStop:1,newStart:1});expect(f.machines.map(machine=>machine.state)).toEqual(["stopped","started"]);}
 }finally{await f.close();}
},20000);
it.each(["rolling_back","rolled_back"])("recovers a real HTTP rollback process killed after durable %s",async phase=>{
 const f=await fixture();try{
  expect((await f.run()).code).toBe(0);expect(await f.run(phase,true)).toMatchObject({code:null,signal:"SIGKILL"});expect(f.state().phase).toBe(phase);
  const resumed=await f.run("none",true);expect(resumed,{stderr:resumed.stderr}).toMatchObject({code:0,signal:null});expect(f.state().phase).toBe("rolled_back");expect(f.counts).toMatchObject({create:1,oldStop:1,newStart:1,newStop:1,oldUpdate:1,oldStart:0});expect(f.machines.map(machine=>machine.state)).toEqual(["started","stopped"]);expect(f.machines[0]!.config).toEqual(f.plan.rollback);
 }finally{await f.close();}
},20000);
it("reconciles a lost real HTTP create response without dispatching another candidate",async()=>{
 const f=await fixture();try{f.loseCreate=true;expect((await f.run()).code).toBe(1);expect(f.state().phase).toBe("creating");const resumed=await f.run();expect(resumed,{stderr:resumed.stderr}).toMatchObject({code:0,signal:null});expect(f.counts.create).toBe(1);expect(f.state().phase).toBe("installed");}finally{await f.close();}
},20000);
it.each([false,true])("permanently retires only the quiescent owned machine through compiled public HTTP cleanup after rollback=%s",async rollback=>{
 const f=await fixture();try{
  expect((await f.run()).code).toBe(0);if(rollback)expect((await f.run("none",true)).code).toBe(0);f.prepareCleanup();
  const completed=await f.run("none",false,true);expect(completed,{stderr:completed.stderr}).toMatchObject({code:0,signal:null});
  expect(f.cleanupState().phase).toBe("deleted");expect(f.counts.delete).toBe(1);expect(f.machines.map(machine=>[machine.id,machine.state])).toEqual([[rollback?"old":"new","started"]]);expect(f.volume.attached_machine_id).toBe(rollback?null:"new");
  expect((await f.run("none",false,true)).code).toBe(0);expect(f.counts.delete).toBe(1);
 }finally{await f.close();}
},20000);
it.each(["deleting","deleted"])("preserves cleanup after an actual process is killed after durable %s",async phase=>{
 const f=await fixture();try{
  expect((await f.run()).code).toBe(0);f.prepareCleanup();expect(await f.run(phase,false,true)).toMatchObject({code:null,signal:"SIGKILL"});expect(f.cleanupState().phase).toBe(phase);
  const resumed=await f.run("none",false,true);
  if(phase==="deleting"){expect(resumed.code).toBe(1);expect(resumed.stderr).toContain("pending or unknown");expect(f.counts.delete).toBe(0);expect(f.machines).toHaveLength(2);}
  else{expect(resumed,{stderr:resumed.stderr}).toMatchObject({code:0,signal:null});expect(f.counts.delete).toBe(1);expect(f.machines).toHaveLength(1);}
 }finally{await f.close();}
},20000);
it("observes lost real HTTP deletion without a second destructive request",async()=>{
 const f=await fixture();try{
  expect((await f.run()).code).toBe(0);expect((await f.run("none",true)).code).toBe(0);f.prepareCleanup();f.loseDelete=true;
  expect((await f.run("none",false,true)).code).toBe(1);expect(f.cleanupState().phase).toBe("deleting");expect(f.counts.delete).toBe(1);
  const resumed=await f.run("none",false,true);expect(resumed,{stderr:resumed.stderr}).toMatchObject({code:0,signal:null});expect(f.cleanupState().phase).toBe("deleted");expect(f.counts.delete).toBe(1);expect(f.volume.attached_machine_id).toBeNull();
 }finally{await f.close();}
},20000);
