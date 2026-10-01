import { validateDeploymentInput } from "./manifest";
import { canonicalConfigJson } from "./json";
import type { Connection, Destination, GenerateInput, Monitor, Sink, Source } from "./types";

export interface StoredConnection {connection:Connection;credentials?:Record<string,unknown>;}
export interface StoredSource {source:Source;connectionId:string;}
export interface StoredDestination {destination:Destination;config:unknown;}
export interface StoredSink {sink:Sink;monitorId:string;destinationId:string;}
export interface GraphInventory {connections:StoredConnection[];sources:StoredSource[];destinations:StoredDestination[];monitors:Monitor[];sinks:StoredSink[];}
export interface DeploymentChangePlan {
  /** Canonical source IDs adopt an already discovered inventory identity. */
  input:GenerateInput;
  sourceAliases:Record<string,string>;
  connections:StoredConnection[];sources:StoredSource[];destinations:StoredDestination[];monitors:Monitor[];sinks:StoredSink[];
  /** Only edges of retained monitors are removed. Deselection never deletes
   * source/connection/destination inventory or a shared monitor. */
  removeSinkIds:string[];
  selection:{connections:Array<{id:string;sourceIds:string[];selectAll:boolean;discoverSources?:boolean}>;discoverMonitors?:boolean;monitorIds:string[]};
}
function jsonClone<T>(value:T):T{return JSON.parse(canonicalConfigJson(value)) as T;}
function connectionValue(c:StoredConnection){return {connection:c.connection,credentials:c.credentials??null};}
function index<T>(values:T[],id:(value:T)=>string){const result=new Map<string,T>();for(const value of values){const key=id(value);if(result.has(key))throw new Error("Duplicate inventory identity");result.set(key,value);}return result;}
function equal(a:unknown,b:unknown):boolean{return canonicalConfigJson(a)===canonicalConfigJson(b);}

/** Pure storage reconciliation shared by service and standalone adapters. The
 * caller supplies an owned inventory and validates permissions before execution.
 * Plans include private values and must not be logged or returned as a diff. */
export function planDeploymentChanges(inventory:GraphInventory,desired:GenerateInput):DeploymentChangePlan{
  validateDeploymentInput(desired);
  desired=resolveDeploymentDiscovery(inventory,desired);
  validateDeploymentInput(desired);
  const existingConnections=index(inventory.connections,c=>c.connection.id),existingSources=index(inventory.sources,s=>s.source.id),existingDestinations=index(inventory.destinations,d=>d.destination.id),existingMonitors=index(inventory.monitors,m=>m.id),existingSinks=index(inventory.sinks,s=>s.sink.id);
  const sourceKey=(s:StoredSource)=>canonicalConfigJson([s.connectionId,s.source.sourceKind,s.source.externalId]);
  const byNativeKey=index(inventory.sources,sourceKey);
  const plan:DeploymentChangePlan={input:{providers:[...desired.providers],destinations:[...desired.destinations],connections:[],monitors:[],...(desired.discoverMonitors===undefined?{}:{discoverMonitors:desired.discoverMonitors}),...(desired.heartbeat===undefined?{}:{heartbeat:jsonClone(desired.heartbeat)}),...(desired.metrics===undefined?{}:{metrics:jsonClone(desired.metrics)}),...(desired.runtimeEnv===undefined?{}:{runtimeEnv:jsonClone(desired.runtimeEnv)})},sourceAliases:Object.create(null) as Record<string,string>,connections:[],sources:[],destinations:[],monitors:[],sinks:[],removeSinkIds:[],selection:{connections:[],monitorIds:[],...(desired.discoverMonitors===undefined?{}:{discoverMonitors:desired.discoverMonitors})}};
  const incomingNativeKeys=new Set<string>(),incomingMonitors=new Set<string>(),incomingSinks=new Set<string>(),incomingDestinations=new Map<string,StoredDestination>();
  const destination=(value:StoredDestination)=>{
    const prior=incomingDestinations.get(value.destination.id);if(prior && !equal(prior,value))throw new Error("Conflicting shared destination configuration");
    if(!prior){incomingDestinations.set(value.destination.id,value);const stored=existingDestinations.get(value.destination.id);if(!stored || !equal(stored,value))plan.destinations.push(value);}
  };
  for(const c of desired.connections){
    const value:StoredConnection={connection:jsonClone(c.connection),...(c.credentials===undefined?{}:{credentials:jsonClone(c.credentials)})};const stored=existingConnections.get(c.connection.id);
    if(stored && stored.connection.provider!==value.connection.provider)throw new Error("Connection provider is immutable; create a new connection");
    if(!stored || !equal(connectionValue(stored),connectionValue(value)))plan.connections.push(value);
    const selected:Source[]=[];
    for(const source of c.selectedSources){
      let row:StoredSource={connectionId:c.connection.id,source:jsonClone(source)};const exact=existingSources.get(source.id),native=byNativeKey.get(sourceKey(row));
      if(exact && (exact.connectionId!==row.connectionId || exact.source.sourceKind!==source.sourceKind || exact.source.externalId!==source.externalId))throw new Error("Source identity cannot be rebound to another provider resource");
      if(native && native.source.id!==source.id){plan.sourceAliases[source.id]=native.source.id;row.source.id=native.source.id;row.source.metadata=source.metadata??jsonClone(native.source.metadata);if(source.displayName===source.externalId)row.source.displayName=native.source.displayName;}
      const nativeKey=sourceKey(row);if(incomingNativeKeys.has(nativeKey))throw new Error("Duplicate source selection");incomingNativeKeys.add(nativeKey);
      const current=existingSources.get(row.source.id);if(!current || !equal(current,row))plan.sources.push(row);selected.push(row.source);
    }
    plan.input.connections.push({...value,selectedSources:selected,...(c.selectAll===undefined?{}:{selectAll:c.selectAll}),...(c.discoverSources===undefined?{}:{discoverSources:c.discoverSources})});plan.selection.connections.push({id:c.connection.id,sourceIds:selected.map(s=>s.id),selectAll:c.selectAll??false,...(c.discoverSources===undefined?{}:{discoverSources:c.discoverSources})});
  }
  for(const m of desired.monitors){
    incomingMonitors.add(m.monitor.id);const monitor=jsonClone(m.monitor);
    const stored=existingMonitors.get(monitor.id);if(!stored || !equal(stored,monitor))plan.monitors.push(monitor);
    const sinks:GenerateInput["monitors"][number]["sinks"]=[];
    for(const s of m.sinks){
      incomingSinks.add(s.sink.id);const value:StoredSink={sink:jsonClone(s.sink),monitorId:monitor.id,destinationId:s.destination.id};const current=existingSinks.get(value.sink.id);
      if(current && current.monitorId!==monitor.id)throw new Error("Sink ownership within the graph is immutable");
      if(!current || !equal(current,value))plan.sinks.push(value);
      const d={destination:jsonClone(s.destination),config:jsonClone(s.destinationConfig)};destination(d);sinks.push({sink:value.sink,destination:d.destination,destinationConfig:d.config});
    }
    plan.input.monitors.push({monitor,sinks});plan.selection.monitorIds.push(monitor.id);
  }
  if(plan.input.metrics?.kind==="destination")destination({destination:plan.input.metrics.destination,config:plan.input.metrics.destinationConfig});
  plan.removeSinkIds=inventory.sinks.filter(s=>incomingMonitors.has(s.monitorId) && !incomingSinks.has(s.sink.id)).map(s=>s.sink.id).sort();
  return plan;
}

/** Materialize discovery intent against a caller-owned inventory. Standalone
 * adapters supply their own catalog; no service, network or global registry is
 * needed. Explicit snapshots preserve order; newly discovered rows append in
 * inventory order. Keep policy flags so a later refresh can discover additions. */
export function resolveDeploymentDiscovery(inventory:GraphInventory,input:GenerateInput):GenerateInput{
  const connections=input.connections.map(c=>({...c,selectedSources:[...c.selectedSources,...(c.discoverSources?inventory.sources.filter(s=>s.connectionId===c.connection.id && !c.selectedSources.some(known=>known.sourceKind===s.source.sourceKind && known.externalId===s.source.externalId)).map(s=>jsonClone(s.source)):[])]}));
  let monitors=input.monitors.map(m=>({...m,sinks:[...m.sinks]}));
  if(input.discoverMonitors){
    const applicable=inventory.monitors.filter(m=>m.enabled && (m.connectionId===null || connections.some(c=>c.connection.id===m.connectionId)));
    for(const m of applicable){
      let selected=monitors.find(existing=>existing.monitor.id===m.id);
      if(!selected){selected={monitor:jsonClone(m),sinks:[]};monitors.push(selected);}
      for(const s of inventory.sinks.filter(s=>s.monitorId===m.id && !selected!.sinks.some(known=>known.sink.id===s.sink.id))){
        const d=inventory.destinations.find(d=>d.destination.id===s.destinationId);
        if(!d)throw new Error("Discovered sink references a missing destination");
        selected.sinks.push({sink:jsonClone(s.sink),destination:jsonClone(d.destination),destinationConfig:jsonClone(d.config)});
      }
    }
  }
  return {...input,connections,monitors};
}
