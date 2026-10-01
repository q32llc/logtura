import { describe,it,expect,vi } from "vitest";
import { createSecretVersioner, exportDeploymentManifest, parseDeploymentManifest } from "../src/manifest";
import { diffDeploymentManifests, editDeploymentManifest, type ManifestEdit } from "../src/graph";
import { hashConfigDocument } from "../src/config";
import { fixture } from "./graph-fixture";
const versioner=()=>createSecretVersioner("edit-private-key");
async function base(){return exportDeploymentManifest(fixture(),await createSecretVersioner("export-private-key"));}
async function apply(edits:ManifestEdit[]){const original=await base();return editDeploymentManifest(original.document,original.secretValues,edits,await versioner());}
const newSource={id:"src_new",externalId:"new-site",displayName:"New site",sourceKind:"cf_worker",metadata:{key:"new-private-metadata"}};
const newConnection={id:"con_new",provider:"custom-vector",displayName:"New",externalAccountId:null};
const newMonitor={id:"mon_new",connectionId:"con_original",displayName:"New monitor",enabled:false,filterSteps:[]};
const newSink={id:"snk_new",filterSteps:[]};const newDestination={id:"dst_new",kind:"webhook",displayName:"New destination"};
describe("portable graph edit transactions",()=>{
  it("preserves all existing versions and identities for no-op or public-only edits",async()=>{
    const original=await base(),copy=structuredClone(original),sign=vi.fn(async()=>"new");
    expect(await editDeploymentManifest(original.document,original.secretValues,[],sign)).toEqual(original);expect(sign).not.toHaveBeenCalled();
    const updated=await editDeploymentManifest(original.document,original.secretValues,[{kind:"connection.update",id:"con_original",patch:{displayName:"Renamed account"}},{kind:"source.add",connectionId:"con_original",source:{...newSource,metadata:null}},{kind:"source.update",id:"src_original",patch:{displayName:"Renamed"}}],sign);
    expect(updated.document.connections[0]!.credentials).toEqual(original.document.connections[0]!.credentials);expect(updated.document.connections[0]!.selectedSources[0]!.metadata).toEqual(original.document.connections[0]!.selectedSources[0]!.metadata);expect(sign).not.toHaveBeenCalled();expect(original).toEqual(copy);
    expect(updated.document.connections[0]!.selectedSources.map(s=>s.id)).toEqual(["src_original","src_new"]);
  });
  it("changes only changed secret versions and keeps new values private",async()=>{
    const original=await base();const result=await editDeploymentManifest(original.document,original.secretValues,[{kind:"connection.update",id:"con_original",patch:{displayName:"Renamed"},credentials:{apiToken:"new-token"},selectAll:true},{kind:"source.update",id:"src_original",patch:{metadata:{private:"new-metadata"}}}],await versioner());
    expect(result.document.connections[0]!.credentials).not.toEqual(original.document.connections[0]!.credentials);expect(result.document.connections[0]!.selectedSources[0]!.metadata).not.toEqual(original.document.connections[0]!.selectedSources[0]!.metadata);
    expect(result.document.monitors).toEqual(original.document.monitors);expect(JSON.stringify(result.document)).not.toContain("new-token");expect(JSON.stringify(result.document)).not.toContain("new-metadata");expect(parseDeploymentManifest(result.document,{env:result.secretValues}).input.connections[0]!.credentials!.apiToken).toBe("new-token");
    const same=await editDeploymentManifest(result.document,result.secretValues,[{kind:"connection.update",id:"con_original",patch:{},credentials:{apiToken:"new-token"}}],async()=>{throw new Error("unchanged payload must not be signed");});expect(same).toEqual(result);
    expect(await hashConfigDocument(result.document)).not.toBe(await hashConfigDocument(original.document));
  });
  it("adds and removes connections, sources, monitors and sinks in ordered transactions",async()=>{
    const result=await apply([{kind:"connection.add",connection:newConnection,credentials:{key:"private"},selectAll:false},{kind:"source.add",connectionId:"con_new",source:newSource},{kind:"monitor.add",monitor:newMonitor},{kind:"sink.add",monitorId:"mon_new",sink:newSink,destination:newDestination,destinationConfig:{url:"new-secret-url"}},{kind:"sink.update",id:"snk_new",patch:{filterSteps:[{kind:"errors"}]}},{kind:"monitor.update",id:"mon_new",patch:{connectionId:"con_new",enabled:true,displayName:"Renamed",filterSteps:[{kind:"errors"}]}}]);
    const input=parseDeploymentManifest(result.document,{env:result.secretValues}).input;expect(input.connections[1]!.selectedSources[0]).toEqual(newSource);expect(input.monitors[1]!.sinks[0]!.destinationConfig).toEqual({url:"new-secret-url"});expect(input.monitors[1]!.monitor.enabled).toBe(true);
    const removed=await editDeploymentManifest(result.document,result.secretValues,[{kind:"sink.remove",id:"snk_new"},{kind:"monitor.remove",id:"mon_new"},{kind:"source.remove",id:"src_new"},{kind:"connection.remove",id:"con_new"}],await versioner());expect(removed).toEqual(await base());
    const fresh=await apply([{kind:"connection.add",connection:newConnection}]);expect(fresh.document.connections[1]!.credentials).toBeNull();
  });
  it("updates shared destinations in every sink and in destination metrics",async()=>{
    const original=await base();const destination=original.document.monitors[0]!.sinks[0]!.destination;
    const result=await editDeploymentManifest(original.document,original.secretValues,[{kind:"sink.add",monitorId:"mon_original",sink:newSink,destination,destinationConfig:{url:"original"}},{kind:"reporting.update",metrics:{kind:"destination",destination,destinationConfig:{url:"metrics-old"}}},{kind:"destination.update",id:destination.id,patch:{displayName:"Changed"},destinationConfig:{url:"new-private-destination"}}],await versioner());
    const input=parseDeploymentManifest(result.document,{env:result.secretValues}).input;expect(input.monitors[0]!.sinks.every(s=>s.destination.displayName==="Changed")).toBe(true);expect(input.monitors[0]!.sinks.every(s=>(s.destinationConfig as any).url==="new-private-destination")).toBe(true);expect(input.metrics).toMatchObject({kind:"destination",destination:{displayName:"Changed"},destinationConfig:{url:"new-private-destination"}});
    const unchanged=await editDeploymentManifest(result.document,result.secretValues,[{kind:"destination.update",id:destination.id,patch:{}}],await versioner());expect(unchanged).toEqual(result);
    const metricsOnly=await apply([{kind:"reporting.update",metrics:{kind:"destination",destination:newDestination,destinationConfig:{url:"metrics"}}},{kind:"destination.update",id:"dst_new",patch:{displayName:"Metrics only"}}]);expect(metricsOnly.document.metrics).toMatchObject({destination:{displayName:"Metrics only"}});
    const sinkOnly=await apply([{kind:"destination.update",id:destination.id,patch:{displayName:"Sink only"}}]);expect(sinkOnly.document.monitors[0]!.sinks[0]!.destination.displayName).toBe("Sink only");
  });
  it("updates reporting independently and supports complete standalone reporting opt-out",async()=>{
    const result=await apply([{kind:"reporting.update",heartbeat:{kind:"none",appUrl:"https://unused.test",deploymentId:"dep_original"},metrics:{kind:"none"},runtimeEnv:{}}]);expect(result.document.heartbeat!.kind).toBe("none");expect(result.document.metrics!.kind).toBe("none");expect(parseDeploymentManifest(result.document,{env:result.secretValues}).input.runtimeEnv).toEqual({});
    expect(await editDeploymentManifest(result.document,result.secretValues,[{kind:"reporting.update"}],await versioner())).toEqual(result);
    const global=await apply([{kind:"monitor.update",id:"mon_original",patch:{connectionId:null}},{kind:"connection.remove",id:"con_original"}]);expect(global.document.connections).toEqual([]);
  });
  it("does not mutate newly supplied operation entities",async()=>{
    const edits:ManifestEdit[]=[{kind:"source.add",connectionId:"con_original",source:newSource},{kind:"source.update",id:newSource.id,patch:{displayName:"Renamed"}}],copy=structuredClone(edits);await apply(edits);expect(edits).toEqual(copy);
  });
  it.each(["connection","source","monitor","sink","destination"])("rejects missing %s entities",async entity=>{await expect(apply([{kind:`${entity}.update`,id:"missing",patch:{}} as ManifestEdit])).rejects.toThrow("not found");});
  it.each(["connection","source","monitor","sink"])("rejects missing %s removals",async entity=>{await expect(apply([{kind:`${entity}.remove`,id:"missing"} as ManifestEdit])).rejects.toThrow("not found");});
  it.each([
    null,{},"bad",{kind:"constructor"},{kind:"unknown"},{kind:"source.remove",id:"src_original",secret:"private"},{kind:"source.update",id:"src_original",patch:{id:"replacement"}},
    {kind:"connection.add",connection:{...newConnection,extra:"secret"}},{kind:"monitor.add",monitor:{...newMonitor,extra:"secret"}},{kind:"sink.add",monitorId:"mon_original",sink:{...newSink,extra:1},destination:newDestination,destinationConfig:{}},
    {kind:"sink.add",monitorId:"mon_original",sink:newSink,destination:{...newDestination,extra:1},destinationConfig:{}},{kind:"source.add",connectionId:"con_original",source:{...newSource,extra:1}},
    {kind:"source.update",id:"src_original",patch:null},{kind:"source.update",id:"src_original",patch:[]},
    {kind:"source.update",id:"src_original",patch:{metadata:["invalid"]}}, {kind:"connection.update",id:"con_original",patch:{},credentials:[]}, {kind:"reporting.update",runtimeEnv:{INVALID:12}},
  ])("rejects unknown operation fields or immutable identity changes (%#)",async edit=>{await expect(apply([edit as any])).rejects.toThrow();});
  it("rejects missing secrets, duplicate selections, duplicate identities and broken references without mutation",async()=>{
    const original=await base();await expect(editDeploymentManifest(original.document,{},[],await versioner())).rejects.toThrow("secret");await expect(editDeploymentManifest(original.document,original.secretValues,null as any,await versioner())).rejects.toThrow("array");
    await expect(apply([{kind:"source.add",connectionId:"con_original",source:{...newSource,externalId:"site"}}])).rejects.toThrow("Duplicate source selection");await expect(apply([{kind:"source.add",connectionId:"con_original",source:{...newSource,id:"src_original"}}])).rejects.toThrow(/Duplicate source identity|Conflicting secret payload/);await expect(apply([{kind:"connection.remove",id:"con_original"}])).rejects.toThrow("unknown connection");
    const copy=structuredClone(original);await expect(editDeploymentManifest(original.document,original.secretValues,[{kind:"source.add",connectionId:"con_original",source:newSource}],async()=>{throw new Error("signing unavailable");})).rejects.toThrow("signing unavailable");expect(original).toEqual(copy);
    const ref=original.document.connections[0]!.credentials!;original.document.runtimeEnv={env:ref.env,version:"different"};await expect(editDeploymentManifest(original.document,original.secretValues,[],await versioner())).rejects.toThrow("Conflicting secret reference versions");
  });
});
describe("redacted graph diffs",()=>{
  it("reports changes by stable identity and field names without including any values",async()=>{
    const original=await base();const changed=await editDeploymentManifest(original.document,original.secretValues,[{kind:"connection.update",id:"con_original",patch:{displayName:"secret-label"},credentials:{apiToken:"secret-token"}},{kind:"source.add",connectionId:"con_original",source:newSource},{kind:"source.remove",id:"src_original"},{kind:"monitor.update",id:"mon_original",patch:{filterSteps:[{kind:"match",pattern:"secret-pattern",mode:"include"}]}},{kind:"sink.remove",id:"snk_original"},{kind:"reporting.update",metrics:{kind:"none"}}],await versioner());
    const diff=await diffDeploymentManifests(original.document,changed.document);expect(diff.changes).toContainEqual({entity:"connection",id:"con_original",operation:"update",fields:["credentials","displayName"]});expect(diff.changes).toContainEqual({entity:"source",id:"src_new",operation:"add",fields:["connectionId","displayName","externalId","metadata","order","sourceKind"]});expect(diff.changes).toContainEqual({entity:"source",id:"src_original",operation:"remove",fields:["connectionId","displayName","externalId","metadata","order","sourceKind"]});expect(diff.changes).toContainEqual({entity:"monitor",id:"mon_original",operation:"update",fields:["filterSteps"]});expect(diff.changes).toContainEqual({entity:"reporting",id:"reporting",operation:"update",fields:["metrics"]});
    const text=JSON.stringify(diff);for(const value of ["secret-label","secret-token","secret-pattern","new-private-metadata","metadata-secret","destination-secret"])expect(text).not.toContain(value);expect(diff.beforeRevision).not.toBe(diff.afterRevision);
    expect(await diffDeploymentManifests(original.document,original.document)).toEqual({beforeRevision:await hashConfigDocument(original.document),afterRevision:await hashConfigDocument(original.document),changes:[]});
  });
  it("detects entity order changes and nullable reporting fields",async()=>{
    const populated=await apply([{kind:"connection.add",connection:newConnection},{kind:"source.add",connectionId:"con_original",source:newSource},{kind:"monitor.add",monitor:newMonitor},{kind:"sink.add",monitorId:"mon_original",sink:newSink,destination:newDestination,destinationConfig:{}}]);const changed=structuredClone(populated.document);changed.connections.reverse();changed.connections[1]!.selectedSources.reverse();changed.monitors.reverse();changed.monitors[1]!.sinks.reverse();delete changed.heartbeat;delete changed.metrics;
    const diff=await diffDeploymentManifests(populated.document,changed);expect(diff.changes.filter(c=>c.fields.includes("order"))).toHaveLength(8);expect(diff.changes.find(c=>c.entity==="reporting")!.fields).toEqual(["heartbeat","metrics"]);
    const deleted=structuredClone(populated.document);deleted.connections[0]!.selectAll=false;const change=await diffDeploymentManifests(populated.document,deleted);expect(change.changes[0]!.fields).toContain("selectAll");
    const empty=structuredClone(populated.document);empty.monitors=[];expect((await diffDeploymentManifests(empty,populated.document)).changes.some(c=>c.entity==="monitor" && c.operation==="add")).toBe(true);
  });
});
