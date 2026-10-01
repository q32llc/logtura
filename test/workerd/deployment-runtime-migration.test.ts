import { applyD1Migrations,env } from "cloudflare:test";
import { expect,it,inject } from "vitest";
import { hashConfigDocument } from "@logtura/core";
it("upgrades schema 21 while preserving existing deployment, revision and reporting state",async()=>{
  const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0022_deployment_runtime_environment.sql");expect(index).toBeGreaterThan(-1);await applyD1Migrations(env.DB,migrations.slice(0,index));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES ('legacy-user','legacy-github','legacy',1,1)"),
    env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES ('legacy-con','legacy-user','cloudflare-worker-tail','Existing','unchanged-ciphertext',1,1)"),
    env.DB.prepare(`INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,last_seen_at,source_selection_json,monitor_selection_json,metrics_target,metrics_snapshot_json,bundle_outdated,image_digest,metadata_json,created_at,updated_at)
      VALUES ('legacy-dep','legacy-user','legacy-con','fly','Existing forwarder',0,'running','legacy-report-token',123,'[]','[]','logtura','{"updatedAt":123}',0,'sha256:legacy','{"appName":"existing"}',1,1)`),
  ]);
  const document={kind:"logtura.deployment",schema_version:1,connections:[{connection:{id:"legacy-con",provider:"cloudflare-worker-tail",displayName:"Existing",externalAccountId:null},selectedSources:[],credentials:null}],monitors:[],runtimeEnv:null},revision=await hashConfigDocument(document);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO deployment_configuration_revisions(deployment_id,sequence,revision,document_json,configuration_version,created_at) VALUES ('legacy-dep',1,?,?,2,1)").bind(revision,JSON.stringify(document)),
    env.DB.prepare("INSERT INTO deployment_configuration_state(deployment_id,desired_sequence,applied_sequence,active_instance_id,last_report_sequence,applied_at) VALUES ('legacy-dep',1,1,'legacy-instance',4,1)"),
    env.DB.prepare("UPDATE deployment_configuration_revisions SET configuration_version=(SELECT version FROM configuration_versions WHERE user_id='legacy-user')"),
  ]);
  await env.DB.prepare("UPDATE deployments SET graph_selection_json=? WHERE id='legacy-dep'").bind(JSON.stringify({schema_version:1,connections:[{id:"legacy-con",sourceIds:[]}],monitors:[]})).run();
  const before=await env.DB.prepare("SELECT * FROM deployments WHERE id='legacy-dep'").first(),state=await env.DB.prepare("SELECT * FROM deployment_configuration_state").all(),history=await env.DB.prepare("SELECT * FROM deployment_configuration_revisions").all(),version=await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first();
  await applyD1Migrations(env.DB,[migrations[index]!]);
  expect(await env.DB.prepare("SELECT * FROM deployments WHERE id='legacy-dep'").first()).toEqual({...before,runtime_env_encrypted:null});expect((await env.DB.prepare("SELECT * FROM deployment_configuration_state").all()).results).toEqual(state.results);expect((await env.DB.prepare("SELECT * FROM deployment_configuration_revisions").all()).results).toEqual(history.results);expect(await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first()).toEqual(version);
  await env.DB.prepare("UPDATE deployments SET last_seen_at=456,status='crashed' WHERE id='legacy-dep'").run();expect(await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id='legacy-user'").first()).toEqual(version);
  expect(await env.DB.prepare("SELECT credentials_encrypted FROM connections WHERE id='legacy-con'").first("credentials_encrypted")).toBe("unchanged-ciphertext");
});
