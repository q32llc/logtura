import {applyD1Migrations,env} from "cloudflare:test";
import {expect,inject,it} from "vitest";
it("adds opt-in creation receipts without changing existing routing objects or graph clocks",async()=>{
 const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0032_creation_requests.sql");expect(index).toBeGreaterThan(-1);await applyD1Migrations(env.DB,migrations.slice(0,index));
 await env.DB.batch([
 env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES('owner','github','owner',1,1)"),
 env.DB.prepare("INSERT INTO monitors(id,user_id,connection_id,display_name,filter_steps_json,enabled,created_at,updated_at) VALUES('legacy-monitor','owner',NULL,'Monitor',NULL,1,1,1)"),
 env.DB.prepare("INSERT INTO destinations(id,user_id,kind,display_name,config_encrypted,created_at,updated_at) VALUES('legacy-destination','owner','webhook','Destination',x'010203',1,1)"),
 env.DB.prepare("INSERT INTO sinks(id,monitor_id,destination_id,filter_steps_json,created_at) VALUES('legacy-sink','legacy-monitor','legacy-destination',NULL,1)"),
 ]);
 const tables=["users","monitors","destinations","sinks","configuration_versions"],before=await Promise.all(tables.map(t=>env.DB.prepare(`SELECT * FROM ${t}`).all()));
 await applyD1Migrations(env.DB,[migrations[index]!]);for(let n=0;n<tables.length;n++)expect((await env.DB.prepare(`SELECT * FROM ${tables[n]}`).all()).results).toEqual(before[n]!.results);
 expect((await env.DB.prepare("SELECT * FROM resource_creation_requests").all()).results).toEqual([]);
 await env.DB.prepare("UPDATE monitors SET display_name='After upgrade' WHERE id='legacy-monitor'").run();await env.DB.prepare("DELETE FROM monitors WHERE id='legacy-monitor'").run();expect(await env.DB.prepare("SELECT * FROM sinks WHERE id='legacy-sink'").first()).toBeNull();expect(await env.DB.prepare("SELECT * FROM destinations WHERE id='legacy-destination'").first()).not.toBeNull();
});
