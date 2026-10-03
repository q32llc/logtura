import {env} from "cloudflare:test";
import {expect,it} from "vitest";
import {FlyMachinesClient,type FlyMachine,type FlyMachineConfig} from "@logtura/core";
import {createDeployment,createConnection} from "../../src/db";
import {prepareManagedInstall,readManagedInstall,executeManagedInstall,completeManagedInstall,recordManagedInstallVersion} from "../../src/managed-installations";
import {commitConfiguration,readConfigurationVersion} from "../../src/config-version";
import {encryptSecret} from "../../src/crypto";
import {mockFetch,seedUser} from "./_setup";
const image=`registry.test/forwarder@sha256:${"a".repeat(64)}`;
function machine():FlyMachine & {name:string}{return {id:"machine1",name:"forwarder",instance_id:"version1",state:"started",region:"ord",config:{image:"registry.test/old:latest",env:{OLD:"private-old-secret"}},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};}
async function fixture(update=false){
 const {userId}=await seedUser(),connection=await createConnection(env.DB,env,{userId,provider:"railway-logs",displayName:"Source",externalAccountId:"project",credentials:{apiToken:"private-source-token"}}),deployment=await createDeployment(env.DB,{userId,connectionId:connection.id,targetKind:"fly",displayName:"Managed",managed:true});
 const configurationVersion=await readConfigurationVersion(env.DB,userId),input={userId,deploymentId:deployment.id,app:"app",org:"personal",region:"ord",configurationVersion,config:{image,env:{REPORT_TOKEN:"private-install-token"}} as FlyMachineConfig,machine:update?machine():null};
 const install=await prepareManagedInstall(env,input);let live=update?machine():null,creates=0,updates=0,leases=0,releases=0,lose=false,omit=false;
 let onWrite:(()=>Promise<void>)|undefined,onRead:(()=>Promise<void>)|undefined;
 mockFetch("https://api.machines.dev/",async req=>{
  expect(req.headers.get("authorization")).toBe("Bearer private-fly-token");const path=new URL(req.url).pathname;
  if(path==="/v1/apps/app")return Response.json({name:"app",organization:{slug:"personal"}});
  if(path.endsWith("/lease")){if(req.method==="DELETE"){releases++;return new Response(null,{status:204});}leases++;return Response.json({data:{nonce:"private-lease"}});}
  if(req.method==="POST"){
   const row=await env.DB.prepare("SELECT phase,CAST(payload_encrypted AS TEXT) AS payload FROM managed_installations WHERE id=?").bind(install.id).first<{phase:string;payload:string}>();expect(row!.phase).toBe("dispatched");expect(row!.payload).not.toContain("private-install-token");
   const body=await req.json() as {config:FlyMachineConfig;name:string;region:string;current_version:string};expect(body.config).toEqual(install.payload.after);
   if(path.endsWith("/machines")){creates++;expect(body.name).toBe("forwarder");expect(body.region).toBe("ord");}
   else{updates++;expect(body.current_version).toBe("version1");expect(req.headers.get("fly-machine-lease-nonce")).toBe("private-lease");}
   if(!omit)live={...machine(),config:body.config,instance_id:"version2",image_ref:{registry:"registry.test",repository:"forwarder",digest:image.split("@")[1]!}};
   await onWrite?.();if(lose)throw new TypeError("provider acknowledgement lost");return Response.json(live);
  }
  await onRead?.();return Response.json(path.endsWith("/machines")?(live?[live]:[]):live);
 });
 const client=new FlyMachinesClient({token:"private-fly-token"}),signal=new AbortController().signal;
 return {userId,deployment,configurationVersion,input,install,client,signal,get live(){return live;},set live(value){live=value;},get creates(){return creates;},get updates(){return updates;},get leases(){return leases;},get releases(){return releases;},set lose(value:boolean){lose=value;},set omit(value:boolean){omit=value;},set onWrite(value:typeof onWrite){onWrite=value;},set onRead(value:typeof onRead){onRead=value;},execute:()=>executeManagedInstall(env,install,client,signal)};
}
it("persists encrypted immutable create intent and installs exact bytes before recording provider identity",async()=>{
 const f=await fixture();expect((await readManagedInstall(env,f.userId,f.deployment.id))!.phase).toBe("prepared");expect(await f.execute()).toBe("machine1");expect(f.creates).toBe(1);
 const saved=(await readManagedInstall(env,f.userId,f.deployment.id,f.install.id))!;expect(saved).toMatchObject({phase:"installed",machineId:"machine1",payload:{rollback:null,before:null}});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.configurationVersion);
 expect(await f.execute()).toBe("machine1");expect(f.creates).toBe(1);expect((await prepareManagedInstall(env,f.input)).id).toBe(f.install.id);
 for(const sql of ["app_name='other'","region='iad'","configuration_version=999","payload_encrypted=x'01'","created_at=0","deployment_id='other'","id='other'","user_id='other'"])await expect(env.DB.prepare(`UPDATE managed_installations SET ${sql} WHERE id=?`).bind(f.install.id).run()).rejects.toThrow("LOGT_INSTALL_INTENT_IMMUTABLE");
 const lease=await env.DB.prepare("SELECT lease_token,lease_until FROM managed_installations WHERE id=?").bind(f.install.id).first();expect(lease).toEqual({lease_token:null,lease_until:null});
});
it("observes a lost create response and never creates a second machine",async()=>{
 const f=await fixture();f.lose=true;await expect(f.execute()).rejects.toThrow("acknowledgement lost");expect((await readManagedInstall(env,f.userId,f.deployment.id))!.phase).toBe("dispatched");f.lose=false;expect(await f.execute()).toBe("machine1");expect(f.creates).toBe(1);
});
it("retains an unknown absent create without blindly repeating it",async()=>{
 const f=await fixture();f.lose=true;f.omit=true;await expect(f.execute()).rejects.toThrow("acknowledgement lost");f.lose=false;await expect(f.execute()).rejects.toThrow("outcome is unknown");expect(f.creates).toBe(1);expect((await readManagedInstall(env,f.userId,f.deployment.id))!.phase).toBe("dispatched");
});
it("recovers lost updates using the same complete before/after config and one provider write",async()=>{
 const f=await fixture(true);f.lose=true;await expect(f.execute()).rejects.toThrow("acknowledgement lost");expect(f.releases).toBe(1);f.lose=false;expect(await f.execute()).toBe("machine1");expect(f.updates).toBe(1);expect(f.leases).toBe(2);expect(f.releases).toBe(2);
 expect((await readManagedInstall(env,f.userId,f.deployment.id))!.payload.rollback!.image).toBe(`registry.test/old@sha256:${"b".repeat(64)}`);
});
it("refuses changed or missing machines without overwriting competing configuration",async()=>{
 const f=await fixture(true);f.live=null;await expect(f.execute()).rejects.toThrow("same single");f.live={...machine(),id:"other"};await expect(f.execute()).rejects.toThrow("same single");f.live={...machine(),instance_id:"outside",config:{image,env:{OUTSIDE:"change"}}};await expect(f.execute()).rejects.toThrow("changed after planning");expect(f.updates).toBe(0);
 mockFetch("https://api.machines.dev/",req=>new URL(req.url).pathname==="/v1/apps/app"?Response.json({name:"app",organization:{slug:"personal"}}):Response.json([machine(),{...machine(),id:"other"}]));await expect(f.execute()).rejects.toThrow("one owned forwarder");
});
it("refuses counterfeit or ambiguous create observations",async()=>{
 const f=await fixture();for(const candidate of [{...machine(),config:{image}},{...machine(),region:"iad",config:f.install.payload.after},{...machine(),name:"other",config:f.install.payload.after}]){f.live=candidate;await expect(f.execute()).rejects.toThrow("saved create intent");}
 mockFetch("https://api.machines.dev/",req=>new URL(req.url).pathname==="/v1/apps/app"?Response.json({name:"app",organization:{slug:"personal"}}):Response.json([{...machine(),config:f.install.payload.after},{...machine(),id:"other",config:f.install.payload.after}]));await expect(f.execute()).rejects.toThrow("saved create intent");expect(f.creates).toBe(0);
});
it("serializes concurrent recovery jobs with a database lease",async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(done=>release=done),ready=new Promise<void>(done=>entered=done);f.onRead=async()=>{entered();await waiting;};
 const first=f.execute();await ready;await expect(f.execute()).rejects.toThrow("busy or terminal");release();expect(await first).toBe("machine1");expect(f.creates).toBe(1);
});
it("does not clear another claimant's lease after an expired provider call",async()=>{
 const f=await fixture(),token=crypto.randomUUID();f.onWrite=async()=>{await env.DB.prepare("UPDATE managed_installations SET lease_token=?,lease_until=? WHERE id=?").bind(token,Date.now()+60_000,f.install.id).run();};await expect(f.execute()).rejects.toThrow("lease expired");
 expect(await env.DB.prepare("SELECT lease_token FROM managed_installations WHERE id=?").bind(f.install.id).first()).toEqual({lease_token:token});await expect(f.execute()).rejects.toThrow("busy");await env.DB.prepare("UPDATE managed_installations SET lease_until=0 WHERE id=?").bind(f.install.id).run();f.onWrite=undefined;expect(await f.execute()).toBe("machine1");expect(f.creates).toBe(1);
});
it("rejects graph changes before mutation and retains changes made during provider installation",async()=>{
 const before=await fixture();await env.DB.prepare("UPDATE deployments SET display_name='Changed' WHERE id=?").bind(before.deployment.id).run();await expect(before.execute()).rejects.toThrow("configuration changed");expect(before.creates).toBe(0);
 const during=await fixture();during.onWrite=async()=>{await env.DB.prepare("UPDATE deployments SET display_name='Changed' WHERE id=?").bind(during.deployment.id).run();};await expect(during.execute()).rejects.toThrow("configuration changed");expect(during.creates).toBe(1);expect((await readManagedInstall(env,during.userId,during.deployment.id))!.phase).toBe("dispatched");
});
it("rejects cancellation and no-longer-managed ownership before provider dispatch",async()=>{
 const f=await fixture(),stop=new AbortController();stop.abort();await expect(executeManagedInstall(env,f.install,f.client,stop.signal)).rejects.toThrow("interrupted");expect(f.creates).toBe(0);
 await env.DB.prepare("UPDATE deployments SET managed=0 WHERE id=?").bind(f.deployment.id).run();await expect(f.execute()).rejects.toThrow("configuration changed");
 expect(await readManagedInstall(env,"unowned",f.deployment.id)).toBeNull();await expect(prepareManagedInstall(env,{...f.input,userId:"unowned"})).rejects.toThrow();
});
it("binds the post-target-write graph base and atomically completes only installed intent",async()=>{
 const f=await fixture();await f.execute();const committed=await commitConfiguration(env.DB,f.userId,f.configurationVersion,[env.DB.prepare("UPDATE deployments SET external_id='fly:app:machine1' WHERE id=?").bind(f.deployment.id),recordManagedInstallVersion(env.DB,f.install.id,f.userId)]);
 const saved=(await readManagedInstall(env,f.userId,f.deployment.id,f.install.id))!;expect(saved.installedConfigurationVersion).toBe(committed.version);expect(await f.execute()).toBe("machine1");expect(f.creates).toBe(1);
 await commitConfiguration(env.DB,f.userId,committed.version,[completeManagedInstall(env.DB,f.install.id,f.userId)]);expect(await readManagedInstall(env,f.userId,f.deployment.id)).toBeNull();expect((await readManagedInstall(env,f.userId,f.deployment.id,f.install.id))!.phase).toBe("completed");await expect(f.execute()).rejects.toThrow("terminal");
});
it("validates target identity and stale preparation without publishing any intent",async()=>{
 const f=await fixture();for(const input of [{...f.input,app:"other"},{...f.input,region:"iad"},{...f.input,org:"other"}])await expect(prepareManagedInstall(env,input)).rejects.toThrow("target changed");
 await env.DB.prepare("DELETE FROM managed_installations WHERE id=?").bind(f.install.id).run();for(const input of [{...f.input,app:"bad/app"},{...f.input,org:"bad/org"},{...f.input,region:"region"},{...f.input,machine:{...machine(),region:"iad"}},{...f.input,config:{image:"latest"}},{...f.input,configurationVersion:0}])await expect(prepareManagedInstall(env,input)).rejects.toThrow();expect(await readManagedInstall(env,f.userId,f.deployment.id)).toBeNull();
 await env.DB.prepare("UPDATE deployments SET managed=0 WHERE id=?").bind(f.deployment.id).run();await expect(prepareManagedInstall(env,{...f.input,configurationVersion:await readConfigurationVersion(env.DB,f.userId)})).rejects.toThrow("Managed deployment not found");
});
it("rejects corrupted ciphertext or invalid private intent with payload-free diagnostics",async()=>{
 const f=await fixture(true);
 for(const value of [null,[],{}, {...f.install.payload,schemaVersion:2},{...f.install.payload,name:"other"},{...f.install.payload,after:[]},{...f.install.payload,after:{image}},{...f.install.payload,before:{...machine(),region:"iad"}},{...f.install.payload,rollback:{image}},{...f.install.payload,before:null,rollback:{image}}]){
  const encrypted=await encryptSecret(JSON.stringify(value),env.CREDENTIAL_ENCRYPTION_KEY);await corrupt(f.install.id,encrypted);await expect(readManagedInstall(env,f.userId,f.deployment.id)).rejects.toThrow("Invalid encrypted managed installation");
 }
 await corrupt(f.install.id,new Uint8Array([1]));await expect(readManagedInstall(env,f.userId,f.deployment.id)).rejects.toThrow("retain it for recovery");
});
it("indexes active intent and cascades private state when its owned deployment is deleted",async()=>{
 const f=await fixture(),plan=await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM managed_installations WHERE deployment_id=? AND phase IN ('prepared','dispatched','installed')").bind(f.deployment.id).all<{detail:string}>();expect(plan.results.map(r=>r.detail).join(" ")).toContain("managed_installation_active");await env.DB.prepare("DELETE FROM deployments WHERE id=?").bind(f.deployment.id).run();expect(await env.DB.prepare("SELECT id FROM managed_installations WHERE id=?").bind(f.install.id).first()).toBeNull();
});

it("converges concurrent preparation on one immutable active install",async()=>{
 const f=await fixture();await env.DB.prepare("DELETE FROM managed_installations WHERE id=?").bind(f.install.id).run();
 const prepared=await Promise.all([prepareManagedInstall(env,f.input),prepareManagedInstall(env,f.input)]);expect(prepared[0]!.id).toBe(prepared[1]!.id);expect((await env.DB.prepare("SELECT id FROM managed_installations WHERE deployment_id=?").bind(f.deployment.id).all()).results).toHaveLength(1);
});
it("rejects oversized intent before encryption/provider mutation and bounds corrupt recovery reads",async()=>{
 const f=await fixture();await env.DB.prepare("DELETE FROM managed_installations WHERE id=?").bind(f.install.id).run();
 await expect(prepareManagedInstall(env,{...f.input,config:{image,env:{LARGE:"x".repeat(1_900_000)}}})).rejects.toThrow("recovery limit");expect(await readManagedInstall(env,f.userId,f.deployment.id)).toBeNull();
 const next=await prepareManagedInstall(env,f.input);await corrupt(next.id,new Uint8Array(1_900_029));await expect(readManagedInstall(env,f.userId,f.deployment.id)).rejects.toThrow("Invalid encrypted managed installation");expect(f.creates).toBe(0);
});
it("fences an expired database dispatch lease before the provider write",async()=>{
 const f=await fixture();f.onRead=async()=>{await env.DB.prepare("UPDATE managed_installations SET lease_until=0 WHERE id=?").bind(f.install.id).run();};await expect(f.execute()).rejects.toThrow("lease expired");expect(f.creates).toBe(0);expect((await readManagedInstall(env,f.userId,f.deployment.id))!.phase).toBe("prepared");f.onRead=undefined;expect(await f.execute()).toBe("machine1");
});
it("refuses an organization mismatch before creating a machine",async()=>{
 const f=await fixture();mockFetch("https://api.machines.dev/",()=>Response.json({name:"app",organization:{slug:"other"}}));await expect(f.execute()).rejects.toThrow("organization does not match");expect(f.creates).toBe(0);expect((await readManagedInstall(env,f.userId,f.deployment.id))!.phase).toBe("prepared");
});

// Emulate corrupted imported storage without removing production immutability guards.
async function corrupt(id:string,encrypted:Uint8Array):Promise<void> {
 await env.DB.prepare(`INSERT OR REPLACE INTO managed_installations(id,deployment_id,user_id,app_name,org_slug,region,configuration_version,payload_encrypted,phase,machine_id,installed_configuration_version,lease_token,lease_until,created_at,updated_at)
  SELECT id,deployment_id,user_id,app_name,org_slug,region,configuration_version,?,phase,machine_id,installed_configuration_version,lease_token,lease_until,created_at,updated_at
  FROM managed_installations WHERE id=?`).bind(encrypted,id).run();
}
it("rejects a replacement cursor on a legacy encrypted installation",async()=>{
 const f=await fixture();await env.DB.prepare("UPDATE managed_installations SET replacement_phase='creating' WHERE id=?").bind(f.install.id).run();await expect(readManagedInstall(env,f.userId,f.deployment.id)).rejects.toThrow("Invalid encrypted managed installation");expect(f.creates).toBe(0);
});
