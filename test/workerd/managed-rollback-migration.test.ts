import {applyD1Migrations,env} from "cloudflare:test";
import {expect,inject,it} from "vitest";
it("adds rollback storage and guards without rewriting existing legacy or issued installations",async()=>{
 const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0030_managed_rollbacks.sql");expect(index).toBeGreaterThan(-1);await applyD1Migrations(env.DB,migrations.slice(0,index));
 await env.DB.batch([
  env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES('owner','github','owner',1,1)"),
  env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES('con','owner','railway-logs','Existing',x'0102',1,1)"),
  env.DB.prepare("INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,created_at,updated_at) VALUES('dep','owner','con','fly','Existing',1,'running','unchanged-token',1,1)"),
  env.DB.prepare("INSERT INTO managed_installations(id,deployment_id,user_id,app_name,org_slug,region,configuration_version,payload_encrypted,phase,machine_id,replacement_phase,created_at,updated_at) VALUES('install','dep','owner','app','personal','ord',1,x'010203','installed','machine',NULL,1,1)"),
 ]);
 const installation=await env.DB.prepare("SELECT * FROM managed_installations").first(),deployment=await env.DB.prepare("SELECT * FROM deployments").first(),clock=await env.DB.prepare("SELECT * FROM configuration_versions").all();
 await applyD1Migrations(env.DB,[migrations[index]!]);expect(await env.DB.prepare("SELECT * FROM managed_installations").first()).toEqual(installation);expect(await env.DB.prepare("SELECT * FROM deployments").first()).toEqual(deployment);expect((await env.DB.prepare("SELECT * FROM configuration_versions").all()).results).toEqual(clock.results);expect((await env.DB.prepare("SELECT * FROM managed_rollbacks").all()).results).toEqual([]);
 await env.DB.prepare("UPDATE managed_installations SET lease_token='normal',lease_until=999 WHERE id='install'").run();expect(await env.DB.prepare("SELECT lease_token FROM managed_installations WHERE id='install'").first("lease_token")).toBe("normal");
});
