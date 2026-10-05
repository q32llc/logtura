import { env } from "cloudflare:test";
import { expect,it } from "vitest";
import { exportDeploymentManifest,createSecretVersioner } from "@logtura/core";
import { readDeploymentConfiguration,issueDeploymentConfiguration,activateDeploymentInstance,acknowledgeDeploymentConfiguration } from "../../src/deployment-configuration";
import { readConfigurationVersion } from "../../src/config-version";
import { createConnection,createDeployment } from "../../src/db";
import { seedUser } from "./_setup";
async function fixture(){
  const {userId}=await seedUser(),connection=await createConnection(env.DB,env,{userId,provider:"cloudflare-worker-tail",displayName:"Account",externalAccountId:"account",credentials:{apiToken:"private-token"}});
  const deployment=await createDeployment(env.DB,{userId,connectionId:connection.id,displayName:"Deployment",targetKind:"other"});
  const {document}=await exportDeploymentManifest({providers:[],destinations:[],connections:[{connection:{id:connection.id,provider:connection.provider,displayName:connection.display_name,externalAccountId:"account"},credentials:{apiToken:"private-token"},selectedSources:[]}],monitors:[]},await createSecretVersioner("private-key"));
  return {userId,connection,deployment,document,version:await readConfigurationVersion(env.DB,userId)};
}
it("preserves legacy rows, issues an owned public desired revision, and repeats it without writes",async()=>{
  const f=await fixture(),before=await env.DB.prepare("SELECT * FROM deployments WHERE id=?").bind(f.deployment.id).first();
  expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toBeNull();
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,"legacy",1,"unknown",1)).toBe(false);
  const issued=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,f.document);expect(issued.sequence).toBe(1);expect(issued.configurationVersion).toBe(f.version+1);
  const state=await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id);expect(state).toMatchObject({desired:{...issued,document:f.document},applied:null,activeInstanceId:null,lastReportSequence:0,stale:false});
  expect(JSON.stringify(state)).not.toContain("private-token");expect(JSON.stringify(state)).not.toContain("private-key");
  expect(await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,issued.configurationVersion,1,f.document)).toEqual(issued);
  expect(await readConfigurationVersion(env.DB,f.userId)).toBe(issued.configurationVersion);
  expect(await env.DB.prepare("SELECT * FROM deployments WHERE id=?").bind(f.deployment.id).first()).toEqual(before);
});
it("detects website edits and reissues the unchanged document against the new configuration base",async()=>{
  const f=await fixture(),first=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,f.document);
  await env.DB.prepare("UPDATE connections SET display_name='Website edit' WHERE id=?").bind(f.connection.id).run();
  expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.stale).toBe(true);
  await expect(issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,first.configurationVersion,1,f.document)).rejects.toMatchObject({name:"ConfigurationConflict"});
  const current=await readConfigurationVersion(env.DB,f.userId),second=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,current,1,f.document);expect(second.sequence).toBe(2);expect(second.revision).toBe(first.revision);expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.stale).toBe(false);
});
it("keeps desired and applied separate, rejects unknown/replayed/out-of-order reports and replaces instances",async()=>{
  const f=await fixture(),first=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,f.document);
  const instance=await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,first.configurationVersion,null);
  for(const args of [[instance,1,"unknown",1],["old-instance",1,first.revision,1],[instance,99,first.revision,1]] as const)expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,...args)).toBe(false);
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,1,first.revision,2)).toBe(true);
  for(const report of [1,2])expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,1,first.revision,report)).toBe(false);
  const applied=await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id);expect(applied!.applied).toMatchObject({sequence:1,revision:first.revision,at:expect.any(Number)});expect(applied!.lastReportSequence).toBe(2);
  const changed=structuredClone(f.document);changed.connections[0]!.connection.displayName="New desired";
  const second=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,first.configurationVersion,1,changed);expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.applied!.sequence).toBe(1);
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,2,second.revision,3)).toBe(true);
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,1,first.revision,4)).toBe(false);
  const replacement=await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,second.configurationVersion,instance);expect(replacement).not.toBe(instance);
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,2,second.revision,999)).toBe(false);
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,replacement,2,second.revision,1)).toBe(true);
  expect(await readConfigurationVersion(env.DB,f.userId)).toBe(second.configurationVersion);
});
it("rejects wrong owners, missing state, stale desired sequences and invalid sequence inputs",async()=>{
  const f=await fixture(),other=await seedUser();expect(await readDeploymentConfiguration(env.DB,other.userId,f.deployment.id)).toBeNull();
  await expect(issueDeploymentConfiguration(env.DB,other.userId,f.deployment.id,0,0,f.document)).rejects.toThrow("Deployment not found");
  await expect(activateDeploymentInstance(env.DB,other.userId,f.deployment.id,0,null)).rejects.toThrow("Deployment not found");
  await expect(activateDeploymentInstance(env.DB,f.userId,f.deployment.id,f.version,null)).rejects.toMatchObject({name:"DeploymentRevisionConflict"});
  for(const sequence of [-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER])await expect(issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,sequence,f.document)).rejects.toThrow("Invalid desired sequence");
  await expect(issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,1,f.document)).rejects.toMatchObject({name:"DeploymentRevisionConflict"});
  const issued=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,f.document);
  await expect(issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,issued.configurationVersion,0,f.document)).rejects.toMatchObject({name:"DeploymentRevisionConflict"});
  await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,issued.configurationVersion,null);
  await expect(activateDeploymentInstance(env.DB,f.userId,f.deployment.id,issued.configurationVersion,null)).rejects.toMatchObject({name:"DeploymentRevisionConflict"});
});
it.each([-1,0,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])("ignores invalid report and revision sequences (%s)",async sequence=>{
  expect(await acknowledgeDeploymentConfiguration(env.DB,"missing","instance",sequence,"unknown",1)).toBe(false);
  expect(await acknowledgeDeploymentConfiguration(env.DB,"missing","instance",1,"unknown",sequence)).toBe(false);
});
it("admits only one concurrent desired revision and leaves no orphan history or guards",async()=>{
  const f=await fixture(),changed=structuredClone(f.document);changed.connections[0]!.connection.displayName="Other";
  const results=await Promise.allSettled([f.document,changed].map(document=>issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,document)));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM deployment_configuration_revisions WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM configuration_write_guards").first("n")).toBe(0);
});
it("preserves immutable history, guards sequence increments, and cascades deletion",async()=>{
  const f=await fixture();await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,f.document);
  await expect(env.DB.prepare("UPDATE deployment_configuration_revisions SET revision='changed' WHERE deployment_id=?").bind(f.deployment.id).run()).rejects.toThrow("LOGT_REVISION_IMMUTABLE");
  await expect(env.DB.prepare("INSERT INTO deployment_configuration_revisions(deployment_id,sequence,revision,document_json,configuration_version,created_at) VALUES (?,99,'bad','{}',0,0)").bind(f.deployment.id).run()).rejects.toThrow("LOGT_REVISION_CONFLICT");
  await env.DB.prepare("DELETE FROM deployments WHERE id=?").bind(f.deployment.id).run();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM deployment_configuration_revisions WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(0);expect(await env.DB.prepare("SELECT count(*) AS n FROM deployment_configuration_state WHERE deployment_id=?").bind(f.deployment.id).first("n")).toBe(0);
});
it("rejects secret-bearing/invalid public documents before storing revisions",async()=>{
  const f=await fixture(),invalid={...f.document,secretValues:{PRIVATE:"must-not-store"}};
  await expect(issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,invalid)).rejects.toThrow();expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toBeNull();
});

it("classifies revision guard errors and preserves other storage failures",async()=>{
  const f=await fixture();
  for(const error of [new Error("D1_ERROR: LOGT_REVISION_CONFLICT"),new Error("storage unavailable"),"opaque storage failure"]){
    const db={prepare:(query:string)=>env.DB.prepare(query),batch:async()=>{throw error;}} as unknown as D1Database;
    const result=issueDeploymentConfiguration(db,f.userId,f.deployment.id,f.version,0,f.document);
    if(error instanceof Error && error.message.includes("LOGT_REVISION_CONFLICT"))await expect(result).rejects.toMatchObject({name:"DeploymentRevisionConflict"});
    else await expect(result).rejects.toBe(error);
  }
  expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toBeNull();
});
it("rejects acknowledgements of history that has not become desired state",async()=>{
  const f=await fixture(),first=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,f.document),instance=await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,first.configurationVersion,null);
  await env.DB.prepare("INSERT INTO deployment_configuration_revisions(deployment_id,sequence,revision,document_json,configuration_version,created_at) VALUES (?,2,'pending',?,0,0)").bind(f.deployment.id,JSON.stringify(f.document)).run();
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,2,"pending",1)).toBe(false);
});

it("clears the legacy outdated warning only with an accepted current loaded manifest",async()=>{
  const f=await fixture(),first=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,f.document);
  const instance=await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,first.configurationVersion,null);
  const mark=()=>env.DB.prepare("UPDATE deployments SET bundle_outdated=1 WHERE id=?").bind(f.deployment.id).run();
  const outdated=()=>env.DB.prepare("SELECT bundle_outdated FROM deployments WHERE id=?").bind(f.deployment.id).first("bundle_outdated");
  await mark();
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,"wrong-instance",1,first.revision,1)).toBe(false);expect(await outdated()).toBe(1);
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,1,first.revision,1)).toBe(true);expect(await outdated()).toBe(0);
  expect(await readConfigurationVersion(env.DB,f.userId)).toBe(first.configurationVersion);
  await mark();
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,1,first.revision,1)).toBe(false);expect(await outdated()).toBe(1);
  await env.DB.prepare("UPDATE connections SET display_name='Website edit' WHERE id=?").bind(f.connection.id).run();
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,1,first.revision,2)).toBe(true);expect(await outdated()).toBe(1);
  const second=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),1,f.document);
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,1,first.revision,3)).toBe(true);expect(await outdated()).toBe(1);
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,2,second.revision,4)).toBe(true);expect(await outdated()).toBe(0);
});
it("leaves managed deployment acceptance to the job even after a current report",async()=>{
  const f=await fixture(),issued=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,f.version,0,f.document);
  const instance=await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,issued.configurationVersion,null);
  await env.DB.prepare("UPDATE deployments SET managed=1,bundle_outdated=1 WHERE id=?").bind(f.deployment.id).run();
  expect(await acknowledgeDeploymentConfiguration(env.DB,f.deployment.id,instance,1,issued.revision,1)).toBe(true);
  expect(await env.DB.prepare("SELECT bundle_outdated FROM deployments WHERE id=?").bind(f.deployment.id).first("bundle_outdated")).toBe(1);
});
