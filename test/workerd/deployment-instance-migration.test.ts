import { applyD1Migrations,env } from "cloudflare:test";
import { expect,it,inject } from "vitest";
import { hashConfigDocument } from "@logtura/core";
it("adds instance receipts to schema 24 without changing existing forwarder, grant or desired/applied state",async()=>{
 const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0025_deployment_instance_receipts.sql");expect(index).toBeGreaterThan(-1);await applyD1Migrations(env.DB,migrations.slice(0,index));
 await env.DB.batch([
 env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES ('legacy-user','legacy-github','legacy',1,1)"),
 env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,credential_version,credentials_refresh_nonce,created_at,updated_at) VALUES ('legacy-con','legacy-user','cloudflare-worker-tail','Existing','unchanged-ciphertext','unchanged-intent','unchanged-refresh',1,1)"),
 env.DB.prepare(`INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,last_seen_at,source_selection_json,monitor_selection_json,metrics_target,metrics_snapshot_json,bundle_outdated,image_digest,metadata_json,runtime_env_encrypted,created_at,updated_at)
 VALUES ('legacy-dep','legacy-user','legacy-con','fly','Existing forwarder',0,'running','legacy-report-token',123,'[]','[]','logtura','{"updatedAt":123}',0,'sha256:legacy','{"appName":"existing"}','unchanged-runtime',1,1)`),
 ]);
 const document={kind:"logtura.deployment",schema_version:1,connections:[],monitors:[],runtimeEnv:null},revision=await hashConfigDocument(document);
 await env.DB.batch([
 env.DB.prepare("INSERT INTO deployment_configuration_revisions(deployment_id,sequence,revision,document_json,configuration_version,created_at) VALUES ('legacy-dep',1,?,?,2,1)").bind(revision,JSON.stringify(document)),
 env.DB.prepare("INSERT INTO deployment_configuration_state(deployment_id,desired_sequence,applied_sequence,active_instance_id,last_report_sequence,applied_at) VALUES ('legacy-dep',1,1,'legacy-instance',4,1)"),
 env.DB.prepare("UPDATE deployment_configuration_revisions SET configuration_version=(SELECT version FROM configuration_versions WHERE user_id='legacy-user')"),
 ]);
 const tables=["deployments","connections","deployment_configuration_state","deployment_configuration_revisions","configuration_versions"],before=await Promise.all(tables.map(table=>env.DB.prepare(`SELECT * FROM ${table}`).all()));
 await applyD1Migrations(env.DB,[migrations[index]!]);for(const [i,table] of tables.entries())expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toEqual(before[i]!.results);
 expect(await env.DB.prepare("SELECT COUNT(*) FROM deployment_instance_receipts").first("COUNT(*)")).toBe(0);
});
