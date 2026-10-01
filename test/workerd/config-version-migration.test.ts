import { applyD1Migrations,env } from "cloudflare:test";
import { expect,it,inject } from "vitest";

it("upgrades the existing schema without rewriting forwarder configuration or reporting state",async()=>{
  const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0019_configuration_versions.sql");expect(index).toBeGreaterThan(-1);const last=migrations[index]!;
  await applyD1Migrations(env.DB,migrations.slice(0,index));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES ('legacy-user','legacy-github','legacy',1,1)"),
    env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES ('legacy-con','legacy-user','cloudflare-worker-tail','Existing','unchanged-ciphertext',1,1)"),
    env.DB.prepare("INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,last_seen_at,source_selection_json,metadata_json,created_at,updated_at) VALUES ('legacy-dep','legacy-user','legacy-con','fly','Existing forwarder',0,'running','legacy-report-token',123,'[]','{\"imageDigest\":\"sha256:legacy\"}',1,1)"),
  ]);
  const before=await env.DB.prepare("SELECT * FROM deployments WHERE id='legacy-dep'").first();await applyD1Migrations(env.DB,[last]);
  expect(await env.DB.prepare("SELECT * FROM deployments WHERE id='legacy-dep'").first()).toEqual(before);
  expect(await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first()).toEqual({version:0});
  await env.DB.prepare("UPDATE deployments SET last_seen_at=456,status='crashed' WHERE id='legacy-dep'").run();expect(await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first()).toEqual({version:0});
  await env.DB.prepare("UPDATE connections SET display_name='Changed' WHERE id='legacy-con'").run();expect(await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first()).toEqual({version:1});
  expect(await env.DB.prepare("SELECT credentials_encrypted FROM connections WHERE id='legacy-con'").first()).toEqual({credentials_encrypted:"unchanged-ciphertext"});
});
