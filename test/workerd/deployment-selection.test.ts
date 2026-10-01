import { SELF,env } from "cloudflare:test";
import { expect,it } from "vitest";
import { parseOrderedDeploymentSelection,orderedSelectionFromInput,loadSelectedDeploymentGraph,setOrderedDeploymentSelection,type OrderedDeploymentSelection } from "../../src/deployment-selection";
import { assembleDeploymentBundle } from "../../src/bundle-assembly";
import { createConnection,createDestination,createMonitor,createSink,createDeployment,upsertSources,updateDeployment } from "../../src/db";
import { readConfigurationVersion } from "../../src/config-version";
import { createSecretVersioner,parseDeploymentManifest } from "@logtura/core";
import { reconcileDeploymentConfiguration } from "../../src/deployment-reconciliation";
import { mockFetch,seedUser } from "./_setup";
async function fixture(){
  const {userId,sessionCookie}=await seedUser();
  const cf=await createConnection(env.DB,env,{userId,provider:"cloudflare-worker-tail",displayName:"CF",externalAccountId:"account",credentials:{apiToken:"private-cf"}});
  const fly=await createConnection(env.DB,env,{userId,provider:"fly-log-tail",displayName:"Fly",externalAccountId:"org",credentials:{apiToken:"private-fly"}});
  await upsertSources(env.DB,cf.id,[{sourceKind:"cf_worker",externalId:"first",displayName:"First",metadata:null},{sourceKind:"cf_worker",externalId:"second",displayName:"Second",metadata:null}]);
  await upsertSources(env.DB,fly.id,[{sourceKind:"fly_app",externalId:"app-a",displayName:"A",metadata:null},{sourceKind:"fly_app",externalId:"app-b",displayName:"B",metadata:null}]);
  const sources=(await env.DB.prepare("SELECT * FROM log_sources WHERE connection_id IN (?,?) ORDER BY external_id").bind(cf.id,fly.id).all<{id:string;connection_id:string}>()).results;
  const destination=await createDestination(env.DB,env,{userId,kind:"webhook",displayName:"Alerts",config:{url:"https://owned.test/hook"}});
  const first=await createMonitor(env.DB,{userId,connectionId:cf.id,displayName:"First monitor",filterSteps:[{kind:"errors"}],enabled:true});
  const second=await createMonitor(env.DB,{userId,connectionId:null,displayName:"Disabled global",filterSteps:[],enabled:false});
  const a=await createSink(env.DB,{monitorId:first.id,destinationId:destination.id,filterSteps:[]});
  const b=await createSink(env.DB,{monitorId:first.id,destinationId:destination.id,filterSteps:[{kind:"errors"}]});
  const c=await createSink(env.DB,{monitorId:second.id,destinationId:destination.id,filterSteps:[]});
  const deployment=await createDeployment(env.DB,{userId,connectionId:cf.id,targetKind:"other",displayName:"Ordered",heartbeatTarget:"none"});
  const selection:OrderedDeploymentSelection={schema_version:1,connections:[{id:fly.id,sourceIds:sources.filter(s=>s.connection_id===fly.id).map(s=>s.id).reverse(),selectAll:false},{id:cf.id,sourceIds:sources.filter(s=>s.connection_id===cf.id).map(s=>s.id).reverse()}],monitors:[{id:second.id,sinkIds:[c.id]},{id:first.id,sinkIds:[b.id,a.id]}]};
  mockFetch("https://api.cloudflare.com",()=>Response.json({success:true,result:{status:"active"}}));
  return {userId,sessionCookie,cf,fly,sources,destination,first,second,a,b,c,deployment,selection,version:await readConfigurationVersion(env.DB,userId)};
}
it("persists source, connection, monitor and sink order; website export matches the shared render input",async()=>{
  const f=await fixture(),result=await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,f.selection);
  expect(result.version).toBeGreaterThan(f.version);
  const assembled=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(orderedSelectionFromInput(assembled.input)).toEqual(f.selection);expect(assembled.input.monitors[0]!.monitor.enabled).toBe(false);expect(assembled.input.connections[0]!.selectAll).toBe(false);
  const response=await SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}`,{headers:{cookie:f.sessionCookie}});expect(response.status).toBe(200);const body=await response.json() as any;expect(body.deployment.graphSelection).toEqual(f.selection);expect(body.deployment.sourceIds).toEqual(f.selection.connections.flatMap(c=>c.sourceIds));expect(body.connections.map((c:any)=>c.id)).toEqual(f.selection.connections.map(c=>c.id));
  const exported=await SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}/config`,{headers:{cookie:f.sessionCookie}});expect(exported.status).toBe(200);const document=(await exported.json() as any).document;expect(document.connections.map((c:any)=>c.connection.id)).toEqual(f.selection.connections.map(c=>c.id));expect(document.monitors[1].sinks.map((s:any)=>s.sink.id)).toEqual([f.b.id,f.a.id]);
  expect(JSON.stringify(document)).not.toContain("private-cf");expect(JSON.stringify(document)).not.toContain("private-fly");
  expect((await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,result.version,f.selection)).version).toBe(result.version);
});
it("retains ordered selectors on runtime/no-op edits and lets website flat selector changes take precedence",async()=>{
  const f=await fixture();await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,f.selection);
  await updateDeployment(env.DB,f.userId,f.deployment.id,{displayName:"New name",status:"running"});
  await updateDeployment(env.DB,f.userId,f.deployment.id,{sourceIds:f.selection.connections.flatMap(c=>c.sourceIds),monitorIds:f.selection.monitors.map(m=>m.id)});
  expect((await env.DB.prepare("SELECT graph_selection_json FROM deployments WHERE id=?").bind(f.deployment.id).first<string>("graph_selection_json"))).not.toBeNull();
  const response=await SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}`,{method:"PUT",headers:{cookie:f.sessionCookie,"content-type":"application/json"},body:JSON.stringify({sourceIds:[f.sources.find(s=>s.connection_id===f.cf.id)!.id],monitorIds:[f.first.id]})});expect(response.status).toBe(200);
  expect(JSON.parse((await env.DB.prepare("SELECT graph_selection_json FROM deployments WHERE id=?").bind(f.deployment.id).first<string>("graph_selection_json"))!)).toMatchObject({legacySources:true,legacyMonitors:true});
  const bundle=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(bundle.input.connections).toHaveLength(1);expect(bundle.input.connections[0]!.selectedSources).toHaveLength(1);expect(bundle.input.monitors[0]!.monitor.id).toBe(f.first.id);
});
it("keeps Supabase all-source mode and source-less connections through persistence, rendering and export",async()=>{
  const f=await fixture(),sb=await createConnection(env.DB,env,{userId:f.userId,provider:"supabase-edge-logs",displayName:"Supabase",externalAccountId:"project",credentials:{pat:"sb-private"}});
  const selection:OrderedDeploymentSelection={schema_version:1,connections:[{id:sb.id,sourceIds:[],selectAll:true}],monitors:[]};
  await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),selection);
  const assembled=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(orderedSelectionFromInput(assembled.input)).toEqual(selection);expect(assembled.bundle.vectorYaml).toContain("http_client");expect(assembled.input.connections[0]!.connection.id).toBe(sb.id);
});
it("omits deleted inventory without losing the remaining order or leaking another account's rows",async()=>{
  const f=await fixture(),other=await fixture();await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,f.selection);
  await env.DB.prepare("DELETE FROM log_sources WHERE id=?").bind(f.selection.connections[0]!.sourceIds[0]).run();await env.DB.prepare("DELETE FROM sinks WHERE id=?").bind(f.b.id).run();
  const graph=await loadSelectedDeploymentGraph(env.DB,f.userId,f.selection);expect(graph.connections[0]!.sources.map(s=>s.id)).toEqual(f.selection.connections[0]!.sourceIds.slice(1));expect(graph.monitors[1]!.sinks.map(s=>s.id)).toEqual([f.a.id]);expect(JSON.stringify(graph)).not.toContain(other.userId);
  const missing:OrderedDeploymentSelection={schema_version:1,connections:[{id:other.cf.id,sourceIds:[]}],monitors:[{id:other.first.id,sinkIds:[]}]};expect(await loadSelectedDeploymentGraph(env.DB,f.userId,missing)).toEqual({connections:[],monitors:[]});
  await env.DB.prepare("UPDATE deployments SET graph_selection_json=? WHERE id=?").bind(JSON.stringify(missing),f.deployment.id).run();await expect(assembleDeploymentBundle(env,f.userId,f.deployment.id)).rejects.toThrow("connection not found");
});
it("rejects mismatched parents, unowned/unknown references and incompatible provider selection before writes",async()=>{
  const f=await fixture(),other=await fixture();
  const sourceWrong=structuredClone(f.selection);sourceWrong.connections[0]!.sourceIds=[f.selection.connections[1]!.sourceIds[0]!];sourceWrong.connections[1]!.sourceIds=[];
  await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,sourceWrong)).rejects.toThrow("Source selection parent mismatch");
  const sinkWrong=structuredClone(f.selection);sinkWrong.monitors[0]!.sinkIds=[f.a.id];sinkWrong.monitors[1]!.sinkIds=[f.b.id];await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,sinkWrong)).rejects.toThrow("Sink selection parent mismatch");
  for(const mutate of [(s:OrderedDeploymentSelection)=>{s.connections[0]!.id=other.fly.id;},(s:OrderedDeploymentSelection)=>{s.monitors[0]!.id=other.second.id;},(s:OrderedDeploymentSelection)=>{s.connections[0]!.sourceIds=["missing"];},(s:OrderedDeploymentSelection)=>{s.monitors[0]!.sinkIds=["missing"]; }]){const selection=structuredClone(f.selection);mutate(selection);await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,selection)).rejects.toThrow("missing or unowned inventory");}
  const all=structuredClone(f.selection);all.connections[1]!.selectAll=true;await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,all)).rejects.toThrow("does not support all-source");
  await expect(setOrderedDeploymentSelection(env.DB,other.userId,f.deployment.id,other.version,f.selection)).rejects.toThrow("Deployment not found");
  await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version-1,f.selection)).rejects.toMatchObject({name:"ConfigurationConflict"});expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.version);
});
it("rejects duplicate providers, unknown providers and unselected monitor scopes",async()=>{
  const f=await fixture(),selection=structuredClone(f.selection);selection.connections=[selection.connections[0]!];await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,selection)).rejects.toThrow("unselected connection");
  await env.DB.prepare("UPDATE connections SET provider='cloudflare-worker-tail' WHERE id=?").bind(f.fly.id).run();await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),f.selection)).rejects.toThrow("one connection per provider");
  await env.DB.prepare("UPDATE connections SET provider='unknown' WHERE id=?").bind(f.fly.id).run();await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),f.selection)).rejects.toThrow("Unknown selection provider");
});
it("preserves legacy wildcard discovery and empty-selection behavior",async()=>{
  const f=await fixture();const first=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(first.input.connections[0]!.selectedSources).toHaveLength(2);
  await upsertSources(env.DB,f.cf.id,[{sourceKind:"cf_worker",externalId:"third",displayName:"Third",metadata:null}]);expect((await assembleDeploymentBundle(env,f.userId,f.deployment.id)).input.connections[0]!.selectedSources).toHaveLength(3);
  await updateDeployment(env.DB,f.userId,f.deployment.id,{sourceIds:[],monitorIds:[]});const empty=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(empty.input.connections).toHaveLength(1);expect(empty.input.connections[0]!.selectedSources).toEqual([]);expect(empty.input.monitors).toEqual([]);
});
it.each([null,[],"bad",42,{schema_version:1,connections:[],monitors:[],legacySources:"bad"}, {}, {schema_version:2,connections:[],monitors:[]},{schema_version:1,connections:[],monitors:[]},{schema_version:1,connections:"bad",monitors:[]},{schema_version:1,connections:[{id:"",sourceIds:[]}],monitors:[]},{schema_version:1,connections:[{id:1,sourceIds:[]}],monitors:[]},{schema_version:1,connections:[{id:"con",sourceIds:[],selectAll:"yes"}],monitors:[]},{schema_version:1,connections:[{id:"con",sourceIds:[],unknown:true}],monitors:[]},{schema_version:1,connections:[{id:"con",sourceIds:[]},{id:"con",sourceIds:[]}],monitors:[]},{schema_version:1,connections:[{id:"con",sourceIds:["src","src"]}],monitors:[]},{schema_version:1,connections:[{id:"con",sourceIds:[]}],monitors:[{id:"mon",sinkIds:["sink","sink"]}]},{schema_version:1,connections:[{id:"con",sourceIds:[]}],monitors:[{id:"mon",sinkIds:[]},{id:"mon",sinkIds:[]}]}])("rejects malformed ordered selections %#",value=>{expect(()=>parseOrderedDeploymentSelection(value)).toThrow();});

it("rejects cross-account destinations hidden behind an owned sink and invalid version inputs",async()=>{
  const f=await fixture(),other=await fixture();
  for(const version of [-1,NaN,0.1,Infinity])await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,version,f.selection)).rejects.toThrow("Invalid configuration version");
  await env.DB.prepare("UPDATE sinks SET destination_id=? WHERE id=?").bind(other.destination.id,f.a.id).run();
  await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),f.selection)).rejects.toThrow("missing or unowned inventory");
});
it("fences simultaneous selector writers and marks material selection changes outdated",async()=>{
  const f=await fixture(),other=structuredClone(f.selection);other.connections.reverse();
  await env.DB.prepare("UPDATE deployments SET bundle_outdated=0 WHERE id=?").bind(f.deployment.id).run();
  const results=await Promise.allSettled([f.selection,other].map(selection=>setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,selection)));expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  expect(await env.DB.prepare("SELECT bundle_outdated FROM deployments WHERE id=?").bind(f.deployment.id).first("bundle_outdated")).toBe(1);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM configuration_write_guards").first("n")).toBe(0);
});

it("preserves all-source streaming on website monitor edits, including wildcard monitors",async()=>{
  const f=await fixture(),sb=await createConnection(env.DB,env,{userId:f.userId,provider:"supabase-edge-logs",displayName:"Supabase",externalAccountId:"project",credentials:{pat:"private"}}),selection:OrderedDeploymentSelection={schema_version:1,connections:[{id:sb.id,sourceIds:[],selectAll:true}],monitors:[]};
  await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),selection);
  await updateDeployment(env.DB,f.userId,f.deployment.id,{monitorIds:null});
  const assembled=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(assembled.input.connections[0]!.connection.id).toBe(sb.id);expect(assembled.input.connections[0]!.selectAll).toBe(true);
  const stored=JSON.parse((await env.DB.prepare("SELECT graph_selection_json FROM deployments WHERE id=?").bind(f.deployment.id).first<string>("graph_selection_json"))!);expect(stored.legacyMonitors).toBe(true);expect(stored.legacySources).toBeUndefined();
  for(const flag of ["legacySources","legacyMonitors"] as const)await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),{...selection,[flag]:true})).rejects.toThrow("read-only");
  const parsed=parseOrderedDeploymentSelection({...selection,legacySources:false,legacyMonitors:false});expect(parsed.legacySources).toBe(false);expect(parsed.legacyMonitors).toBe(false);
});
it("preserves monitor/sink ordering when the website changes sources, filtering scopes that no longer apply",async()=>{
  const f=await fixture();await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,f.selection);
  await updateDeployment(env.DB,f.userId,f.deployment.id,{sourceIds:f.selection.connections[1]!.sourceIds});
  const assembled=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(assembled.input.monitors.map(m=>m.monitor.id)).toEqual(f.selection.monitors.map(m=>m.id));expect(assembled.input.monitors[1]!.sinks.map(s=>s.sink.id)).toEqual([f.b.id,f.a.id]);
  await updateDeployment(env.DB,f.userId,f.deployment.id,{sourceIds:f.selection.connections[0]!.sourceIds});expect((await assembleDeploymentBundle(env,f.userId,f.deployment.id)).input.monitors.map(m=>m.monitor.id)).toEqual([f.second.id]);
});

it("round trips legacy future-discovery intent and picks up new sources, monitors and sinks",async()=>{
  const f=await fixture();
  const response=await SELF.fetch(`https://local.test/api/deployments/${f.deployment.id}/config?includeSecrets=1`,{headers:{cookie:f.sessionCookie}});expect(response.status).toBe(200);
  const exported=await response.json() as any;expect(exported.document.connections[0].discoverSources).toBe(true);expect(exported.document.discoverMonitors).toBe(true);
  const desired=parseDeploymentManifest(exported.document,{env:exported.secretValues}).input;
  const result=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,exported.configurationVersion,0,desired,await createSecretVersioner(env.CREDENTIAL_ENCRYPTION_KEY));
  expect(result.document).toEqual(exported.document);
  await upsertSources(env.DB,f.cf.id,[{sourceKind:"cf_worker",externalId:"future",displayName:"Future",metadata:null}]);
  const monitor=await createMonitor(env.DB,{userId:f.userId,connectionId:f.cf.id,displayName:"Future monitor",filterSteps:[],enabled:true});
  const sink=await createSink(env.DB,{monitorId:monitor.id,destinationId:f.destination.id,filterSteps:[]}),added=await createSink(env.DB,{monitorId:f.first.id,destinationId:f.destination.id,filterSteps:[]});
  const assembled=await assembleDeploymentBundle(env,f.userId,f.deployment.id);
  expect(assembled.input.connections[0]!.selectedSources.map(s=>s.externalId)).toContain("future");expect(assembled.input.connections[0]!.discoverSources).toBe(true);expect(assembled.input.discoverMonitors).toBe(true);
  expect(assembled.input.monitors.find(m=>m.monitor.id===monitor.id)!.sinks[0]!.sink.id).toBe(sink.id);expect(assembled.input.monitors.find(m=>m.monitor.id===f.first.id)!.sinks.map(s=>s.sink.id)).toContain(added.id);expect(assembled.input.monitors.some(m=>m.monitor.id===f.second.id)).toBe(false);
});
it("expands only owned discovery catalogs while retaining explicit order and validated parents",async()=>{
  const f=await fixture(),other=await fixture(),selection=structuredClone(f.selection);selection.discoverMonitors=true;selection.connections[1]!.discoverSources=true;
  const extra=await createMonitor(env.DB,{userId:f.userId,connectionId:f.fly.id,displayName:"Extra",filterSteps:[],enabled:true});
  const later=await createMonitor(env.DB,{userId:f.userId,connectionId:f.fly.id,displayName:"Later",filterSteps:[],enabled:true});
  const extraGlobal=await createMonitor(env.DB,{userId:f.userId,connectionId:null,displayName:"Global",filterSteps:[],enabled:true});await env.DB.prepare("UPDATE monitors SET created_at=1 WHERE id IN (?,?)").bind(extra.id,extraGlobal.id).run();
  await upsertSources(env.DB,f.cf.id,[{sourceKind:"cf_worker",externalId:"new-a",displayName:"Identical",metadata:null},{sourceKind:"cf_worker",externalId:"new-b",displayName:"Identical",metadata:null},{sourceKind:"cf_worker",externalId:"new-c",displayName:"Zed",metadata:null},{sourceKind:"other_kind",externalId:"new-d",displayName:"Other",metadata:null}]);
  const version=await readConfigurationVersion(env.DB,f.userId);await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,version,selection);
  const graph=await loadSelectedDeploymentGraph(env.DB,f.userId,selection);expect(graph.connections[1]!.sources.slice(0,2).map(s=>s.id)).toEqual(selection.connections[1]!.sourceIds);expect(graph.connections[1]!.sources).toHaveLength(6);expect(graph.monitors.map(m=>m.monitor.id)).toEqual([f.second.id,f.first.id,...[extra.id,extraGlobal.id].sort(),later.id]);expect(JSON.stringify(graph)).not.toContain(other.userId);
  const bad=structuredClone(selection);bad.monitors.push({id:"missing",sinkIds:[]});await expect(setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),bad)).rejects.toThrow("missing or unowned");
  for(const change of [(s:any)=>s.discoverMonitors=1,(s:any)=>s.connections[0].discoverSources="yes",(s:any)=>{s.connections[0].discoverSources=true;s.connections[0].selectAll=true;}]){const invalid=structuredClone(selection);change(invalid);expect(()=>parseOrderedDeploymentSelection(invalid)).toThrow();}
});

it("keeps monitor discovery scoped to effective connections after a website source-only override",async()=>{
  const f=await fixture(),selected={schema_version:1 as const,connections:[{id:f.cf.id,sourceIds:f.sources.filter(s=>s.connection_id===f.cf.id).map(s=>s.id),discoverSources:true}],monitors:[{id:f.first.id,sinkIds:[f.a.id,f.b.id]}],discoverMonitors:true};
  await setOrderedDeploymentSelection(env.DB,f.userId,f.deployment.id,f.version,selected);
  const flyMonitor=await createMonitor(env.DB,{userId:f.userId,connectionId:f.fly.id,displayName:"Fly monitor",filterSteps:[],enabled:true});await createSink(env.DB,{monitorId:flyMonitor.id,destinationId:f.destination.id,filterSteps:[]});
  await updateDeployment(env.DB,f.userId,f.deployment.id,{sourceIds:f.sources.filter(s=>s.connection_id===f.fly.id).map(s=>s.id)});
  const assembled=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(assembled.input.connections[0]!.connection.id).toBe(f.fly.id);expect(assembled.input.connections[0]!.discoverSources).toBeUndefined();expect(assembled.input.discoverMonitors).toBe(true);expect(assembled.input.monitors.map(m=>m.monitor.id)).toEqual([flyMonitor.id]);
});
