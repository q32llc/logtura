import { env } from "cloudflare:test";
import { expect,it } from "vitest";
import { loadOwnedGraphInventory,prepareGraphReconciliation,reconcileOwnedGraph } from "../../src/graph-reconciliation";
import { createConnection,createDestination,createMonitor,createSink,createDeployment,upsertSources } from "../../src/db";
import { encryptSecret } from "../../src/crypto";
import { readConfigurationVersion } from "../../src/config-version";
import { seedUser } from "./_setup";
import type { GenerateInput } from "@logtura/core";

async function fixture(){
  const {userId}=await seedUser();const connection=await createConnection(env.DB,env,{userId,provider:"cloudflare-worker-tail",displayName:"Account",externalAccountId:"account",credentials:{apiToken:"owned-private-token"}});
  await upsertSources(env.DB,connection.id,[{sourceKind:"cf_worker",externalId:"site",displayName:"Site",metadata:{private:"owned-private-metadata"}}]);
  const destination=await createDestination(env.DB,env,{userId,kind:"webhook",displayName:"Alerts",config:{url:"https://private.test/hook"}});
  const monitor=await createMonitor(env.DB,{userId,connectionId:connection.id,displayName:"Errors",filterSteps:[{kind:"errors"}],enabled:true});
  const sink=await createSink(env.DB,{monitorId:monitor.id,destinationId:destination.id,filterSteps:[]});
  return {userId,connection,destination,monitor,sink};
}
function input(snapshot:Awaited<ReturnType<typeof loadOwnedGraphInventory>>):GenerateInput{
  const i=snapshot.value;return {providers:[],destinations:[],connections:i.connections.map(c=>({...c,selectedSources:i.sources.filter(s=>s.connectionId===c.connection.id).map(s=>s.source)})),monitors:i.monitors.map(m=>({monitor:m,sinks:i.sinks.filter(s=>s.monitorId===m.id).map(s=>({sink:s.sink,destination:i.destinations.find(d=>d.destination.id===s.destinationId)!.destination,destinationConfig:i.destinations.find(d=>d.destination.id===s.destinationId)!.config}))}))};
}
it("reads only owned inventory, maps private row codecs, and invokes the public reconciliation planner without writes",async()=>{
  const own=await fixture(),other=await fixture();await env.DB.prepare("UPDATE connections SET display_name='Other secret label' WHERE id=?").bind(other.connection.id).run();
  const snapshot=await loadOwnedGraphInventory(env,own.userId);expect(snapshot.value.connections).toHaveLength(1);expect(snapshot.value.connections[0]!.credentials).toEqual({apiToken:"owned-private-token"});expect(snapshot.value.sources[0]!.source.metadata).toEqual({private:"owned-private-metadata"});expect(snapshot.value.monitors[0]!.filterSteps).toEqual([{kind:"errors"}]);expect(snapshot.value.sinks[0]!.sink.filterSteps).toEqual([]);expect(JSON.stringify(snapshot)).not.toContain("Other secret label");expect(JSON.stringify(snapshot)).not.toContain(other.userId);
  const desired=structuredClone(input(snapshot));desired.connections[0]!.selectedSources[0]!.id="src_local";desired.connections[0]!.selectedSources[0]!.metadata=null;const prepared=await prepareGraphReconciliation(env,own.userId,snapshot.version,desired);expect(prepared.plan.sourceAliases).toEqual({src_local:snapshot.value.sources[0]!.source.id});expect(prepared.plan.sources).toEqual([]);expect(await readConfigurationVersion(env.DB,own.userId)).toBe(snapshot.version);
  await env.DB.prepare("UPDATE monitors SET enabled=0 WHERE id=?").bind(own.monitor.id).run();await expect(prepareGraphReconciliation(env,own.userId,snapshot.version,desired)).rejects.toMatchObject({name:"ConfigurationConflict",expectedVersion:snapshot.version});
});
it("handles nullable metadata and empty owned inventories",async()=>{
  const own=await fixture();await env.DB.prepare("UPDATE log_sources SET metadata_json=NULL WHERE connection_id=?").bind(own.connection.id).run();expect((await loadOwnedGraphInventory(env,own.userId)).value.sources[0]!.source.metadata).toBeNull();
  await env.DB.prepare("UPDATE log_sources SET metadata_json='null' WHERE connection_id=?").bind(own.connection.id).run();expect((await loadOwnedGraphInventory(env,own.userId)).value.sources[0]!.source.metadata).toBeNull();
  const empty=await seedUser();expect((await loadOwnedGraphInventory(env,empty.userId)).value).toEqual({connections:[],sources:[],destinations:[],monitors:[],sinks:[]});
});
it.each(["invalid-private-metadata","[]","false"])("rejects invalid stored metadata without reflecting values (%s)",async value=>{
  const own=await fixture();await env.DB.prepare("UPDATE log_sources SET metadata_json=? WHERE connection_id=?").bind(value,own.connection.id).run();await expect(loadOwnedGraphInventory(env,own.userId)).rejects.toThrow("Invalid stored source metadata");
});
it.each([null,[],"private-credential-value",0])("rejects non-object stored credentials (%s)",async value=>{
  const own=await fixture();const encrypted=await encryptSecret(JSON.stringify(value),env.CREDENTIAL_ENCRYPTION_KEY);await env.DB.prepare("UPDATE connections SET credentials_encrypted=? WHERE id=?").bind(encrypted,own.connection.id).run();await expect(loadOwnedGraphInventory(env,own.userId)).rejects.toThrow("Invalid stored connection credential");
});
it.each(["connections","destinations"])("sanitizes broken %s ciphertext failures",async table=>{
  const own=await fixture();await env.DB.prepare(`UPDATE ${table} SET ${table==="connections"?"credentials_encrypted":"config_encrypted"}=? WHERE id=?`).bind(new Uint8Array([1,2,3]),table==="connections"?own.connection.id:own.destination.id).run();await expect(loadOwnedGraphInventory(env,own.userId)).rejects.toThrow(table==="connections"?"Invalid stored connection credential":"Invalid stored destination configuration");
});

it("atomically persists an entire new graph, encrypts secrets, and then performs a no-op",async()=>{
  const owner=await seedUser(),template=await fixture(),desired=structuredClone(input(await loadOwnedGraphInventory(env,template.userId)));
  desired.connections[0]!.connection.id="con_new";desired.connections[0]!.selectedSources[0]!.id="src_new";desired.monitors[0]!.monitor.id="mon_new";desired.monitors[0]!.monitor.connectionId="con_new";desired.monitors[0]!.sinks[0]!.sink.id="snk_new";desired.monitors[0]!.sinks[0]!.destination.id="dst_new";
  desired.monitors.push({monitor:{id:"mon_global",connectionId:null,displayName:"Global",enabled:false,filterSteps:[]},sinks:[]});
  desired.monitors[0]!.sinks.push({sink:{id:"snk_second",filterSteps:[{kind:"errors"}]},destination:structuredClone(desired.monitors[0]!.sinks[0]!.destination),destinationConfig:structuredClone(desired.monitors[0]!.sinks[0]!.destinationConfig)});
  const before=await readConfigurationVersion(env.DB,owner.userId),result=await reconcileOwnedGraph(env,owner.userId,before,desired);
  expect(result.version).toBeGreaterThan(before);const snapshot=await loadOwnedGraphInventory(env,owner.userId);expect(input(snapshot).connections).toEqual(desired.connections);expect(input(snapshot).monitors).toEqual(expect.arrayContaining(desired.monitors));
  const rows=await env.DB.prepare("SELECT credentials_encrypted FROM connections WHERE user_id=?").bind(owner.userId).all();expect(JSON.stringify(rows)).not.toContain("owned-private-token");
  const repeat=await reconcileOwnedGraph(env,owner.userId,result.version,desired);expect(repeat.version).toBe(result.version);expect(repeat.plan.connections).toEqual([]);
});
it("updates shared owned inventory and marks only the owner's deployed bundles outdated",async()=>{
  const own=await fixture(),other=await fixture();
  const ownDeployment=await createDeployment(env.DB,{userId:own.userId,connectionId:own.connection.id,displayName:"Own",targetKind:"other"});
  const otherDeployment=await createDeployment(env.DB,{userId:other.userId,connectionId:other.connection.id,displayName:"Other",targetKind:"other"});
  await env.DB.prepare("UPDATE deployments SET bundle_outdated=0").run();
  const snapshot=await loadOwnedGraphInventory(env,own.userId),desired=structuredClone(input(snapshot));
  desired.connections[0]!.connection.displayName="Updated account";desired.connections[0]!.credentials={apiToken:"updated-private-token"};desired.connections[0]!.selectedSources[0]!.displayName="Updated site";desired.connections[0]!.selectedSources[0]!.metadata=null;
  desired.monitors[0]!.monitor.enabled=false;desired.monitors[0]!.monitor.filterSteps=[];desired.monitors[0]!.sinks[0]!.sink.filterSteps=[{kind:"errors"}];desired.monitors[0]!.sinks[0]!.destination.displayName="Updated alerts";
  await reconcileOwnedGraph(env,own.userId,snapshot.version,desired);
  const updated=await loadOwnedGraphInventory(env,own.userId);expect(input(updated)).toEqual(desired);
  desired.monitors[0]!.sinks[0]!.sink.filterSteps=[];desired.monitors[0]!.monitor.enabled=true;desired.monitors[0]!.monitor.filterSteps=[{kind:"errors"}];await reconcileOwnedGraph(env,own.userId,updated.version,desired);expect(input(await loadOwnedGraphInventory(env,own.userId))).toEqual(desired);
  expect(await env.DB.prepare("SELECT bundle_outdated FROM deployments WHERE id=?").bind(ownDeployment.id).first("bundle_outdated")).toBe(1);
  expect(await env.DB.prepare("SELECT bundle_outdated FROM deployments WHERE id=?").bind(otherDeployment.id).first("bundle_outdated")).toBe(0);
});
it("adopts a known source without rewriting it and removes only sinks of retained monitors",async()=>{
  const own=await fixture(),snapshot=await loadOwnedGraphInventory(env,own.userId),desired=structuredClone(input(snapshot));
  desired.connections[0]!.selectedSources[0]!.id="src_cli";desired.connections[0]!.selectedSources[0]!.metadata=null;desired.monitors[0]!.sinks=[];
  const result=await reconcileOwnedGraph(env,own.userId,snapshot.version,desired);expect(result.plan.sourceAliases.src_cli).toBe(snapshot.value.sources[0]!.source.id);
  const after=await loadOwnedGraphInventory(env,own.userId);expect(after.value.sinks).toEqual([]);expect(after.value.sources).toEqual(snapshot.value.sources);expect(after.value.destinations).toEqual(snapshot.value.destinations);
  const deselected=structuredClone(result.plan.input);deselected.monitors=[];deselected.connections[0]!.selectedSources=[];
  expect((await reconcileOwnedGraph(env,own.userId,after.version,deselected)).version).toBe(after.version);expect((await loadOwnedGraphInventory(env,own.userId)).value.monitors).toHaveLength(1);
});
it.each(["connection","source","destination","monitor","sink"])("rolls back all earlier mutations when a new %s ID belongs to another account",async entity=>{
  const own=await fixture(),other=await fixture(),snapshot=await loadOwnedGraphInventory(env,own.userId),foreign=await loadOwnedGraphInventory(env,other.userId),desired=structuredClone(input(snapshot));
  desired.connections[0]!.connection.displayName="Must roll back";
  if(entity==="connection")desired.connections.push({...structuredClone(input(foreign).connections[0]!),selectedSources:[]});
  if(entity==="source")desired.connections[0]!.selectedSources.push({...foreign.value.sources[0]!.source,externalId:"different-site"});
  if(entity==="destination")desired.monitors[0]!.sinks.push({sink:{id:"snk_local",filterSteps:[]},destination:foreign.value.destinations[0]!.destination,destinationConfig:foreign.value.destinations[0]!.config});
  if(entity==="monitor")desired.monitors.push({monitor:{...foreign.value.monitors[0]!,connectionId:own.connection.id},sinks:[]});
  if(entity==="sink")desired.monitors[0]!.sinks.push({sink:foreign.value.sinks[0]!.sink,destination:snapshot.value.destinations[0]!.destination,destinationConfig:snapshot.value.destinations[0]!.config});
  await expect(reconcileOwnedGraph(env,own.userId,snapshot.version,desired)).rejects.toThrow();
  expect(await loadOwnedGraphInventory(env,own.userId)).toEqual(snapshot);expect(await loadOwnedGraphInventory(env,other.userId)).toEqual(foreign);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM configuration_write_guards").first("n")).toBe(0);
});
it("accepts exactly one concurrent writer at the same version",async()=>{
  const own=await fixture(),snapshot=await loadOwnedGraphInventory(env,own.userId),first=structuredClone(input(snapshot)),second=structuredClone(first);first.monitors[0]!.monitor.displayName="First";second.monitors[0]!.monitor.displayName="Second";
  const results=await Promise.allSettled([reconcileOwnedGraph(env,own.userId,snapshot.version,first),reconcileOwnedGraph(env,own.userId,snapshot.version,second)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{name:"ConfigurationConflict"}});
});
it("refuses unresolved connection credentials and invalid versions without writes",async()=>{
  const own=await fixture(),snapshot=await loadOwnedGraphInventory(env,own.userId),desired=structuredClone(input(snapshot));delete desired.connections[0]!.credentials;
  await expect(reconcileOwnedGraph(env,own.userId,snapshot.version,desired)).rejects.toThrow("Resolve connection credentials");
  for(const version of [-1,0.1,NaN,Infinity])await expect(prepareGraphReconciliation(env,own.userId,version,desired)).rejects.toThrow("Invalid configuration version");
  expect(await loadOwnedGraphInventory(env,own.userId)).toEqual(snapshot);
});
