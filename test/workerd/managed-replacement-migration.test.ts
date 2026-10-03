import {applyD1Migrations,env} from "cloudflare:test";
import {expect,inject,it} from "vitest";
it("adds a null replacement cursor without rewriting existing encrypted installation or deployment state",async()=>{
 const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0029_managed_replacement_phases.sql");expect(index).toBeGreaterThan(-1);await applyD1Migrations(env.DB,migrations.slice(0,index));
 await env.DB.batch([
  env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES('owner','github','owner',1,1)"),
  env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES('con','owner','railway-logs','Existing',x'0102',1,1)"),
  env.DB.prepare("INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,created_at,updated_at) VALUES('dep','owner','con','fly','Existing',1,'running','unchanged-token',1,1)"),
  env.DB.prepare("INSERT INTO managed_installations(id,deployment_id,user_id,app_name,org_slug,region,configuration_version,payload_encrypted,phase,machine_id,created_at,updated_at) VALUES('install','dep','owner','app','personal','ord',1,x'010203','installed','machine',1,1)"),
 ]);
 const before=await env.DB.prepare("SELECT * FROM managed_installations").first(),deployment=await env.DB.prepare("SELECT * FROM deployments").first(),clock=await env.DB.prepare("SELECT * FROM configuration_versions").all();
 await applyD1Migrations(env.DB,[migrations[index]!]);expect(await env.DB.prepare("SELECT * FROM managed_installations").first()).toEqual({...before,replacement_phase:null});expect(await env.DB.prepare("SELECT * FROM deployments").first()).toEqual(deployment);expect((await env.DB.prepare("SELECT * FROM configuration_versions").all()).results).toEqual(clock.results);
 await expect(env.DB.prepare("UPDATE managed_installations SET replacement_phase='unknown' WHERE id='install'").run()).rejects.toThrow("CHECK constraint");
});
