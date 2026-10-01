import { expect,it } from "vitest";
import { createSecretVersioner,exportDeploymentManifest,parseDeploymentManifest } from "../src/manifest";
import { editDeploymentManifest,diffDeploymentManifests } from "../src/graph";
import { resolveDeploymentDiscovery,planDeploymentChanges,type GraphInventory } from "../src/reconcile";
import { fixture } from "./graph-fixture";
function inventory():GraphInventory{
  const f=fixture(),c=f.connections[0]!,m=f.monitors[0]!,s=m.sinks[0]!;
  return {connections:[{connection:c.connection,credentials:c.credentials}],sources:c.selectedSources.map(source=>({connectionId:c.connection.id,source})),monitors:[m.monitor],sinks:[{sink:s.sink,monitorId:m.monitor.id,destinationId:s.destination.id}],destinations:[{destination:s.destination,config:s.destinationConfig}]};
}
it("preserves discovery policy through export, parse, no-op edits and value-free diffs",async()=>{
  const input=fixture();input.connections[0]!.discoverSources=true;input.discoverMonitors=true;
  const versioner=await createSecretVersioner("private"),exported=await exportDeploymentManifest(input,versioner);expect(parseDeploymentManifest(exported.document,{env:exported.secretValues,providers:input.providers,destinations:input.destinations}).input).toEqual(input);
  expect(await editDeploymentManifest(exported.document,exported.secretValues,[],versioner)).toEqual(exported);
  const frozen=await editDeploymentManifest(exported.document,exported.secretValues,[{kind:"connection.update",id:"con_original",patch:{},discoverSources:false},{kind:"selection.update",discoverMonitors:false}],versioner);
  expect((await diffDeploymentManifests(exported.document,frozen.document)).changes).toEqual([{entity:"connection",id:"con_original",operation:"update",fields:["discoverSources"]},{entity:"reporting",id:"reporting",operation:"update",fields:["discoverMonitors"]}]);
  const added=await editDeploymentManifest(frozen.document,frozen.secretValues,[{kind:"connection.add",connection:{id:"other",provider:"cloudflare-worker-tail",displayName:"Other",externalAccountId:null},discoverSources:true},{kind:"selection.update",discoverMonitors:true}],versioner);expect(added.document.connections[1]!.discoverSources).toBe(true);
});
it.each(["source","monitor","sink"])("freezes the relevant discovery policy when an explicit %s is removed",async entity=>{
  const input=fixture();input.connections[0]!.discoverSources=true;input.discoverMonitors=true;
  if(entity==="source")input.connections.push({connection:{id:"other",provider:"fly-log-tail",displayName:"Other",externalAccountId:null},selectedSources:[],discoverSources:true});
  const versioner=await createSecretVersioner("private"),exported=await exportDeploymentManifest(input,versioner);
  const edit=entity==="source"?{kind:"source.remove" as const,id:"src_original"}:entity==="monitor"?{kind:"monitor.remove" as const,id:"mon_original"}:{kind:"sink.remove" as const,id:"snk_original"};
  const result=await editDeploymentManifest(exported.document,exported.secretValues,[edit],versioner);
  if(entity==="source"){expect(result.document.connections[0]!.discoverSources).toBe(false);expect(result.document.discoverMonitors).toBe(true);}else{expect(result.document.discoverMonitors).toBe(false);expect(result.document.connections[0]!.discoverSources).toBe(true);}
});
it("rejects malformed flags and ambiguous native-all/discovery modes",async()=>{
  const versioner=await createSecretVersioner("private"),exported=await exportDeploymentManifest(fixture(),versioner);
  for(const change of [(d:any)=>d.discoverMonitors="yes",(d:any)=>d.connections[0].discoverSources=1,(d:any)=>{d.connections[0].discoverSources=true;d.connections[0].selectAll=true;}]){const doc=structuredClone(exported.document);change(doc);expect(()=>parseDeploymentManifest(doc)).toThrow();}
});
it("materializes future owned sources, enabled applicable monitors and sinks without freezing the policy",()=>{
  const stored=inventory(),input=fixture();input.connections[0]!.discoverSources=true;input.discoverMonitors=true;
  stored.sources.push({connectionId:"foreign",source:{...stored.sources[0]!.source,id:"foreign-source",externalId:"foreign"}},{connectionId:"con_original",source:{...stored.sources[0]!.source,id:"new-source",externalId:"new"}},{connectionId:"con_original",source:{...stored.sources[0]!.source,id:"alias-source"}});
  const base=stored.monitors[0]!;stored.monitors.push({...base,id:"global",connectionId:null},{...base,id:"new-monitor"},{...base,id:"disabled",enabled:false},{...base,id:"foreign",connectionId:"foreign"});stored.sinks.push({...stored.sinks[0]!,sink:{id:"new-sink",filterSteps:[]}});
  const original=structuredClone(stored),snapshot={...input,connections:structuredClone(input.connections),monitors:structuredClone(input.monitors)},resolved=resolveDeploymentDiscovery(stored,input);
  expect(resolved.connections[0]!.selectedSources.map(s=>s.id)).toEqual(["src_original","new-source"]);expect(resolved.monitors.map(m=>m.monitor.id)).toEqual(["mon_original","global","new-monitor"]);expect(resolved.monitors[0]!.sinks.map(s=>s.sink.id)).toEqual(["snk_original","new-sink"]);expect(resolved.discoverMonitors).toBe(true);expect(stored).toEqual(original);expect(input).toEqual(snapshot);
  stored.sources.pop();stored.sources.push({connectionId:"con_original",source:{...stored.sources[0]!.source,id:"new-kind",externalId:"other",sourceKind:"other_kind"}});const plan=planDeploymentChanges(stored,input);expect(plan.removeSinkIds).toEqual([]);expect(plan.selection).toMatchObject({discoverMonitors:true,connections:[{discoverSources:true}]});expect(plan.sources).toEqual([]);expect(plan.monitors).toEqual([]);expect(plan.sinks).toEqual([]);
  const explicit=fixture();expect(resolveDeploymentDiscovery(stored,explicit)).toEqual(explicit);
  const empty=fixture();empty.monitors=[];empty.discoverMonitors=true;expect(resolveDeploymentDiscovery(stored,empty).monitors[0]!.sinks).toHaveLength(2);
  stored.destinations=[];expect(()=>resolveDeploymentDiscovery(stored,empty)).toThrow("missing destination");
});
