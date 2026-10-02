import {env} from "cloudflare:test";
import {expect,it} from "vitest";
import {FlyMachinesClient,type FlyVolume} from "@logtura/core";
import {createConnection,createDeployment} from "../../src/db";
import {readConfigurationVersion} from "../../src/config-version";
import {prepareManagedCheckpoint,readManagedCheckpoint,executeManagedCheckpoint} from "../../src/managed-checkpoints";
import {mockFetch,seedUser} from "./_setup";

async function fixture(){
 const {userId}=await seedUser(),connection=await createConnection(env.DB,env,{userId,provider:"railway-logs",displayName:"Source",externalAccountId:"project",credentials:{apiToken:"private-source-token"}}),deployment=await createDeployment(env.DB,{userId,connectionId:connection.id,targetKind:"fly",displayName:"Managed",managed:true});
 const version=await readConfigurationVersion(env.DB,userId),input={userId,deploymentId:deployment.id,app:"app",org:"personal",region:"ord",configurationVersion:version},reservation=await prepareManagedCheckpoint(env,input);
 const expected={id:"vol_checkpoint",name:reservation.options.name,region:"ord",size_gb:1,encrypted:true,state:"created",attached_machine_id:null};
 let inventory:FlyVolume[]=[],creates=0,lose=false,omit=false,onRead:(()=>Promise<void>)|undefined,onWrite:(()=>Promise<void>)|undefined;
 mockFetch("https://api.machines.dev/",async req=>{
  expect(req.headers.get("authorization")).toBe("Bearer private-fly-token");const path=new URL(req.url).pathname;
  if(path==="/v1/apps/app")return Response.json({name:"app",organization:{slug:"personal"}});
  expect(path).toBe("/v1/apps/app/volumes");
  if(req.method==="POST"){
   creates++;expect(await env.DB.prepare("SELECT phase FROM managed_checkpoints WHERE id=?").bind(reservation.id).first("phase")).toBe("dispatched");
   expect(await req.json()).toEqual({name:reservation.options.name,region:"ord",size_gb:1,compute:{cpu_kind:"shared",cpus:2,memory_mb:4096},encrypted:true,machines_only:true,require_unique_zone:true});
   if(!omit)inventory=[expected];await onWrite?.();if(lose)throw new TypeError("volume acknowledgement lost");return Response.json(expected);
  }
  await onRead?.();return Response.json(inventory);
 });
 const client=new FlyMachinesClient({token:"private-fly-token"}),signal=new AbortController().signal;
 return {userId,deployment,input,version,reservation,expected,client,signal,get creates(){return creates;},get inventory(){return inventory;},set inventory(value){inventory=value;},set lose(value:boolean){lose=value;},set omit(value:boolean){omit=value;},set onRead(value:typeof onRead){onRead=value;},set onWrite(value:typeof onWrite){onWrite=value;},execute:()=>executeManagedCheckpoint(env,reservation,client,signal),read:()=>readManagedCheckpoint(env,userId,deployment.id,reservation.id)};
}
it("persists an immutable identity-only reservation before one encrypted volume POST",async()=>{
 const f=await fixture();expect(f.reservation).toMatchObject({phase:"prepared",volumeId:null,configurationVersion:f.version,options:{sizeGb:1,region:"ord",compute:{cpu_kind:"shared",cpus:2,memory_mb:4096}}});expect(f.reservation.options.name).toMatch(/^lt_[a-f0-9]{24}$/);
 expect(await f.execute()).toEqual(f.expected);expect(f.creates).toBe(1);expect(await f.read()).toMatchObject({phase:"ready",volumeId:f.expected.id});expect(await f.execute()).toEqual(f.expected);expect(f.creates).toBe(1);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.version);
 const row=await env.DB.prepare("SELECT * FROM managed_checkpoints WHERE id=?").bind(f.reservation.id).first();expect(JSON.stringify(row)).not.toContain("private");expect(row).toMatchObject({lease_token:null,lease_until:null});
 for(const assignment of ["id='other'","deployment_id='other'","user_id='other'","app_name='other'","org_slug='other'","region='iad'","configuration_version=999","volume_name='other'","size_gb=2","cpu_kind='performance'","cpus=4","memory_mb=8192","created_at=0","volume_id='vol_other'","volume_id=NULL"])await expect(env.DB.prepare(`UPDATE managed_checkpoints SET ${assignment} WHERE id=?`).bind(f.reservation.id).run()).rejects.toThrow("LOGT_CHECKPOINT_INTENT_IMMUTABLE");
});
it("recovers a lost response from one unique exact observation without duplicate provisioning",async()=>{
 const f=await fixture();f.lose=true;await expect(f.execute()).rejects.toThrow("acknowledgement lost");expect(await f.read()).toMatchObject({phase:"dispatched",volumeId:null});f.lose=false;expect(await f.execute()).toEqual(f.expected);expect(f.creates).toBe(1);expect(await f.read()).toMatchObject({phase:"ready",volumeId:f.expected.id});
});
it("retains an absent unknown outcome instead of issuing another POST",async()=>{
 const f=await fixture();f.lose=true;f.omit=true;await expect(f.execute()).rejects.toThrow("acknowledgement lost");f.lose=false;await expect(f.execute()).rejects.toThrow("outcome is unknown");expect(f.creates).toBe(1);expect(await f.read()).toMatchObject({phase:"dispatched",volumeId:null});
});
it("retains HTTP failure uncertainty without retrying creation",async()=>{
 const f=await fixture();let posts=0;mockFetch("https://api.machines.dev/",req=>new URL(req.url).pathname==="/v1/apps/app"?Response.json({name:"app",organization:{slug:"personal"}}):req.method==="POST"?(posts++,new Response("private-provider-error",{status:503})):Response.json([]));
 await expect(f.execute()).rejects.toThrow("HTTP 503");await expect(f.execute()).rejects.toThrow("outcome is unknown");expect(posts).toBe(1);expect(await f.read()).toMatchObject({phase:"dispatched"});
});
it("refuses ambiguous names rather than treating Fly volume names as unique",async()=>{
 const f=await fixture();f.lose=true;await expect(f.execute()).rejects.toThrow("acknowledgement lost");f.lose=false;f.inventory=[f.expected,{...f.expected,id:"vol_other"}];await expect(f.execute()).rejects.toThrow("ambiguous");expect(f.creates).toBe(1);expect((await f.read())!.volumeId).toBeNull();
});
it("refuses conflicting observations and never adopts a pre-dispatch name collision",async()=>{
 const f=await fixture();f.inventory=[f.expected];await expect(f.execute()).rejects.toThrow("dispatched reservation");expect(f.creates).toBe(0);
 f.inventory=[];f.lose=true;await expect(f.execute()).rejects.toThrow("acknowledgement lost");f.lose=false;
 for(const change of [{region:"iad"},{size_gb:2},{encrypted:false},{state:"deleting"},{attached_machine_id:"machine1"}]){f.inventory=[{...f.expected,...change}];await expect(f.execute()).rejects.toThrow("dispatched reservation");}expect(f.creates).toBe(1);
 // An unrelated volume is not an observation of this reservation.
 f.inventory=[{...f.expected,name:"unrelated"}];await expect(f.execute()).rejects.toThrow("outcome is unknown");
});
it("reuses the stable ready ID across configuration edits, growth and attachment without claiming mount availability",async()=>{
 const f=await fixture();await f.execute();await env.DB.prepare("UPDATE deployments SET display_name='New config' WHERE id=?").bind(f.deployment.id).run();
 expect((await prepareManagedCheckpoint(env,{...f.input,configurationVersion:await readConfigurationVersion(env.DB,f.userId)})).id).toBe(f.reservation.id);
 f.inventory=[{...f.expected,size_gb:2,attached_machine_id:"machine1"},{...f.expected,id:"vol_other"}];expect(await f.execute()).toEqual(f.inventory[0]);expect(f.creates).toBe(1);
 f.inventory=[f.expected,f.expected];await expect(f.execute()).rejects.toThrow("ambiguous");
});
it("refuses a missing or changed stable ready volume rather than replacing it",async()=>{
 const f=await fixture();await f.execute();for(const inventory of [[],[{...f.expected,id:"vol_other"}],[{...f.expected,name:"other"}],[{...f.expected,region:"iad"}],[{...f.expected,size_gb:0.5}],[{...f.expected,encrypted:false}],[{...f.expected,state:"deleting"}]]){
  f.inventory=inventory;await expect(f.execute()).rejects.toThrow(/saved identity|inventory/);
 }expect(f.creates).toBe(1);
});
it("serializes concurrent jobs using a leased reservation",async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(done=>entered=done),held=new Promise<void>(done=>release=done);f.onRead=async()=>{entered();await held;};const first=f.execute();await ready;await expect(f.execute()).rejects.toThrow("busy or terminal");release();expect(await first).toEqual(f.expected);expect(f.creates).toBe(1);
});
it("fences expired claims before dispatch and clears only its own lease",async()=>{
 const f=await fixture(),token=crypto.randomUUID();f.onRead=async()=>{await env.DB.prepare("UPDATE managed_checkpoints SET lease_token=?,lease_until=? WHERE id=?").bind(token,Date.now()+60_000,f.reservation.id).run();};await expect(f.execute()).rejects.toThrow("lease expired");expect(f.creates).toBe(0);
 expect(await env.DB.prepare("SELECT lease_token FROM managed_checkpoints WHERE id=?").bind(f.reservation.id).first("lease_token")).toBe(token);f.onRead=undefined;await expect(f.execute()).rejects.toThrow("busy");await env.DB.prepare("UPDATE managed_checkpoints SET lease_until=0 WHERE id=?").bind(f.reservation.id).run();expect(await f.execute()).toEqual(f.expected);
});
it("retains provider success if the claimant expires before recording the volume ID",async()=>{
 const f=await fixture();f.onWrite=async()=>{await env.DB.prepare("UPDATE managed_checkpoints SET lease_until=0 WHERE id=?").bind(f.reservation.id).run();};await expect(f.execute()).rejects.toThrow("lease expired");expect(await f.read()).toMatchObject({phase:"dispatched",volumeId:null});f.onWrite=undefined;expect(await f.execute()).toEqual(f.expected);expect(f.creates).toBe(1);
});
it("rejects graph changes before dispatch and preserves uncertain success during a change",async()=>{
 const before=await fixture();await env.DB.prepare("UPDATE deployments SET display_name='Changed' WHERE id=?").bind(before.deployment.id).run();await expect(before.execute()).rejects.toThrow("configuration changed");expect(before.creates).toBe(0);
 const during=await fixture();during.onWrite=async()=>{await env.DB.prepare("UPDATE deployments SET display_name='Changed' WHERE id=?").bind(during.deployment.id).run();};await expect(during.execute()).rejects.toThrow("configuration changed");expect(await during.read()).toMatchObject({phase:"dispatched",volumeId:null});expect(during.creates).toBe(1);await expect(during.execute()).rejects.toThrow("configuration changed");expect(during.creates).toBe(1);
});
it("rechecks graph and cancellation after inventory before marking dispatch",async()=>{
 const changed=await fixture();changed.onRead=async()=>{await env.DB.prepare("UPDATE deployments SET display_name='Changed' WHERE id=?").bind(changed.deployment.id).run();};await expect(changed.execute()).rejects.toThrow("configuration changed");expect(changed.creates).toBe(0);
 const f=await fixture(),stop=new AbortController();f.onRead=async()=>stop.abort(new Error("cancelled"));await expect(executeManagedCheckpoint(env,f.reservation,f.client,stop.signal)).rejects.toThrow("cancelled");expect(f.creates).toBe(0);
});
it("rejects cancellation, target mismatches and no-longer-managed ownership",async()=>{
 const f=await fixture(),stop=new AbortController();stop.abort(new Error("cancelled"));await expect(executeManagedCheckpoint(env,f.reservation,f.client,stop.signal)).rejects.toThrow("cancelled");expect(f.creates).toBe(0);
 for(const change of [{app:"other"},{org:"other"},{region:"iad"}])await expect(prepareManagedCheckpoint(env,{...f.input,...change})).rejects.toThrow("target changed");
 mockFetch("https://api.machines.dev/",()=>Response.json({name:"app",organization:{slug:"other"}}));await expect(f.execute()).rejects.toThrow("organization");
 await env.DB.prepare("UPDATE deployments SET managed=0 WHERE id=?").bind(f.deployment.id).run();await expect(f.execute()).rejects.toThrow("no longer owned");expect(f.creates).toBe(0);
 expect(await readManagedCheckpoint(env,"unowned",f.deployment.id)).toBeNull();await expect(prepareManagedCheckpoint(env,{...f.input,userId:"unowned"})).rejects.toThrow();
});
it("validates new reservation inputs and graph fences without publishing invalid rows",async()=>{
 const f=await fixture();await env.DB.prepare("DELETE FROM managed_checkpoints WHERE id=?").bind(f.reservation.id).run();
 for(const change of [{app:"bad/app"},{org:"bad/org"},{region:"invalid"},{configurationVersion:-1},{configurationVersion:0.5},{configurationVersion:0}])await expect(prepareManagedCheckpoint(env,{...f.input,...change})).rejects.toThrow();expect(await readManagedCheckpoint(env,f.userId,f.deployment.id)).toBeNull();
 await env.DB.prepare("UPDATE deployments SET managed=0 WHERE id=?").bind(f.deployment.id).run();await expect(prepareManagedCheckpoint(env,{...f.input,configurationVersion:await readConfigurationVersion(env.DB,f.userId)})).rejects.toThrow("Managed deployment not found");
});
it("deduplicates concurrent preparations and indexes the one active reservation",async()=>{
 const f=await fixture();await env.DB.prepare("DELETE FROM managed_checkpoints WHERE id=?").bind(f.reservation.id).run();const prepared=await Promise.all([prepareManagedCheckpoint(env,f.input),prepareManagedCheckpoint(env,f.input)]);expect(prepared[0]!.id).toBe(prepared[1]!.id);
 expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM managed_checkpoints WHERE deployment_id=?").bind(f.deployment.id).first("count")).toBe(1);
 const plan=await env.DB.prepare("EXPLAIN QUERY PLAN SELECT * FROM managed_checkpoints WHERE deployment_id=? AND phase IN ('prepared','dispatched','ready')").bind(f.deployment.id).all();expect(JSON.stringify(plan.results)).toContain("managed_checkpoint_active");
});
it("preserves obsolete identities while allowing an explicit future reservation and cascades ownership deletion",async()=>{
 const f=await fixture();await f.execute();await env.DB.prepare("UPDATE managed_checkpoints SET phase='obsolete' WHERE id=?").bind(f.reservation.id).run();expect(await readManagedCheckpoint(env,f.userId,f.deployment.id)).toBeNull();expect(await f.read()).toMatchObject({phase:"obsolete",volumeId:f.expected.id});await expect(f.execute()).rejects.toThrow("terminal");
 const next=await prepareManagedCheckpoint(env,f.input);expect(next.id).not.toBe(f.reservation.id);expect(next.options.name).not.toBe(f.reservation.options.name);
 await env.DB.prepare("DELETE FROM deployments WHERE id=?").bind(f.deployment.id).run();expect(await f.read()).toBeNull();expect(await env.DB.prepare("SELECT COUNT(*) FROM managed_checkpoints WHERE deployment_id=?").bind(f.deployment.id).first("COUNT(*)")).toBe(0);
});
it("refuses imported invalid reservation identities and placement without changing production guards",async()=>{
 const f=await fixture(),row=(await env.DB.prepare("SELECT * FROM managed_checkpoints WHERE id=?").bind(f.reservation.id).first<Record<string,unknown>>())!,columns=Object.keys(row);
 for(const change of [{id:"bad"},{volume_name:"wrong"},{app_name:"bad/app"},{org_slug:"bad/org"},{region:"invalid"},{configuration_version:0.5},{size_gb:1.5},{cpus:1.5},{memory_mb:1.5},{volume_id:"bad",phase:"ready"}]){
  await env.DB.prepare("DELETE FROM managed_checkpoints WHERE deployment_id=?").bind(f.deployment.id).run();const invalid={...row,...change};
  await env.DB.prepare(`INSERT INTO managed_checkpoints(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).bind(...columns.map(column=>invalid[column])).run();
  await expect(readManagedCheckpoint(env,f.userId,f.deployment.id)).rejects.toThrow("Invalid managed checkpoint reservation");
 }
});
it("handles deletion between claim and owned reread without contacting Fly",async()=>{
 const f=await fixture(),name=`checkpoint_delete_${f.reservation.id.replaceAll("-","")}`;
 await env.DB.exec(`CREATE TRIGGER ${name} AFTER UPDATE OF lease_token ON managed_checkpoints WHEN NEW.id='${f.reservation.id}' AND NEW.lease_token IS NOT NULL BEGIN DELETE FROM deployments WHERE id=NEW.deployment_id; END;`);
 try {await expect(f.execute()).rejects.toThrow("no longer owned");expect(f.creates).toBe(0);expect(await f.read()).toBeNull();}
 finally {await env.DB.exec(`DROP TRIGGER ${name}`);}
});
it("rechecks ready reservation ownership after reading provider storage",async()=>{
 const f=await fixture();await f.execute();f.onRead=async()=>{await env.DB.prepare("DELETE FROM deployments WHERE id=?").bind(f.deployment.id).run();};await expect(f.execute()).rejects.toThrow("no longer owned");expect(f.creates).toBe(1);
});
it("refuses ready reference confirmation after claim expiry or obsolescence during inventory",async()=>{
 const expired=await fixture();await expired.execute();expired.onRead=async()=>{await env.DB.prepare("UPDATE managed_checkpoints SET lease_until=0 WHERE id=?").bind(expired.reservation.id).run();};await expect(expired.execute()).rejects.toThrow("lease expired");expect(expired.creates).toBe(1);
 const obsolete=await fixture();await obsolete.execute();obsolete.onRead=async()=>{await env.DB.prepare("UPDATE managed_checkpoints SET phase='obsolete' WHERE id=?").bind(obsolete.reservation.id).run();};await expect(obsolete.execute()).rejects.toThrow("lease expired");expect(obsolete.creates).toBe(1);
});
it("prevents phase regression or skipping durable dispatch at the database boundary",async()=>{
 const f=await fixture();await expect(env.DB.prepare("UPDATE managed_checkpoints SET phase='ready',volume_id='vol_unissued' WHERE id=?").bind(f.reservation.id).run()).rejects.toThrow("LOGT_CHECKPOINT_PHASE_REGRESSION");
 await env.DB.prepare("UPDATE managed_checkpoints SET phase='dispatched' WHERE id=?").bind(f.reservation.id).run();await expect(env.DB.prepare("UPDATE managed_checkpoints SET phase='prepared' WHERE id=?").bind(f.reservation.id).run()).rejects.toThrow("LOGT_CHECKPOINT_PHASE_REGRESSION");
 f.inventory=[f.expected];await f.execute();await expect(env.DB.prepare("UPDATE managed_checkpoints SET phase='dispatched' WHERE id=?").bind(f.reservation.id).run()).rejects.toThrow("LOGT_CHECKPOINT_PHASE_REGRESSION");
 await env.DB.prepare("UPDATE managed_checkpoints SET phase='obsolete' WHERE id=?").bind(f.reservation.id).run();await expect(env.DB.prepare("UPDATE managed_checkpoints SET phase='ready' WHERE id=?").bind(f.reservation.id).run()).rejects.toThrow("LOGT_CHECKPOINT_PHASE_REGRESSION");
});
