import { env } from "cloudflare:test";
import { describe,it,expect } from "vitest";
import { commitConfiguration,ConfigurationConflict,readConfigurationVersion,readStableConfiguration } from "../../src/config-version";
import { newId } from "../../src/crypto";
import { seedUser } from "./_setup";

async function fixture(){
  const {userId}=await seedUser(),now=Date.now();const connectionId=newId("con"),sourceId=newId("src"),destinationId=newId("dst"),monitorId=newId("mon"),sinkId=newId("snk"),deploymentId=newId("dep"),targetId=newId("dt");
  const sql=(query:string,...values:unknown[])=>env.DB.prepare(query).bind(...values);
  await env.DB.batch([
    sql("INSERT INTO connections (id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES (?,?,'test','Connection','cipher',?,?)",connectionId,userId,now,now),
    sql("INSERT INTO log_sources (id,connection_id,source_kind,external_id,display_name,discovered_at) VALUES (?,?,'test','external','Source',?)",sourceId,connectionId,now),
    sql("INSERT INTO destinations (id,user_id,kind,display_name,config_encrypted,created_at,updated_at) VALUES (?,?,'webhook','Destination','cipher',?,?)",destinationId,userId,now,now),
    sql("INSERT INTO monitors (id,user_id,connection_id,display_name,enabled,created_at,updated_at) VALUES (?,?,?,'Monitor',1,?,?)",monitorId,userId,connectionId,now,now),
    sql("INSERT INTO sinks (id,monitor_id,destination_id,created_at) VALUES (?,?,?,?)",sinkId,monitorId,destinationId,now),
    sql("INSERT INTO deploy_targets (id,user_id,kind,display_name,created_at,updated_at) VALUES (?,?,'fly','Target',?,?)",targetId,userId,now,now),
    sql("INSERT INTO deployments (id,user_id,connection_id,deploy_target_id,target_kind,display_name,created_at,updated_at) VALUES (?,?,?,?,'other','Deployment',?,?)",deploymentId,userId,connectionId,targetId,now,now),
    sql("INSERT INTO deployment_connections (deployment_id,connection_id,added_at) VALUES (?,?,?)",deploymentId,connectionId,now),
  ]);
  return {userId,connectionId,sourceId,destinationId,monitorId,sinkId,deploymentId,targetId,sql};
}
async function guards(){return (await env.DB.prepare("SELECT COUNT(*) AS count FROM configuration_write_guards").first<{count:number}>())!.count;}
describe("configuration version transactions",()=>{
  it("starts new users at zero and tracks config writes without tracking runtime updates",async()=>{
    const {userId}=await seedUser();expect(await readConfigurationVersion(env.DB,userId)).toBe(0);
    const f=await fixture();expect(await readConfigurationVersion(env.DB,f.userId)).toBe(8);const before=await readConfigurationVersion(env.DB,f.userId);
    for(const statement of [f.sql("UPDATE deployments SET last_seen_at=1,status='running',last_alert_sent_at=2,metrics_snapshot_json='{}',bundle_outdated=0 WHERE id=?",f.deploymentId),f.sql("UPDATE connections SET updated_at=123,last_discovered_at=123 WHERE id=?",f.connectionId),f.sql("UPDATE log_sources SET discovered_at=123 WHERE id=?",f.sourceId)])await statement.run();
    expect(await readConfigurationVersion(env.DB,f.userId)).toBe(before);
    await f.sql("UPDATE connections SET display_name=display_name WHERE id=?",f.connectionId).run();expect(await readConfigurationVersion(env.DB,f.userId)).toBe(before);
  });
  it.each([
    ["connections","display_name='Edited'","connectionId"], ["log_sources","metadata_json='{}'","sourceId"], ["destinations","config_encrypted='updated'","destinationId"],
    ["monitors","filter_steps_json='[]'","monitorId"], ["sinks","filter_steps_json='[]'","sinkId"], ["deploy_targets","credentials_encrypted='updated'","targetId"], ["deployments","heartbeat_token='rotated'","deploymentId"],
  ])("tracks updates and deletes in %s",async(table,update,key)=>{
    const f=await fixture(),before=await readConfigurationVersion(env.DB,f.userId),id=f[key as keyof typeof f];
    await env.DB.prepare(`UPDATE ${table} SET ${update} WHERE id=?`).bind(id).run();expect(await readConfigurationVersion(env.DB,f.userId)).toBe(before+1);
    await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run();expect(await readConfigurationVersion(env.DB,f.userId)).toBeGreaterThan(before+1);
  });
  it("tracks link ordering and removal, selection and ownership moves, and isolates users",async()=>{
    const f=await fixture(),other=await seedUser(),before=await readConfigurationVersion(env.DB,f.userId);
    await f.sql("UPDATE deployment_connections SET added_at=added_at+1 WHERE deployment_id=?",f.deploymentId).run();expect(await readConfigurationVersion(env.DB,f.userId)).toBe(before+1);
    await f.sql("DELETE FROM deployment_connections WHERE deployment_id=?",f.deploymentId).run();expect(await readConfigurationVersion(env.DB,f.userId)).toBe(before+2);
    await f.sql("UPDATE deployments SET source_selection_json='[]',monitor_selection_json='[]',metrics_target='none' WHERE id=?",f.deploymentId).run();expect(await readConfigurationVersion(env.DB,f.userId)).toBe(before+3);
    expect(await readConfigurationVersion(env.DB,other.userId)).toBe(0);
    await f.sql("UPDATE destinations SET user_id=? WHERE id=?",other.userId,f.destinationId).run();expect(await readConfigurationVersion(env.DB,other.userId)).toBe(1);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(before+4);
  });
  it("commits changes and their final version atomically and rejects a stale writer",async()=>{
    const f=await fixture(),version=await readConfigurationVersion(env.DB,f.userId);
    const committed=await commitConfiguration(env.DB,f.userId,version,[f.sql("UPDATE connections SET display_name='First' WHERE id=?",f.connectionId),f.sql("UPDATE monitors SET enabled=0 WHERE id=?",f.monitorId)]);expect(committed.version).toBe(version+2);expect(committed.results).toHaveLength(2);expect(await guards()).toBe(0);
    await expect(commitConfiguration(env.DB,f.userId,version,[f.sql("UPDATE connections SET display_name='Stale' WHERE id=?",f.connectionId)])).rejects.toMatchObject({name:"ConfigurationConflict",expectedVersion:version,currentVersion:version+2});
    expect((await f.sql("SELECT display_name FROM connections WHERE id=?",f.connectionId).first<{display_name:string}>())!.display_name).toBe("First");expect(await guards()).toBe(0);
    expect(await commitConfiguration(env.DB,f.userId,version+2,[])).toEqual({version:version+2,results:[]});
  });
  it("allows exactly one of two concurrent writes from the same base version",async()=>{
    const f=await fixture(),version=await readConfigurationVersion(env.DB,f.userId);
    const results=await Promise.allSettled(["One","Two"].map(name=>commitConfiguration(env.DB,f.userId,version,[f.sql("UPDATE connections SET display_name=? WHERE id=?",name,f.connectionId)])));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason).toBeInstanceOf(ConfigurationConflict);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version+1);expect(await guards()).toBe(0);
  });
  it("rolls back the entire batch and version when a later mutation fails",async()=>{
    const f=await fixture(),version=await readConfigurationVersion(env.DB,f.userId);
    await expect(commitConfiguration(env.DB,f.userId,version,[f.sql("UPDATE connections SET display_name='Partial' WHERE id=?",f.connectionId),f.sql("INSERT INTO monitors(id,user_id,display_name,created_at,updated_at) VALUES (?,?,'Duplicate',1,1)",f.monitorId,f.userId)])).rejects.toThrow();
    expect((await f.sql("SELECT display_name FROM connections WHERE id=?",f.connectionId).first<{display_name:string}>())!.display_name).toBe("Connection");expect(await readConfigurationVersion(env.DB,f.userId)).toBe(version);expect(await guards()).toBe(0);
  });
  it.each([-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1])("rejects invalid expected versions (%s)",async version=>{const f=await fixture();await expect(commitConfiguration(env.DB,f.userId,version,[])).rejects.toThrow("Invalid configuration version");});
  it("handles owner deletion without leaving configuration or guard rows",async()=>{
    const {userId}=await seedUser();await env.DB.prepare("DELETE FROM users WHERE id=?").bind(userId).run();await expect(readConfigurationVersion(env.DB,userId)).rejects.toThrow("owner not found");await expect(commitConfiguration(env.DB,userId,0,[])).rejects.toThrow("owner not found");expect(await guards()).toBe(0);
  });
  it("exports only a stable version and bounds retries under ongoing mutation",async()=>{
    const f=await fixture();let calls=0;
    const snapshot=await readStableConfiguration(env.DB,f.userId,async()=>{if(++calls===1)await f.sql("UPDATE monitors SET enabled=0 WHERE id=?",f.monitorId).run();return calls;});expect(snapshot.value).toBe(2);expect(snapshot.version).toBe(await readConfigurationVersion(env.DB,f.userId));
    await expect(readStableConfiguration(env.DB,f.userId,async()=>{await f.sql("UPDATE monitors SET enabled=1-enabled WHERE id=?",f.monitorId).run();return "unstable";})).rejects.toBeInstanceOf(ConfigurationConflict);
    await expect(readStableConfiguration(env.DB,f.userId,async()=>{throw new Error("load failed");})).rejects.toThrow("load failed");
  });
  it("propagates non-Error storage failures without classifying them as conflicts",async()=>{
    const db={prepare:(query:string)=>env.DB.prepare(query),batch:async()=>{throw "opaque storage failure";}} as unknown as D1Database;
    await expect(commitConfiguration(db,"unused",0,[])).rejects.toBe("opaque storage failure");
  });

});
