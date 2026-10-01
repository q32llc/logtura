import { planDeploymentChanges, type GenerateInput, type GraphInventory, type DeploymentChangePlan } from "@logtura/core";
import type { Env } from "./env";
import { decryptConnectionCredentials,decryptDestinationConfig,parseFilterSteps,type ConnectionRow,type LogSourceRow,type DestinationRow,type MonitorRow,type SinkRow } from "./db";
import { ConfigurationConflict,commitConfiguration,readStableConfiguration } from "./config-version";
import { encryptSecret } from "./crypto";

function metadata(value:string|null):Record<string,unknown>|null{
  if(value===null)return null;
  try{const parsed=JSON.parse(value);if(parsed===null)return null;if(typeof parsed!=="object" || Array.isArray(parsed))throw new Error();return parsed;}
  catch{throw new Error("Invalid stored source metadata");}
}
/** Read only owned rows in a single D1 read batch. No provider verification,
 * broker token minting or implicit credential renewal belongs in this snapshot. */
export async function loadOwnedGraphInventory(env:Env,userId:string):Promise<{version:number;value:GraphInventory}>{
  return readStableConfiguration(env.DB,userId,async()=>{
    const rows=await env.DB.batch([
      env.DB.prepare("SELECT * FROM connections WHERE user_id=?").bind(userId),
      env.DB.prepare("SELECT s.* FROM log_sources s JOIN connections c ON c.id=s.connection_id WHERE c.user_id=?").bind(userId),
      env.DB.prepare("SELECT * FROM destinations WHERE user_id=?").bind(userId),
      env.DB.prepare("SELECT * FROM monitors WHERE user_id=?").bind(userId),
      env.DB.prepare("SELECT s.* FROM sinks s JOIN monitors m ON m.id=s.monitor_id WHERE m.user_id=?").bind(userId),
    ]);
    const connections=rows[0]!.results as unknown as ConnectionRow[],sources=rows[1]!.results as unknown as LogSourceRow[],destinations=rows[2]!.results as unknown as DestinationRow[],monitors=rows[3]!.results as unknown as MonitorRow[],sinks=rows[4]!.results as unknown as SinkRow[];
    const connectionValues=await Promise.all(connections.map(async c=>{
      let credentials:Record<string,unknown>;try{credentials=await decryptConnectionCredentials<Record<string,unknown>>(env,c);}catch{throw new Error("Invalid stored connection credential");}
      if(!credentials || typeof credentials!=="object" || Array.isArray(credentials))throw new Error("Invalid stored connection credential");
      return {connection:{id:c.id,provider:c.provider,displayName:c.display_name,externalAccountId:c.external_account_id},credentials};
    }));
    const destinationValues=await Promise.all(destinations.map(async d=>{
      let config:unknown;try{config=await decryptDestinationConfig(env,d);}catch{throw new Error("Invalid stored destination configuration");}
      return {destination:{id:d.id,kind:d.kind,displayName:d.display_name},config};
    }));
    return {connections:connectionValues,sources:sources.map(s=>({connectionId:s.connection_id,source:{id:s.id,externalId:s.external_id,displayName:s.display_name,sourceKind:s.source_kind,metadata:metadata(s.metadata_json)}})),destinations:destinationValues,
      monitors:monitors.map(m=>({id:m.id,connectionId:m.connection_id,displayName:m.display_name,enabled:m.enabled===1,filterSteps:parseFilterSteps(m.filter_steps_json)})),
      sinks:sinks.map(s=>({sink:{id:s.id,filterSteps:parseFilterSteps(s.filter_steps_json)},monitorId:s.monitor_id,destinationId:s.destination_id}))};
  });
}
/** Preparation performs no writes. The caller must validate all incoming IDs,
 * registry capabilities and reporting scope, then compile and execute this plan
 * with commitConfiguration at this same version. Never return private plan rows
 * in an HTTP diff or log them. */
export async function prepareGraphReconciliation(env:Env,userId:string,expectedVersion:number,desired:GenerateInput):Promise<{version:number;plan:DeploymentChangePlan;inventory:GraphInventory}>{
  if(!Number.isSafeInteger(expectedVersion) || expectedVersion<0)throw new Error("Invalid configuration version");
  const snapshot=await loadOwnedGraphInventory(env,userId);
  if(snapshot.version!==expectedVersion)throw new ConfigurationConflict(expectedVersion,snapshot.version);
  return {version:snapshot.version,plan:planDeploymentChanges(snapshot.value,desired),inventory:snapshot.value};
}

/** Persist resolved, raw storage values, never OAuth broker credentials from a
 * rendered bundle. This internal adapter is not an HTTP authorization boundary:
 * callers validate registry/provider/reporting policy first. It changes account
 * inventory only; deployment selection and desired/applied records are separate.
 * New identities use INSERT so a foreign account's ID cannot become a successful
 * no-op UPSERT. Any collision or concurrent owned edit rolls back the full batch.
 */
export async function reconcileOwnedGraph(env:Env,userId:string,expectedVersion:number,desired:GenerateInput):Promise<{version:number;plan:DeploymentChangePlan}>{
  const {plan,inventory}=await prepareGraphReconciliation(env,userId,expectedVersion,desired);
  const db=env.DB,statements:D1PreparedStatement[]=[],timestamp=Date.now();
  const connectionIds=new Set(inventory.connections.map(c=>c.connection.id)),sourceIds=new Set(inventory.sources.map(s=>s.source.id)),destinationIds=new Set(inventory.destinations.map(d=>d.destination.id)),monitorIds=new Set(inventory.monitors.map(m=>m.id)),sinkIds=new Set(inventory.sinks.map(s=>s.sink.id));
  for(const value of plan.connections){
    const c=value.connection;
    if(value.credentials===undefined)throw new Error("Resolve connection credentials before persisting a graph");
    const encrypted=await encryptSecret(JSON.stringify(value.credentials),env.CREDENTIAL_ENCRYPTION_KEY);
    statements.push(connectionIds.has(c.id)
      ?db.prepare("UPDATE connections SET provider=?,display_name=?,external_account_id=?,credentials_encrypted=?,updated_at=? WHERE id=? AND user_id=?").bind(c.provider,c.displayName,c.externalAccountId,encrypted,timestamp,c.id,userId)
      :db.prepare("INSERT INTO connections(id,user_id,provider,display_name,external_account_id,credentials_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(c.id,userId,c.provider,c.displayName,c.externalAccountId,encrypted,timestamp,timestamp));
  }
  for(const value of plan.sources){
    const s=value.source,metadataJson=s.metadata===null?null:JSON.stringify(s.metadata);
    statements.push(sourceIds.has(s.id)
      ?db.prepare("UPDATE log_sources SET display_name=?,metadata_json=? WHERE id=? AND connection_id IN (SELECT id FROM connections WHERE user_id=?)").bind(s.displayName,metadataJson,s.id,userId)
      :db.prepare("INSERT INTO log_sources(id,connection_id,source_kind,external_id,display_name,metadata_json,discovered_at) VALUES (?,?,?,?,?,?,?)").bind(s.id,value.connectionId,s.sourceKind,s.externalId,s.displayName,metadataJson,timestamp));
  }
  for(const value of plan.destinations){
    const d=value.destination,encrypted=await encryptSecret(JSON.stringify(value.config),env.CREDENTIAL_ENCRYPTION_KEY);
    statements.push(destinationIds.has(d.id)
      ?db.prepare("UPDATE destinations SET kind=?,display_name=?,config_encrypted=?,updated_at=? WHERE id=? AND user_id=?").bind(d.kind,d.displayName,encrypted,timestamp,d.id,userId)
      :db.prepare("INSERT INTO destinations(id,user_id,kind,display_name,config_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(d.id,userId,d.kind,d.displayName,encrypted,timestamp,timestamp));
  }
  for(const m of plan.monitors){
    const filters=m.filterSteps.length===0?null:JSON.stringify(m.filterSteps);
    statements.push(monitorIds.has(m.id)
      ?db.prepare("UPDATE monitors SET connection_id=?,display_name=?,enabled=?,filter_steps_json=?,updated_at=? WHERE id=? AND user_id=?").bind(m.connectionId,m.displayName,m.enabled?1:0,filters,timestamp,m.id,userId)
      :db.prepare("INSERT INTO monitors(id,user_id,connection_id,display_name,enabled,filter_steps_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(m.id,userId,m.connectionId,m.displayName,m.enabled?1:0,filters,timestamp,timestamp));
  }
  for(const value of plan.sinks){
    const s=value.sink,filters=s.filterSteps.length===0?null:JSON.stringify(s.filterSteps);
    statements.push(sinkIds.has(s.id)
      ?db.prepare("UPDATE sinks SET destination_id=?,filter_steps_json=? WHERE id=? AND monitor_id IN (SELECT id FROM monitors WHERE user_id=?)").bind(value.destinationId,filters,s.id,userId)
      :db.prepare("INSERT INTO sinks(id,monitor_id,destination_id,filter_steps_json,created_at) VALUES (?,?,?,?,?)").bind(s.id,value.monitorId,value.destinationId,filters,timestamp));
  }
  for(const id of plan.removeSinkIds)statements.push(db.prepare("DELETE FROM sinks WHERE id=? AND monitor_id IN (SELECT id FROM monitors WHERE user_id=?)").bind(id,userId));
  if(statements.length>0)statements.push(db.prepare("UPDATE deployments SET bundle_outdated=1,updated_at=? WHERE user_id=? AND bundle_outdated=0").bind(timestamp,userId));
  const {version}=await commitConfiguration(db,userId,expectedVersion,statements);
  return {version,plan};
}
