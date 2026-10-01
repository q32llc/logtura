import { describe,it,expect } from "vitest";
import { planDeploymentChanges,type GraphInventory } from "../src/reconcile";
import { fixture } from "./graph-fixture";
const inventory=():GraphInventory=>{
  const input=fixture(),c=input.connections[0]!,m=input.monitors[0]!,s=m.sinks[0]!;
  return {connections:[{connection:structuredClone(c.connection),credentials:structuredClone(c.credentials)}],sources:c.selectedSources.map(source=>({connectionId:c.connection.id,source:structuredClone(source)})),monitors:[structuredClone(m.monitor)],sinks:[{monitorId:m.monitor.id,destinationId:s.destination.id,sink:structuredClone(s.sink)}],destinations:[{destination:structuredClone(s.destination),config:structuredClone(s.destinationConfig)}]};
};
describe("owned graph reconciliation planning",()=>{
  it("plans no storage rewrites for an unchanged graph",()=>{
    const plan=planDeploymentChanges(inventory(),fixture());expect(plan.connections).toEqual([]);expect(plan.sources).toEqual([]);expect(plan.destinations).toEqual([]);expect(plan.monitors).toEqual([]);expect(plan.sinks).toEqual([]);expect(plan.removeSinkIds).toEqual([]);expect(plan.input).toEqual(fixture());expect(plan.selection).toEqual({connections:[{id:"con_original",sourceIds:["src_original"],selectAll:false}],monitorIds:["mon_original"]});
  });
  it("adopts discovered source identities and metadata while preserving the caller's objects",()=>{
    const stored=inventory(),desired=fixture(),before=structuredClone(stored),original=fixture();desired.connections[0]!.selectedSources[0]!.id="src_cli";desired.connections[0]!.selectedSources[0]!.metadata=null;desired.connections[0]!.selectedSources[0]!.displayName="site";
    const plan=planDeploymentChanges(stored,desired);expect(plan.sourceAliases).toEqual({src_cli:"src_original"});expect(plan.input.connections[0]!.selectedSources[0]).toEqual(original.connections[0]!.selectedSources[0]);expect(plan.sources).toEqual([]);expect(stored).toEqual(before);expect(desired.connections[0]!.selectedSources[0]!.id).toBe("src_cli");
    plan.input.connections[0]!.selectedSources[0]!.metadata!.privateField="edited";expect(stored).toEqual(before);expect(original).toEqual(fixture());
  });
  it("plans additions and updates in dependency order, keeping selection order and all-source mode",()=>{
    const stored=inventory(),desired=fixture();desired.connections[0]!.credentials={apiToken:"new-private-token"};desired.connections[0]!.selectAll=true;desired.connections[0]!.selectedSources.push({id:"src_new",externalId:"new-site",displayName:"New",sourceKind:"cf_worker",metadata:null});desired.connections[0]!.selectedSources.reverse();desired.monitors[0]!.monitor.enabled=false;desired.monitors[0]!.sinks[0]!.destinationConfig={url:"new-private-destination"};desired.monitors[0]!.sinks[0]!.sink.filterSteps=[];
    const plan=planDeploymentChanges(stored,desired);expect(plan.connections[0]!.credentials).toEqual({apiToken:"new-private-token"});expect(plan.sources[0]!.source.id).toBe("src_new");expect(plan.destinations[0]!.config).toEqual({url:"new-private-destination"});expect(plan.monitors[0]!.enabled).toBe(false);expect(plan.sinks[0]!.sink.filterSteps).toEqual([]);expect(plan.selection.connections[0]).toEqual({id:"con_original",sourceIds:["src_new","src_original"],selectAll:true});
    expect(planDeploymentChanges({connections:[],sources:[],destinations:[],monitors:[],sinks:[]},desired).connections).toHaveLength(1);expect(planDeploymentChanges({connections:[],sources:[],destinations:[],monitors:[],sinks:[]},desired).sources).toHaveLength(2);
  });
  it("deselects inventory and monitors without deleting shared resources",()=>{
    const desired=fixture();desired.connections[0]!.selectedSources=[];desired.monitors=[];const plan=planDeploymentChanges(inventory(),desired);expect(plan.selection.monitorIds).toEqual([]);expect(plan.selection.connections[0]!.sourceIds).toEqual([]);expect(plan.removeSinkIds).toEqual([]);expect(plan.sources).toEqual([]);expect(plan.monitors).toEqual([]);
    const retained=fixture();retained.monitors[0]!.sinks=[];expect(planDeploymentChanges(inventory(),retained).removeSinkIds).toEqual(["snk_original"]);
  });
  it("handles omitted credentials and reporting and destination metrics",()=>{
    const desired=fixture();delete desired.connections[0]!.credentials;delete desired.heartbeat;delete desired.runtimeEnv;desired.metrics={kind:"destination",destination:{id:"dst_metrics",kind:"datadog_metrics",displayName:"Metrics"},destinationConfig:{apiKey:"private"}};
    const plan=planDeploymentChanges(inventory(),desired);expect(plan.connections[0]!.credentials).toBeUndefined();expect(plan.input).not.toHaveProperty("runtimeEnv");expect(plan.input).not.toHaveProperty("heartbeat");expect(plan.destinations[0]!.destination.id).toBe("dst_metrics");
    const stored=inventory();stored.connections[0]!.credentials=undefined;delete desired.metrics;expect(planDeploymentChanges(stored,desired).connections).toEqual([]);
  });
  it("deduplicates equal shared destinations and rejects contradictory ones",()=>{
    const desired=fixture(),sink=desired.monitors[0]!.sinks[0]!;desired.monitors[0]!.sinks.push({...structuredClone(sink),sink:{id:"snk_second",filterSteps:[]}});desired.metrics={kind:"destination",destination:structuredClone(sink.destination),destinationConfig:structuredClone(sink.destinationConfig)};expect(planDeploymentChanges(inventory(),desired).destinations).toEqual([]);
    desired.monitors[0]!.sinks[1]!.destinationConfig={url:"different"};expect(()=>planDeploymentChanges(inventory(),desired)).toThrow("Conflicting shared destination");
  });
  it.each(["connections","sources","destinations","monitors","sinks"])("rejects duplicate %s inventory rows",field=>{const stored=inventory();(stored[field as keyof GraphInventory] as unknown[]).push((stored[field as keyof GraphInventory] as unknown[])[0]);expect(()=>planDeploymentChanges(stored,fixture())).toThrow("Duplicate inventory identity");});
  it("rejects ambiguous native identities, resource rebinding, moved sinks and broken references",()=>{
    const stored=inventory();stored.sources.push({...structuredClone(stored.sources[0]!),source:{...stored.sources[0]!.source,id:"src_another"}});expect(()=>planDeploymentChanges(stored,fixture())).toThrow("Duplicate inventory identity");
    for(const mutate of [(d:ReturnType<typeof fixture>)=>{d.connections[0]!.connection.provider="different";},(d:ReturnType<typeof fixture>)=>{d.connections[0]!.selectedSources[0]!.externalId="different";},(d:ReturnType<typeof fixture>)=>{d.monitors[0]!.monitor.connectionId="missing";}]){const desired=fixture();mutate(desired);expect(()=>planDeploymentChanges(inventory(),desired)).toThrow();}
    const desired=fixture();desired.monitors.push({monitor:{...desired.monitors[0]!.monitor,id:"mon_other"},sinks:[desired.monitors[0]!.sinks[0]!]});desired.monitors[0]!.sinks=[];expect(()=>planDeploymentChanges(inventory(),desired)).toThrow("Sink ownership");
  });
  it("rejects duplicate canonical selections and graph identities after adoption",()=>{
    const desired=fixture();desired.connections[0]!.selectedSources.push({...structuredClone(desired.connections[0]!.selectedSources[0]!),id:"src_cli"});expect(()=>planDeploymentChanges(inventory(),desired)).toThrow(/Duplicate graph identity|Duplicate source selection|Duplicate .* identity/);
    for(const mutate of [(d:ReturnType<typeof fixture>)=>{d.connections.push(d.connections[0]!);},(d:ReturnType<typeof fixture>)=>{d.monitors.push(d.monitors[0]!);},(d:ReturnType<typeof fixture>)=>{d.monitors[0]!.sinks.push(d.monitors[0]!.sinks[0]!);}]){const d=fixture();mutate(d);expect(()=>planDeploymentChanges(inventory(),d)).toThrow(/Duplicate graph identity|Duplicate source selection|Duplicate .* identity/);}
  });
  it("supports global monitors, new connections without credentials, aliases with explicit labels, and null-prototype alias maps",()=>{
    const desired=fixture();desired.monitors[0]!.monitor.connectionId=null;desired.connections[0]!.selectedSources[0]!.id="__proto__";desired.connections[0]!.selectedSources[0]!.displayName="Explicit";desired.connections[0]!.selectedSources[0]!.metadata={private:"explicit"};const plan=planDeploymentChanges(inventory(),desired);expect(Object.hasOwn(plan.sourceAliases,"__proto__")).toBe(true);expect(plan.sourceAliases.__proto__).toBe("src_original");expect(plan.input.connections[0]!.selectedSources[0]!.displayName).toBe("Explicit");expect(plan.sources[0]!.source.metadata).toEqual({private:"explicit"});
    const fresh=fixture();fresh.connections[0]!.connection.id="con_new";delete fresh.connections[0]!.credentials;fresh.connections[0]!.selectedSources=[];fresh.monitors=[];delete fresh.metrics;expect(planDeploymentChanges(inventory(),fresh).connections[0]!.credentials).toBeUndefined();
  });
});
