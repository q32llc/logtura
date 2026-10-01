import { applyD1Migrations,env } from "cloudflare:test";
import { expect,it,inject } from "vitest";

it("upgrades schema 22 without changing legacy credentials, reporting or account versions",async()=>{
  const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0023_credential_intent_versions.sql");expect(index).toBeGreaterThan(-1);await applyD1Migrations(env.DB,migrations.slice(0,index));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES ('legacy-user','legacy-github','legacy',1,1)"),
    env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES ('legacy-con','legacy-user','railway-logs','Existing','unchanged-ciphertext',1,1)"),
    env.DB.prepare(`INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,last_seen_at,source_selection_json,monitor_selection_json,metrics_target,metrics_snapshot_json,bundle_outdated,image_digest,metadata_json,created_at,updated_at)
      VALUES ('legacy-dep','legacy-user','legacy-con','fly','Existing forwarder',0,'running','legacy-report-token',123,'[]','[]','logtura','{"updatedAt":123}',0,'sha256:legacy','{"appName":"existing"}',1,1)`),
  ]);
  const connection=await env.DB.prepare("SELECT * FROM connections").first(),deployment=await env.DB.prepare("SELECT * FROM deployments").first(),version=await env.DB.prepare("SELECT version FROM configuration_versions").first();
  await applyD1Migrations(env.DB,[migrations[index]!]);
  const after=await env.DB.prepare("SELECT * FROM connections").first<any>();expect(after).toEqual({...connection,credential_version:expect.stringMatching(/^[0-9a-f]{32}$/),credentials_refresh_nonce:null});expect(await env.DB.prepare("SELECT * FROM deployments").first()).toEqual(deployment);expect(await env.DB.prepare("SELECT version FROM configuration_versions").first()).toEqual(version);
  await env.DB.prepare("UPDATE connections SET credentials_encrypted='renewed-ciphertext',credentials_refresh_nonce='renewal' WHERE id='legacy-con'").run();expect(await env.DB.prepare("SELECT credential_version FROM connections").first("credential_version")).toBe(after.credential_version);expect(await env.DB.prepare("SELECT version FROM configuration_versions").first()).toEqual(version);
  await env.DB.prepare("UPDATE connections SET credentials_encrypted='replacement-ciphertext' WHERE id='legacy-con'").run();expect(await env.DB.prepare("SELECT credential_version FROM connections").first("credential_version")).not.toBe(after.credential_version);expect(await env.DB.prepare("SELECT version FROM configuration_versions").first<number>("version")).toBeGreaterThan((version as any).version);
});
