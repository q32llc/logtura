import {applyD1Migrations,env} from "cloudflare:test";
import {expect,it,inject} from "vitest";
import {exportDeploymentManifest,createSecretVersioner} from "@logtura/core";
import {createConnection,createDeployment} from "../../src/db";
import {issueDeploymentConfiguration,readDeploymentConfiguration} from "../../src/deployment-configuration";
import {readConfigurationVersion} from "../../src/config-version";
import {activateDeploymentWithReceipt} from "../../src/deployment-instances";
import {bindLinkedFlyReplacement,readFlyBindingReceipt} from "../../src/linked-fly-bindings";
import {seedUser} from "./_setup";
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

it("upgrades schema 33 with a real immutable binding receipt without changing retained state or identities",async()=>{
 const migrations=inject("migrations"),index=migrations.findIndex(m=>m.name==="0034_linked_fly_image_bindings.sql");expect(index).toBeGreaterThan(-1);
 await applyD1Migrations(env.DB,migrations.slice(0,index));
 const owner=await seedUser(),connection=await createConnection(env.DB,env,{userId:owner.userId,provider:"cloudflare-worker-tail",displayName:"Site",externalAccountId:"account",credentials:{apiToken:"private-source"}});
 const deployment=await createDeployment(env.DB,{userId:owner.userId,connectionId:connection.id,targetKind:"fly",displayName:"Forwarder"}),hash=(c:string)=>`sha256:${c.repeat(64)}`;
 await env.DB.prepare("UPDATE deployments SET external_id='fly:app:abc123',image_digest=?,metadata_json=? WHERE id=?").bind(hash("a"),JSON.stringify({appName:"app",region:"iad",orgSlug:"personal",private:"retained"}),deployment.id).run();
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner("private-version-key"));
 const issued=await issueDeploymentConfiguration(env.DB,owner.userId,deployment.id,await readConfigurationVersion(env.DB,owner.userId),0,exported.document);
 const activation=await activateDeploymentWithReceipt(env.DB,owner.userId,deployment.id,{requestId:crypto.randomUUID(),expectedConfigurationVersion:issued.configurationVersion,expectedSequence:issued.sequence,revision:issued.revision,expectedInstanceId:null});
 const request={requestId:crypto.randomUUID(),instanceId:activation.instanceId,expectedConfigurationVersion:issued.configurationVersion,expectedSequence:issued.sequence,revision:issued.revision,appName:"app",orgSlug:"personal",region:"iad",previousMachineId:"abc123",expectedImageDigest:hash("a"),previousImageDigest:hash("b"),previousConfigDigest:hash("c"),machineId:"def456",imageDigest:hash("d")};
 const receipt=await bindLinkedFlyReplacement(env.DB,owner.userId,deployment.id,request);
 const tables=["users","connections","deployments","configuration_versions","deployment_configuration_state","deployment_configuration_revisions","deployment_instance_receipts","linked_fly_binding_receipts","managed_installations","managed_checkpoints","managed_rollbacks","managed_cleanups"];
 const before=await Promise.all(tables.map(table=>env.DB.prepare(`SELECT * FROM ${table}`).all()));
 const state=await readDeploymentConfiguration(env.DB,owner.userId,deployment.id);
 await applyD1Migrations(env.DB,[migrations[index]!]);
 for(const [i,table] of tables.entries())expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toEqual(before[i]!.results);
 expect(await readDeploymentConfiguration(env.DB,owner.userId,deployment.id)).toEqual(state);
 expect(await readFlyBindingReceipt(env.DB,owner.userId,deployment.id,request.requestId)).toEqual(receipt);
 expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
