import { canonicalConfigJson, hashConfigDocument } from "./config";
import { exportDeploymentManifest, normalizeDeploymentManifest, parseDeploymentManifest, type DeploymentManifest, type SecretVersioner } from "./manifest";
import type { Connection, Destination, GenerateInput, Monitor, Sink, Source } from "./types";

export type ManifestEdit =
  | {kind:"connection.add";connection:Connection;credentials?:Record<string,unknown>;selectAll?:boolean;discoverSources?:boolean}
  | {kind:"connection.update";id:string;patch:Partial<Omit<Connection,"id">>;credentials?:Record<string,unknown>;selectAll?:boolean;discoverSources?:boolean}
  | {kind:"selection.update";discoverMonitors:boolean}
  | {kind:"connection.remove";id:string}
  | {kind:"source.add";connectionId:string;source:Source}
  | {kind:"source.update";id:string;patch:Partial<Omit<Source,"id">>}
  | {kind:"source.remove";id:string}
  | {kind:"monitor.add";monitor:Monitor}
  | {kind:"monitor.update";id:string;patch:Partial<Omit<Monitor,"id">>}
  | {kind:"monitor.remove";id:string}
  | {kind:"sink.add";monitorId:string;sink:Sink;destination:Destination;destinationConfig:unknown}
  | {kind:"sink.update";id:string;patch:Partial<Omit<Sink,"id">>}
  | {kind:"sink.remove";id:string}
  | {kind:"destination.update";id:string;patch:Partial<Omit<Destination,"id">>;destinationConfig?:unknown}
  | {kind:"reporting.update";heartbeat?:GenerateInput["heartbeat"];metrics?:GenerateInput["metrics"];runtimeEnv?:Record<string,string>};

function requireFound<T>(value:T|undefined):T {if(value===undefined)throw new Error("Graph entity not found");return value;}
function fields(value:unknown,allowed:string[]):void{
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key)))throw new Error("Unsupported graph edit fields");
}
const editFields:Record<ManifestEdit["kind"],string[]>={
  "connection.add":["connection","credentials","selectAll","discoverSources"],"connection.update":["id","patch","credentials","selectAll","discoverSources"],"connection.remove":["id"],"selection.update":["discoverMonitors"],
  "source.add":["connectionId","source"],"source.update":["id","patch"],"source.remove":["id"],
  "monitor.add":["monitor"],"monitor.update":["id","patch"],"monitor.remove":["id"],
  "sink.add":["monitorId","sink","destination","destinationConfig"],"sink.update":["id","patch"],"sink.remove":["id"],
  "destination.update":["id","patch","destinationConfig"],"reporting.update":["heartbeat","metrics","runtimeEnv"],
};
function patch<T extends object>(entity:T,value:unknown,allowed:string[]):void{fields(value,allowed);Object.assign(entity,value);}

/** Apply an ordered edit transaction to a portable graph. No I/O or mutation of
 * caller objects. Private JSON payloads remain in the separate secret map.
 * Unchanged payloads keep their existing opaque versions, even across runtimes. */
export async function editDeploymentManifest(document:DeploymentManifest,secretValues:Record<string,string>,edits:ManifestEdit[],versioner:SecretVersioner):Promise<{document:DeploymentManifest;secretValues:Record<string,string>}>{
  normalizeDeploymentManifest(document);
  const parsed=parseDeploymentManifest(document,{env:secretValues});
  if(parsed.missingEnv.length)throw new Error("Graph edit requires all referenced secret payloads");
  // Collect old references without resolving them into the public document.
  const references=new Map<string,string>();
  const collect=(value:unknown):void=>{
    if(Array.isArray(value)){for(const item of value)collect(item);}
    else if(value && typeof value==="object"){
      const row=value as Record<string,unknown>;
      if(typeof row.env==="string" && typeof row.version==="string" && Object.keys(row).length===2){
        references.set(row.env,row.version);
      }else for(const item of Object.values(row))collect(item);
    }
  };collect(document);
  const input=parsed.input;
  const connection=(id:string)=>requireFound(input.connections.find(c=>c.connection.id===id));
  const source=(id:string)=>requireFound(input.connections.flatMap(c=>c.selectedSources).find(s=>s.id===id));
  const monitor=(id:string)=>requireFound(input.monitors.find(m=>m.monitor.id===id));
  const sink=(id:string)=>requireFound(input.monitors.flatMap(m=>m.sinks).find(s=>s.sink.id===id));
  if(!Array.isArray(edits))throw new Error("Graph edits must be an array");
  for(const original of edits){
    // Reject non-JSON data; cloning isolates newly added entities and patches too.
    const edit=JSON.parse(canonicalConfigJson(original)) as ManifestEdit;
    if(!edit || !Object.hasOwn(editFields,edit.kind))throw new Error("Unsupported graph edit kind");
    fields(edit,["kind",...editFields[edit.kind]]);
    switch(edit.kind){
      case "connection.add":fields(edit.connection,["id","provider","displayName","externalAccountId"]);input.connections.push({connection:edit.connection,selectedSources:[],...(edit.credentials===undefined?{}:{credentials:edit.credentials}),...(edit.selectAll===undefined?{}:{selectAll:edit.selectAll}),...(edit.discoverSources===undefined?{}:{discoverSources:edit.discoverSources})});break;
      case "connection.update":{const item=connection(edit.id);patch(item.connection,edit.patch,["provider","displayName","externalAccountId"]);if(edit.credentials!==undefined)item.credentials=edit.credentials;if(edit.selectAll!==undefined)item.selectAll=edit.selectAll;if(edit.discoverSources!==undefined)item.discoverSources=edit.discoverSources;break;}
      case "selection.update":input.discoverMonitors=edit.discoverMonitors;break;
      case "connection.remove":connection(edit.id);input.connections=input.connections.filter(c=>c.connection.id!==edit.id);break;
      case "source.add":fields(edit.source,["id","externalId","displayName","sourceKind","metadata"]);connection(edit.connectionId).selectedSources.push(edit.source);break;
      case "source.update":patch(source(edit.id),edit.patch,["externalId","displayName","sourceKind","metadata"]);break;
      case "source.remove":source(edit.id);for(const c of input.connections){if(c.discoverSources && c.selectedSources.some(s=>s.id===edit.id))c.discoverSources=false;c.selectedSources=c.selectedSources.filter(s=>s.id!==edit.id);}break;
      case "monitor.add":fields(edit.monitor,["id","connectionId","displayName","filterSteps","enabled"]);input.monitors.push({monitor:edit.monitor,sinks:[]});break;
      case "monitor.update":patch(monitor(edit.id).monitor,edit.patch,["connectionId","displayName","filterSteps","enabled"]);break;
      case "monitor.remove":monitor(edit.id);if(input.discoverMonitors)input.discoverMonitors=false;input.monitors=input.monitors.filter(m=>m.monitor.id!==edit.id);break;
      case "sink.add":fields(edit.sink,["id","filterSteps"]);fields(edit.destination,["id","kind","displayName"]);monitor(edit.monitorId).sinks.push({sink:edit.sink,destination:edit.destination,destinationConfig:edit.destinationConfig});break;
      case "sink.update":patch(sink(edit.id).sink,edit.patch,["filterSteps"]);break;
      case "sink.remove":sink(edit.id);if(input.discoverMonitors)input.discoverMonitors=false;for(const m of input.monitors)m.sinks=m.sinks.filter(s=>s.sink.id!==edit.id);break;
      case "destination.update":{
        const items=input.monitors.flatMap(m=>m.sinks).filter(s=>s.destination.id===edit.id);
        const metrics=input.metrics?.kind==="destination" && input.metrics.destination.id===edit.id?input.metrics:undefined;
        requireFound(items[0]??metrics);
        for(const item of [...items,...(metrics?[metrics]:[])]){patch(item.destination,edit.patch,["kind","displayName"]);if(Object.hasOwn(edit,"destinationConfig"))item.destinationConfig=edit.destinationConfig;}
        break;
      }
      case "reporting.update":if(edit.heartbeat!==undefined)input.heartbeat=edit.heartbeat;if(edit.metrics!==undefined)input.metrics=edit.metrics;if(edit.runtimeEnv!==undefined)input.runtimeEnv=edit.runtimeEnv;break;
    }
  }
  for(const c of input.connections){const keys=c.selectedSources.map(s=>canonicalConfigJson([s.sourceKind,s.externalId]));if(new Set(keys).size!==keys.length)throw new Error("Duplicate source selection");}
  return exportDeploymentManifest(input,async(name,value)=>{
    const existing=references.get(name);
    return existing!==undefined && canonicalConfigJson(JSON.parse(secretValues[name]!))===value?existing:versioner(name,value);
  });
}

export interface GraphChange {entity:"connection"|"source"|"monitor"|"sink"|"reporting";id:string;operation:"add"|"remove"|"update";fields:string[];}
export interface GraphDiff {beforeRevision:string;afterRevision:string;changes:GraphChange[];}
/** Describe only entity identities and changed field names. Never return field
 * values, labels, credential values, filter patterns or private payloads. */
export async function diffDeploymentManifests(before:DeploymentManifest,after:DeploymentManifest):Promise<GraphDiff>{
  normalizeDeploymentManifest(before);normalizeDeploymentManifest(after);
  const flatten=(doc:DeploymentManifest)=>{
    const rows=new Map<string,{entity:GraphChange["entity"];id:string;value:Record<string,unknown>}>();
    const add=(entity:GraphChange["entity"],id:string,value:Record<string,unknown>)=>rows.set(`${entity}:${id}`,{entity,id,value});
    for(const [order,c] of doc.connections.entries()){add("connection",c.connection.id,{...c.connection,credentials:c.credentials,selectAll:c.selectAll??null,discoverSources:c.discoverSources??null,order});for(const [order,s] of c.selectedSources.entries())add("source",s.id,{...s,connectionId:c.connection.id,order});}
    for(const [order,m] of doc.monitors.entries()){add("monitor",m.monitor.id,{...m.monitor,order});for(const [order,s] of m.sinks.entries())add("sink",s.sink.id,{...s.sink,destination:s.destination,destinationConfig:s.destinationConfig,monitorId:m.monitor.id,order});}
    add("reporting","reporting",{discoverMonitors:doc.discoverMonitors??null,heartbeat:doc.heartbeat??null,metrics:doc.metrics??null,runtimeEnv:doc.runtimeEnv});return rows;
  };
  const left=flatten(before),right=flatten(after),changes:GraphChange[]=[];
  for(const key of [...new Set([...left.keys(),...right.keys()])].sort()){
    const a=left.get(key),b=right.get(key),row=b??a!;
    if(!a || !b)changes.push({entity:row.entity,id:row.id,operation:a?"remove":"add",fields:Object.keys(row.value).filter(k=>k!=="id").sort()});
    else{const changed=[...new Set([...Object.keys(a.value),...Object.keys(b.value)])].filter(field=>canonicalConfigJson(a.value[field]??null)!==canonicalConfigJson(b.value[field]??null)).sort();if(changed.length)changes.push({entity:row.entity,id:row.id,operation:"update",fields:changed});}
  }
  return {beforeRevision:await hashConfigDocument(before),afterRevision:await hashConfigDocument(after),changes};
}
