import { applyD1Migrations,env } from "cloudflare:test";
import { expect,it,inject } from "vitest";
it("upgrades schema 19 without changing deployed bundles, tokens, metrics or configuration versions",async()=>{
  const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0020_deployment_configuration_state.sql");expect(index).toBeGreaterThan(-1);
  await applyD1Migrations(env.DB,migrations.slice(0,index));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES ('legacy-user','legacy-github','legacy',1,1)"),
    env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES ('legacy-con','legacy-user','cloudflare-worker-tail','Existing','unchanged-ciphertext',1,1)"),
    env.DB.prepare(`INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,last_seen_at,source_selection_json,monitor_selection_json,metrics_target,metrics_snapshot_json,bundle_outdated,image_digest,metadata_json,created_at,updated_at)
      VALUES ('legacy-dep','legacy-user','legacy-con','fly','Existing forwarder',0,'running','legacy-report-token',123,'[]','[]','logtura','{"updatedAt":123}',0,'sha256:legacy','{"appName":"existing"}',1,1)`),
  ]);
  const before=await env.DB.prepare("SELECT * FROM deployments WHERE id='legacy-dep'").first(),version=await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first();
  await applyD1Migrations(env.DB,[migrations[index]!]);
  expect(await env.DB.prepare("SELECT * FROM deployments WHERE id='legacy-dep'").first()).toEqual(before);expect(await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first()).toEqual(version);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM deployment_configuration_state").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM deployment_configuration_revisions").first("n")).toBe(0);
  await env.DB.prepare("UPDATE deployments SET last_seen_at=456,metrics_snapshot_json='{\"updatedAt\":456}',status='crashed' WHERE id='legacy-dep'").run();expect(await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first()).toEqual(version);
  expect(await env.DB.prepare("SELECT credentials_encrypted FROM connections WHERE id='legacy-con'").first("credentials_encrypted")).toBe("unchanged-ciphertext");
});
