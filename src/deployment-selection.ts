import { canonicalConfigJson,type GenerateInput } from "@logtura/core";
import { getDeployment,type ConnectionRow,type LogSourceRow,type MonitorRow,type SinkRow } from "./db";
import { ConfigurationConflict,commitConfiguration,readStableConfiguration } from "./config-version";
import { getProvider } from "./providers";
export interface OrderedDeploymentSelection {
  schema_version:1;
  legacySources?:boolean;
  legacyMonitors?:boolean;
  discoverMonitors?:boolean;
  connections:Array<{id:string;sourceIds:string[];selectAll?:boolean;discoverSources?:boolean}>;
  monitors:Array<{id:string;sinkIds:string[]}>;
}
export interface SelectedDeploymentGraph {
  connections:Array<{connection:ConnectionRow;sources:LogSourceRow[];selectAll?:boolean;discoverSources?:boolean}>;
  monitors:Array<{monitor:MonitorRow;sinks:SinkRow[]}>;
}
function record(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key)))throw new Error("Invalid ordered deployment selection");return value as Record<string,unknown>;
}
function list(value:unknown):unknown[]{if(!Array.isArray(value))throw new Error("Invalid ordered deployment selection");return value;}
function identity(value:unknown,seen:Set<string>):string{
  if(typeof value!=="string" || value.trim().length===0 || seen.has(value))throw new Error("Invalid ordered deployment identity");seen.add(value);return value;
}
export function parseOrderedDeploymentSelection(value:unknown):OrderedDeploymentSelection{
  const root=record(value,["schema_version","connections","monitors","legacySources","legacyMonitors","discoverMonitors"]);if(root.schema_version!==1)throw new Error("Unsupported ordered deployment selection");
  for(const flag of ["legacySources","legacyMonitors","discoverMonitors"])if(root[flag]!==undefined && typeof root[flag]!=="boolean")throw new Error("Invalid legacy selection override");
  const connections=new Set<string>(),sources=new Set<string>(),monitors=new Set<string>(),sinks=new Set<string>();
  const result:OrderedDeploymentSelection={schema_version:1,...(root.discoverMonitors===undefined?{}:{discoverMonitors:root.discoverMonitors as boolean}),...(root.legacySources===undefined?{}:{legacySources:root.legacySources as boolean}),...(root.legacyMonitors===undefined?{}:{legacyMonitors:root.legacyMonitors as boolean}),connections:list(root.connections).map(value=>{
    const row=record(value,["id","sourceIds","selectAll","discoverSources"]);for(const flag of ["selectAll","discoverSources"])if(row[flag]!==undefined && typeof row[flag]!=="boolean")throw new Error("Invalid all-source selection mode");
    if(row.selectAll && row.discoverSources)throw new Error("Native all-source and discovered-source modes are mutually exclusive");
    return {id:identity(row.id,connections),sourceIds:list(row.sourceIds).map(id=>identity(id,sources)),...(row.selectAll===undefined?{}:{selectAll:row.selectAll as boolean}),...(row.discoverSources===undefined?{}:{discoverSources:row.discoverSources as boolean})};
  }),monitors:list(root.monitors).map(value=>{const row=record(value,["id","sinkIds"]);return {id:identity(row.id,monitors),sinkIds:list(row.sinkIds).map(id=>identity(id,sinks))};})};
  if(result.connections.length===0)throw new Error("Deployment requires a connection");return result;
}
export function orderedSelectionFromInput(input:GenerateInput):OrderedDeploymentSelection{
  return parseOrderedDeploymentSelection({schema_version:1,...(input.discoverMonitors===undefined?{}:{discoverMonitors:input.discoverMonitors}),connections:input.connections.map(c=>({id:c.connection.id,sourceIds:c.selectedSources.map(s=>s.id),...(c.selectAll===undefined?{}:{selectAll:c.selectAll}),...(c.discoverSources===undefined?{}:{discoverSources:c.discoverSources})})),monitors:input.monitors.map(m=>({id:m.monitor.id,sinkIds:m.sinks.map(s=>s.sink.id)}))});
}
/** Resolve owned rows only, retaining explicit order and disabled monitors.
 * Deleted inventory IDs are omitted, as with the legacy selector. Existing IDs
 * attached to the wrong parent are rejected rather than rebound. */
export async function loadSelectedDeploymentGraph(db:D1Database,userId:string,selection:OrderedDeploymentSelection):Promise<SelectedDeploymentGraph>{
  const rows=await db.batch([
    db.prepare("SELECT * FROM connections WHERE user_id=?").bind(userId),
    db.prepare("SELECT s.* FROM log_sources s JOIN connections c ON c.id=s.connection_id WHERE c.user_id=?").bind(userId),
    db.prepare("SELECT * FROM monitors WHERE user_id=?").bind(userId),
    db.prepare("SELECT s.* FROM sinks s JOIN monitors m ON m.id=s.monitor_id JOIN destinations d ON d.id=s.destination_id WHERE m.user_id=? AND d.user_id=m.user_id ORDER BY s.created_at,s.id").bind(userId),
  ]);
  const connections=new Map((rows[0]!.results as unknown as ConnectionRow[]).map(c=>[c.id,c])),sources=new Map((rows[1]!.results as unknown as LogSourceRow[]).map(s=>[s.id,s])),monitors=new Map((rows[2]!.results as unknown as MonitorRow[]).map(m=>[m.id,m])),sinks=new Map((rows[3]!.results as unknown as SinkRow[]).map(s=>[s.id,s]));
  return {connections:(selection.legacySources?[]:selection.connections).flatMap(c=>{
    const connection=connections.get(c.id);if(!connection)return [];
    return [{connection,sources:(c.discoverSources?[...c.sourceIds,...[...sources.values()].filter(s=>s.connection_id===c.id && !c.sourceIds.includes(s.id)).sort((a,b)=>a.source_kind.localeCompare(b.source_kind)||a.display_name.localeCompare(b.display_name)||a.id.localeCompare(b.id)).map(s=>s.id)]:c.sourceIds).flatMap(id=>{const source=sources.get(id);if(!source)return [];if(source.connection_id!==c.id)throw new Error("Source selection parent mismatch");return [source];}),...(c.selectAll===undefined?{}:{selectAll:c.selectAll}),...(c.discoverSources===undefined?{}:{discoverSources:c.discoverSources})}];
  }),monitors:(selection.legacyMonitors?[]:selection.discoverMonitors?[...selection.monitors,...[...monitors.values()].filter(m=>m.enabled===1 && (m.connection_id===null || selection.connections.some(c=>c.id===m.connection_id)) && !selection.monitors.some(known=>known.id===m.id)).sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id)).map(m=>({id:m.id,sinkIds:[]}))]:selection.monitors).flatMap(m=>{
    const monitor=monitors.get(m.id);if(!monitor)return [];
    return [{monitor,sinks:(selection.discoverMonitors?[...m.sinkIds,...[...sinks.values()].filter(s=>s.monitor_id===m.id && !m.sinkIds.includes(s.id)).map(s=>s.id)]:m.sinkIds).flatMap(id=>{const sink=sinks.get(id);if(!sink)return [];if(sink.monitor_id!==m.id)throw new Error("Sink selection parent mismatch");return [sink];})}];
  })};
}
/** Caller validates owned graph references before compiling. Write flat columns
 * before the ordered representation so legacy override triggers cannot discard
 * the newly issued selection. Both statements belong in the same guarded batch. */
export function compileDeploymentSelection(db:D1Database,userId:string,deploymentId:string,selection:OrderedDeploymentSelection):D1PreparedStatement[]{
  const validated=parseOrderedDeploymentSelection(selection),sourceIds=canonicalConfigJson(validated.connections.flatMap(c=>c.sourceIds)),monitorIds=canonicalConfigJson(validated.monitors.map(m=>m.id)),json=canonicalConfigJson(validated),now=Date.now();
  return [db.prepare(`UPDATE deployments SET source_selection_json=?,monitor_selection_json=?,updated_at=? WHERE id=? AND user_id=? AND (source_selection_json IS NOT ? OR monitor_selection_json IS NOT ?)`).bind(sourceIds,monitorIds,now,deploymentId,userId,sourceIds,monitorIds),
    db.prepare("UPDATE deployments SET graph_selection_json=?,updated_at=? WHERE id=? AND user_id=? AND graph_selection_json IS NOT ?").bind(json,now,deploymentId,userId,json)];
}
export async function setOrderedDeploymentSelection(db:D1Database,userId:string,deploymentId:string,expectedVersion:number,selection:OrderedDeploymentSelection):Promise<{version:number}>{
  if(!Number.isSafeInteger(expectedVersion) || expectedVersion<0)throw new Error("Invalid configuration version");
  const validated=parseOrderedDeploymentSelection(selection);
  if(validated.legacySources || validated.legacyMonitors)throw new Error("Legacy selection overrides are read-only");
  const snapshot=await readStableConfiguration(db,userId,async()=>{
    if(!await getDeployment(db,userId,deploymentId))throw new Error("Deployment not found");
    return loadSelectedDeploymentGraph(db,userId,validated);
  });
  if(snapshot.version!==expectedVersion)throw new ConfigurationConflict(expectedVersion,snapshot.version);
  const graph=snapshot.value;
  if(graph.connections.length!==validated.connections.length || (!validated.discoverMonitors && graph.monitors.length!==validated.monitors.length) || graph.connections.some((c,i)=>validated.connections[i]!.sourceIds.some(id=>!c.sources.some(s=>s.id===id))) || validated.monitors.some(m=>!graph.monitors.some(found=>found.monitor.id===m.id && m.sinkIds.every(id=>found.sinks.some(s=>s.id===id)))))throw new Error("Deployment selection references missing or unowned inventory");
  const providers=new Set<string>();
  for(const c of graph.connections){
    if(providers.has(c.connection.provider))throw new Error("Only one connection per provider is supported");providers.add(c.connection.provider);
    const provider=getProvider(c.connection.provider);if(!provider)throw new Error("Unknown selection provider");
    if(c.selectAll && provider.capabilities.selection!=="all" && provider.capabilities.selection!=="both")throw new Error("Provider does not support all-source selection");
  }
  const connectionIds=new Set(graph.connections.map(c=>c.connection.id));
  if(graph.monitors.some(m=>m.monitor.connection_id!==null && !connectionIds.has(m.monitor.connection_id)))throw new Error("Monitor references an unselected connection");
  const {version}=await commitConfiguration(db,userId,expectedVersion,compileDeploymentSelection(db,userId,deploymentId,validated));return {version};
}
