import {applyD1Migrations,env} from "cloudflare:test";
import {expect,it,inject} from "vitest";
it("adds retained-machine binding receipts to schema 32 without changing any existing deployment or runtime identity",async()=>{
 const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0033_linked_fly_bindings.sql");expect(index).toBeGreaterThan(-1);
 await applyD1Migrations(env.DB,migrations.slice(0,index));
 await env.DB.batch([
  env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES('owner','gh-owner','owner',1,1)"),
  env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES('con','owner','cloudflare-worker-tail','Account','unchanged-encrypted-secret',1,1)"),
  env.DB.prepare(`INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,external_id,heartbeat_token,last_seen_at,source_selection_json,monitor_selection_json,metrics_target,metrics_snapshot_json,bundle_outdated,image_digest,metadata_json,runtime_env_encrypted,created_at,updated_at)
   VALUES('dep','owner','con','fly','Legacy',0,'running','fly:app:abc','unchanged-report-token',123,'[]','[]','logtura','{"updatedAt":123}',0,'sha256:legacy','{"appName":"app","private":"unchanged"}','unchanged-runtime',1,1)`),
 ]);
 const tables=["users","connections","deployments","configuration_versions","deployment_configuration_state","deployment_configuration_revisions","deployment_instance_receipts","managed_installations","managed_checkpoints","managed_rollbacks","managed_cleanups"];
 const before=await Promise.all(tables.map(table=>env.DB.prepare(`SELECT * FROM ${table}`).all()));
 await applyD1Migrations(env.DB,[migrations[index]!]);
 for(const [i,table] of tables.entries())expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toEqual(before[i]!.results);
 expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM linked_fly_binding_receipts").first("n")).toBe(0);
 expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
