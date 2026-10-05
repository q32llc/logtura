import {afterEach,expect,it,vi} from "vitest";
import * as fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {buildSync} from "esbuild";
import {FlyMachinesClient,planFlyReplacement,executeFlyReplacement,type FlyMachine,type FlyReplacementState} from "@logtura/core";
import {PrivateFlyReplacementStore,readPrivateFlyReplacement} from "../src/fly-replacement-store";
import {pendingFlyReplacementPath,assertNoPendingPush,transactionPath,commitFileTransaction} from "../src/file-transaction";
import {deploymentStatus} from "../src/deployment-link";
vi.mock("node:fs",{spy:true});
const native=await vi.importActual<typeof fs>("node:fs"),roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const root of roots.splice(0))native.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=fs.mkdtempSync(join(tmpdir(),"logtura-replacement-"));roots.push(root);const config=join(root,"logt.yaml");fs.writeFileSync(config,"private-config");
 const before:FlyMachine={id:"abc123",instance_id:"old",state:"started",region:"iad",config:{image:"registry.test/old:latest",env:{PRIVATE:"old-secret"},guest:{memory_mb:512}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};
 const plan=planFlyReplacement({id:randomUUID(),app:"app",org:"personal",machine:before,volume:"vol_new",volumes:[{id:"vol_new",region:"iad",state:"created",encrypted:true,attached_machine_id:null}],config:{...before.config,image:`registry.test/new@sha256:${"a".repeat(64)}`,mounts:[{path:"/var/lib/logtura",volume:"vol_new"}],env:{PRIVATE:"new-secret"}}});
 const prepared:FlyReplacementState={plan,phase:"prepared",machineId:null},store=new PrivateFlyReplacementStore(config),path=pendingFlyReplacementPath(config);
 let machines:FlyMachine[]=[structuredClone(before)],lost=false,creates=0,stopPending=false;
 const client=new FlyMachinesClient({token:"private-fly-token",fetch:async(input,init)=>{
  const url=new URL(String(input)),method=init!.method,path=url.pathname,body=init!.body?JSON.parse(init!.body as string):null;
  const machine=machines.find(m=>path.includes(`/machines/${m.id}`));
  if(path.endsWith("/lease"))return method==="DELETE"?new Response(null,{status:204}):Response.json({data:{nonce:"private-lease"}});
  if(path.endsWith("/volumes"))return Response.json([{id:"vol_new",region:"iad",state:"created",encrypted:true,attached_machine_id:machines[1]?.id??null}]);
  if(path.endsWith("/machines")){
   if(method==="GET")return Response.json(machines);
   expect(readPrivateFlyReplacement(config)?.phase).toBe("creating");expect(machines[0]!.state).toBe("started");expect(body.skip_launch).toBe(true);creates++;
   const candidate={id:"def456",name:body.name,instance_id:"new",region:"iad",state:"created",config:body.config,image_ref:{registry:"registry.test",repository:"new",digest:`sha256:${"a".repeat(64)}`}};machines.push(candidate);
   if(lost)throw new Error("create response lost");return Response.json(candidate);
  }
  if(path.endsWith("/stop")){expect(readPrivateFlyReplacement(config)?.phase).toMatch(/^(switching|rolling_back)$/);if(!stopPending)machine!.state="stopped";return new Response(null,{status:204});}
  if(path.endsWith("/start")){expect(machines.find(m=>m.id!==machine!.id)!.state).toMatch(/^(stopped|created)$/);machine!.state="started";return new Response(null,{status:204});}
  if(machine){if(method==="POST"){machine.config=body.config;machine.instance_id="restored";}return Response.json(machine);}
  return Response.json({name:"app",organization:{slug:"personal"}});
 }});
 return {root,config,path,prepared,store,client,get machines(){return machines;},get creates(){return creates;},set lost(v:boolean){lost=v;},set stopPending(v:boolean){stopPending=v;},run:(rollback=false)=>executeFlyReplacement(store,client,{rollback,assertCurrent:async()=>{}})};
}
it("uses a durable private journal for real shared backend handoff, resume, rollback and archival",async()=>{
 const f=fixture();expect(readPrivateFlyReplacement(f.config)).toBeNull();await f.store.prepare(f.prepared);expect(fs.statSync(f.path).mode&0o777).toBe(0o600);expect(()=>assertNoPendingPush(f.config)).toThrow("Pending Fly replacement");
 expect(await deploymentStatus(f.config)).toMatchObject({linked:false,pendingReplacement:{phase:"prepared",previousMachineId:"abc123",machineId:null}});expect(JSON.stringify(await deploymentStatus(f.config))).not.toMatch(/old-secret|new-secret|private-fly/);
 const installed=await f.run();expect(installed.phase).toBe("installed");expect(f.machines.map(m=>[m.id,m.state])).toEqual([["abc123","stopped"],["def456","started"]]);await f.run();expect(f.creates).toBe(1);
 const rolledBack=await f.run(true);expect(rolledBack.phase).toBe("rolled_back");expect(f.machines[0]!.config).toEqual(f.prepared.plan.rollback);expect(f.machines[0]!.state).toBe("started");expect(f.machines[1]!.state).toBe("stopped");
 const guard=vi.fn(async()=>{}),archive=await f.store.archive(rolledBack,guard);expect(guard).toHaveBeenCalledTimes(2);expect(readPrivateFlyReplacement(f.config)).toBeNull();expect(fs.statSync(archive).mode&0o777).toBe(0o600);expect(JSON.parse(fs.readFileSync(archive,"utf8")).state).toEqual(rolledBack);assertNoPendingPush(f.config);
});
it("recovers a lost create response through a fresh store object without repeating creation",async()=>{
 const f=fixture();await f.store.prepare(f.prepared);f.lost=true;await expect(f.run()).rejects.toThrow("response lost");expect(readPrivateFlyReplacement(f.config)?.phase).toBe("creating");
 f.lost=false;const fresh=new PrivateFlyReplacementStore(f.config);expect((await executeFlyReplacement(fresh,f.client,{assertCurrent:async()=>{}})).phase).toBe("installed");expect(f.creates).toBe(1);
});
it("resumes an interrupted rollback with the durable rolling-back phase",async()=>{
 const f=fixture();await f.store.prepare(f.prepared);await f.run();f.stopPending=true;await expect(f.run(true)).rejects.toThrow("pending");expect(readPrivateFlyReplacement(f.config)?.phase).toBe("rolling_back");
 f.stopPending=false;expect((await f.run(true)).phase).toBe("rolled_back");
});
it("fences competing writers, altered immutable plans, invalid phase jumps and missing state",async()=>{
 const f=fixture();await f.store.prepare(f.prepared);await expect(f.store.prepare(f.prepared)).rejects.toThrow("Pending");
 await f.store.runExclusive(async tx=>{
  await expect(f.store.runExclusive(async()=>{})).rejects.toThrow("still running");
  const current=await tx.read();expect(await tx.compareAndSwap({...current,plan:{...current.plan,app:"other"}},{...current,phase:"creating"})).toBe(false);
  expect(await tx.compareAndSwap(current,{...current,phase:"installed",machineId:"def456"})).toBe(false);
  expect(await tx.compareAndSwap(current,{...current,plan:{...current.plan,app:"other"},phase:"creating"})).toBe(false);
  expect(await tx.compareAndSwap(current,{...current,phase:"creating"})).toBe(true);
  expect(await tx.compareAndSwap({...current,phase:"creating"},{...current,phase:"created",machineId:"def456"})).toBe(true);
  const created=await tx.read();expect(await tx.compareAndSwap(created,{...created,phase:"switching",machineId:"aaaaaa"})).toBe(false);
 });
 const missing=fixture();await expect(missing.store.runExclusive(tx=>tx.read())).rejects.toThrow("missing");expect(await missing.store.runExclusive(tx=>tx.compareAndSwap(missing.prepared,{...missing.prepared,phase:"creating"}))).toBe(false);
 await expect(missing.store.prepare({...missing.prepared,phase:"installed",machineId:"def456"})).rejects.toThrow("before any provider dispatch");
});
it("preserves pending state after failed archive acknowledgements and rejects conflicting archives",async()=>{
 const f=fixture();await f.store.prepare(f.prepared);await expect(f.store.archive(f.prepared,async()=>{})).rejects.toThrow("not ready");const installed=await f.run();
 const guard=vi.fn(async()=>{if(guard.mock.calls.length===2)throw new Error("new website edit");});await expect(f.store.archive(installed,guard)).rejects.toThrow("website edit");expect(readPrivateFlyReplacement(f.config)).toEqual(installed);
 const archive=join(f.root,`.logtura-replaced-${installed.plan.id}.json`);expect(fs.existsSync(archive)).toBe(true);await f.store.archive(installed,async()=>{});expect(readPrivateFlyReplacement(f.config)).toBeNull();
 const g=fixture();await g.store.prepare(g.prepared);const ready=await g.run(),conflict=join(g.root,`.logtura-replaced-${ready.plan.id}.json`);fs.writeFileSync(conflict,"different",{mode:0o600});await expect(g.store.archive(ready,async()=>{})).rejects.toThrow("conflicts");expect(readPrivateFlyReplacement(g.config)).toEqual(ready);
});
it("fails closed on nonprivate, corrupt, wrong-config, oversized and symlinked recovery files",async()=>{
 const f=fixture();await f.store.prepare(f.prepared);const original=fs.readFileSync(f.path,"utf8"),envelope=JSON.parse(original);
 for(const content of ["{",JSON.stringify({...envelope,extra:true}),JSON.stringify({...envelope,config:join(f.root,"other.yaml")}),JSON.stringify({...envelope,state:{}})," ".repeat(16_777_217)]){fs.writeFileSync(f.path,content,{mode:0o600});expect(()=>readPrivateFlyReplacement(f.config)).toThrow("Invalid private");}
 fs.writeFileSync(f.path,original);fs.chmodSync(f.path,0o644);expect(()=>readPrivateFlyReplacement(f.config)).toThrow("Invalid private");fs.chmodSync(f.path,0o600);fs.rmSync(f.path);fs.symlinkSync(f.config,f.path);expect(()=>readPrivateFlyReplacement(f.config)).toThrow("regular file");fs.rmSync(f.path);fs.mkdirSync(f.path);expect(()=>readPrivateFlyReplacement(f.config)).toThrow("regular file");
});
it("retains a committed phase when directory fsync fails and never mutates Fly before intent is flushed",async()=>{
 const f=fixture();await f.store.prepare(f.prepared);const original=native.fsyncSync;
 vi.mocked(fs.fsyncSync).mockImplementation(()=>{throw new Error("disk flush failed");});await expect(f.run()).rejects.toThrow("disk flush failed");expect(f.creates).toBe(0);expect(readPrivateFlyReplacement(f.config)?.phase).toBe("prepared");
 vi.mocked(fs.fsyncSync).mockImplementation(original);let count=0;vi.mocked(fs.fsyncSync).mockImplementation(fd=>{if(++count===2)throw new Error("directory flush failed");original(fd);});await expect(f.run()).rejects.toThrow("directory flush failed");expect(f.creates).toBe(0);expect(readPrivateFlyReplacement(f.config)?.phase).toBe("creating");
 vi.mocked(fs.fsyncSync).mockImplementation(original);await expect(f.run()).rejects.toThrow("outcome is unknown");expect(f.creates).toBe(0);
});
it("reserves replacement state and its lock as configuration destinations and respects file recovery",async()=>{
 const f=fixture();for(const config of [f.path,join(f.root,".logtura-replacement.lock")])expect(()=>commitFileTransaction(config,[])).toThrow("reserved");
 fs.writeFileSync(transactionPath(f.config),"pending");expect(()=>readPrivateFlyReplacement(f.config)).toThrow("transaction pending");await expect(f.store.prepare(f.prepared)).rejects.toThrow("transaction pending");expect(fs.existsSync(f.path)).toBe(false);
});
it("recovers a journal renamed by a killed process without dispatching an uncertain create",async()=>{
 const f=fixture();await f.store.prepare(f.prepared);
 const compiled=join(f.root,"replacement-store.mjs");
 buildSync({entryPoints:[fileURLToPath(new URL("../src/fly-replacement-store.ts",import.meta.url))],outfile:compiled,bundle:true,platform:"node",format:"esm",target:"node22",banner:{js:"import {createRequire as replacementRequire} from 'node:module';const require=replacementRequire(import.meta.url);"}});
 const module=pathToFileURL(compiled).href;
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(to===${JSON.stringify(f.path)})process.kill(process.pid,'SIGKILL')};syncBuiltinESMExports();const {PrivateFlyReplacementStore}=await import(${JSON.stringify(module)});const store=new PrivateFlyReplacementStore(${JSON.stringify(f.config)});await store.runExclusive(async tx=>{const before=await tx.read();await tx.compareAndSwap(before,{...before,phase:'creating'});});`;
 const child=spawnSync(process.execPath,["--input-type=module","-e",script],{encoding:"utf8"});expect(child.error).toBeUndefined();expect(child.signal,child.stderr).toBe("SIGKILL");
 expect(readPrivateFlyReplacement(f.config)?.phase).toBe("creating");await expect(f.run()).rejects.toThrow("outcome is unknown");expect(f.creates).toBe(0);expect(f.machines[0]!.state).toBe("started");
});
it("rejects an oversized write before publishing intent and leaves the directory unlocked",async()=>{
 const f=fixture(),large={...f.prepared,plan:{...f.prepared.plan,after:{...f.prepared.plan.after,env:{PRIVATE:"x".repeat(16_777_216)}}}};
 await expect(f.store.prepare(large)).rejects.toThrow("reader limit");expect(fs.existsSync(f.path)).toBe(false);expect(fs.readdirSync(f.root)).toEqual(["logt.yaml"]);await f.store.prepare(f.prepared);
});
it("supports Windows file permissions and skips unsupported directory flushes",async()=>{
 const f=fixture();vi.stubGlobal("process",{...process,platform:"win32"});await f.store.prepare(f.prepared);fs.chmodSync(f.path,0o666);expect(readPrivateFlyReplacement(f.config)).toEqual(f.prepared);
 const installed=await f.run();const archive=await f.store.archive(installed,async()=>{});expect(fs.existsSync(archive)).toBe(true);expect(readPrivateFlyReplacement(f.config)).toBeNull();
});
it("keeps pending state when it changes during an archive acknowledgement",async()=>{
 const f=fixture();await f.store.prepare(f.prepared);const installed=await f.run();let checks=0;
 await expect(f.store.archive(installed,async()=>{if(++checks===2){const value=JSON.parse(fs.readFileSync(f.path,"utf8"));value.state.phase="rolling_back";fs.writeFileSync(f.path,JSON.stringify(value),{mode:0o600});}})).rejects.toThrow("changed before archive");expect(readPrivateFlyReplacement(f.config)?.phase).toBe("rolling_back");
});
