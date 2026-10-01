import { env } from "cloudflare:test";
import { expect,it } from "vitest";
import { createSecretVersioner,type GenerateInput,parseDeploymentManifest } from "@logtura/core";
import { reconcileDeploymentConfiguration } from "../../src/deployment-reconciliation";
import { readDeploymentConfiguration,compileDeploymentRevision,issueDeploymentConfiguration } from "../../src/deployment-configuration";
import { readDeploymentRuntime } from "../../src/deployment-runtime";
import { readConfigurationVersion } from "../../src/config-version";
import { loadOwnedGraphInventory } from "../../src/graph-reconciliation";
import { createConnection,createDestination,createMonitor,createSink,createDeployment,upsertSources } from "../../src/db";
import { assembleDeploymentBundle } from "../../src/bundle-assembly";
import { encryptSecret } from "../../src/crypto";
import { seedUser,mockFetch } from "./_setup";
async function fixture(){
  const {userId}=await seedUser(),connection=await createConnection(env.DB,env,{userId,provider:"cloudflare-worker-tail",displayName:"Account",externalAccountId:"account",credentials:{apiToken:"private-token"}});
  await upsertSources(env.DB,connection.id,[{sourceKind:"cf_worker",externalId:"site",displayName:"Site",metadata:null}]);
  const destination=await createDestination(env.DB,env,{userId,kind:"webhook",displayName:"Alerts",config:{url:"https://private.test/hook"}}),monitor=await createMonitor(env.DB,{userId,connectionId:connection.id,displayName:"Errors",enabled:true,filterSteps:[{kind:"errors"}]}),sink=await createSink(env.DB,{monitorId:monitor.id,destinationId:destination.id,filterSteps:[]});
  const deployment=await createDeployment(env.DB,{userId,connectionId:connection.id,targetKind:"other",displayName:"Deployment",heartbeatTarget:"none"}),snapshot=await loadOwnedGraphInventory(env,userId);
  const desired:GenerateInput={providers:[],destinations:[],connections:snapshot.value.connections.map(c=>({...c,selectedSources:snapshot.value.sources.filter(s=>s.connectionId===c.connection.id).map(s=>s.source)})),monitors:[{monitor:snapshot.value.monitors[0]!,sinks:[{sink:snapshot.value.sinks[0]!.sink,destination:snapshot.value.destinations[0]!.destination,destinationConfig:snapshot.value.destinations[0]!.config}]}]};
  mockFetch("https://api.cloudflare.com",()=>Response.json({success:true,result:{status:"active"}}));
  return {userId,connection,destination,monitor,sink,deployment,desired,version:snapshot.version,versioner:await createSecretVersioner("private-version-key")};
}
it("commits inventory, ordered selections, reporting targets, private runtime and desired history as one graph",async()=>{
  const f=await fixture();f.desired.connections[0]!.connection.displayName="New account";f.desired.connections[0]!.selectedSources.push({id:"src_new",sourceKind:"cf_worker",externalId:"new-site",displayName:"New",metadata:null});f.desired.runtimeEnv={EXTRA_PRIVATE:"private-runtime"};f.desired.heartbeat={kind:"logtura",deploymentId:f.deployment.id,appUrl:env.APP_URL};f.desired.metrics={kind:"logtura",deploymentId:f.deployment.id,appUrl:env.APP_URL};
  const result=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner),state=await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id);
  expect(state).toMatchObject({desired:{sequence:1,revision:result.revision,document:result.document,configurationVersion:result.configurationVersion},stale:false,applied:null});expect(JSON.stringify(result)).not.toContain("private-runtime");expect(JSON.stringify(result)).not.toContain("private-token");
  const row=await env.DB.prepare("SELECT * FROM deployments WHERE id=?").bind(f.deployment.id).first<any>();expect(row.heartbeat_target).toBe("logtura");expect(row.metrics_target).toBe("logtura");expect(row.bundle_outdated).toBe(1);expect(await readDeploymentRuntime(env,row.runtime_env_encrypted)).toEqual({EXTRA_PRIVATE:"private-runtime"});
  const assembled=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(assembled.input.runtimeEnv!.EXTRA_PRIVATE).toBe("private-runtime");expect(assembled.input.connections[0]!.selectedSources).toHaveLength(2);
  const repeat=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,result.configurationVersion,1,f.desired,f.versioner);expect(repeat).toEqual(result);expect(await readConfigurationVersion(env.DB,f.userId)).toBe(result.configurationVersion);
  f.desired.runtimeEnv={};const cleared=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,result.configurationVersion,1,f.desired,f.versioner);expect(cleared.sequence).toBe(2);expect(await env.DB.prepare("SELECT runtime_env_encrypted FROM deployments WHERE id=?").bind(f.deployment.id).first("runtime_env_encrypted")).toBeNull();
});
it("reuses canonical source IDs and current report tokens, and creates a missing legacy token inside the transaction",async()=>{
  const f=await fixture(),id=f.desired.connections[0]!.selectedSources[0]!.id;f.desired.connections[0]!.selectedSources[0]!.id="src_cli";
  f.desired.runtimeEnv={LOGTURA_HEARTBEAT_TOKEN:f.deployment.heartbeat_token!,LOGTURA_METRICS_TOKEN:f.deployment.heartbeat_token!};
  const result=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner);expect(result.sourceAliases).toEqual({src_cli:id});expect(result.document.connections[0]!.selectedSources[0]!.id).toBe(id);
  await env.DB.prepare("UPDATE deployments SET heartbeat_token=NULL WHERE id=?").bind(f.deployment.id).run();delete f.desired.runtimeEnv;
  const next=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),1,f.desired,f.versioner);expect(next.sequence).toBe(2);expect(await env.DB.prepare("SELECT heartbeat_token FROM deployments WHERE id=?").bind(f.deployment.id).first("heartbeat_token")).toEqual(expect.any(String));
});
it("rolls back inventory, selection and runtime writes when a final history constraint fails",async()=>{
  const f=await fixture();await env.DB.prepare(`CREATE TRIGGER test_history_failure BEFORE INSERT ON deployment_configuration_revisions BEGIN SELECT RAISE(ABORT,'TEST_HISTORY_FAILURE'); END`).run();
  const before=await loadOwnedGraphInventory(env,f.userId),row=await env.DB.prepare("SELECT * FROM deployments WHERE id=?").bind(f.deployment.id).first();f.desired.connections[0]!.connection.displayName="Must roll back";f.desired.runtimeEnv={PRIVATE:"must-roll-back"};
  try{await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner)).rejects.toThrow("TEST_HISTORY_FAILURE");}finally{await env.DB.prepare("DROP TRIGGER test_history_failure").run();}
  expect(await loadOwnedGraphInventory(env,f.userId)).toEqual(before);expect(await env.DB.prepare("SELECT * FROM deployments WHERE id=?").bind(f.deployment.id).first()).toEqual(row);expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toBeNull();expect(await env.DB.prepare("SELECT count(*) AS n FROM configuration_write_guards").first("n")).toBe(0);
});
it("rejects collisions, stale graph/desired versions and wrong owners without a partial desired revision",async()=>{
  const f=await fixture(),other=await fixture();await expect(reconcileDeploymentConfiguration(env,other.userId,f.deployment.id,other.version,0,f.desired,f.versioner)).rejects.toThrow("Deployment not found");
  await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,1,f.desired,f.versioner)).rejects.toMatchObject({name:"DeploymentRevisionConflict"});
  f.desired.monitors[0]!.sinks.push({sink:{id:other.sink.id,filterSteps:[]},destination:f.desired.monitors[0]!.sinks[0]!.destination,destinationConfig:f.desired.monitors[0]!.sinks[0]!.destinationConfig});
  await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner)).rejects.toThrow();expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.version);expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toBeNull();
  f.desired.monitors[0]!.sinks.pop();const issued=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner);await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner)).rejects.toMatchObject({name:"ConfigurationConflict"});
  expect(parseDeploymentManifest(issued.document).missingEnv.length).toBeGreaterThan(0);
});
it("accepts exactly one simultaneous complete-graph writer",async()=>{
  const f=await fixture(),second=structuredClone(f.desired);second.connections[0]!.connection.displayName="Second";
  const results=await Promise.allSettled([f.desired,second].map(input=>reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,input,f.versioner)));expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);expect((await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id))!.desired.sequence).toBe(1);
});
it.each([null,[],false,{PRIVATE:1}])("sanitizes malformed encrypted runtime objects %#",async value=>{const encrypted=await encryptSecret(JSON.stringify(value),env.CREDENTIAL_ENCRYPTION_KEY);await expect(readDeploymentRuntime(env,encrypted.buffer as ArrayBuffer)).rejects.toThrow("Invalid stored deployment runtime environment");});
it("sanitizes broken runtime ciphertext and validates compiled revision sequences",async()=>{
  await expect(readDeploymentRuntime(env,new Uint8Array([1,2,3]).buffer)).rejects.toThrow("Invalid stored deployment runtime environment");expect(await readDeploymentRuntime(env,undefined)).toEqual({});
  const f=await fixture();for(const sequence of [-1,0,0.1,NaN,Infinity])await expect(compileDeploymentRevision(env.DB,f.userId,f.deployment.id,sequence,{ } as any)).rejects.toThrow("Invalid revision sequence");
  for(const sequence of [-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER])await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,sequence,f.desired,f.versioner)).rejects.toThrow("Invalid desired sequence");
});
it.each(["heartbeat","metrics","credential"])("rejects foreign reporting %s scope before writes",async kind=>{
  const f=await fixture();if(kind==="credential")f.desired.runtimeEnv={LOGTURA_HEARTBEAT_TOKEN:"foreign-private-token"};else f.desired[kind as "heartbeat"]={kind:"logtura",deploymentId:"other",appUrl:env.APP_URL};
  await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner)).rejects.toThrow("Invalid deployment reporting");expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.version);
});
it("validates registry capabilities/flows and rejects renderer broker values as storage credentials",async()=>{
  const f=await fixture();
  for(const mutate of [(i:GenerateInput)=>{i.connections[0]!.connection.id="con_unknown";i.connections[0]!.connection.provider="unknown";i.connections[0]!.selectedSources=[];i.monitors=[];},(i:GenerateInput)=>{i.connections[0]!.selectAll=true;},(i:GenerateInput)=>{i.monitors[0]!.sinks[0]!.destination.kind="datadog_metrics";},(i:GenerateInput)=>{i.monitors[0]!.sinks[0]!.destination.kind="unknown";},(i:GenerateInput)=>{i.metrics={kind:"destination",destination:{id:"dst_metrics",kind:"webhook",displayName:"Metrics"},destinationConfig:{url:"private"}};}]){const input=structuredClone(f.desired);mutate(input);await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,input,f.versioner)).rejects.toThrow();}
  for(const provider of ["supabase-edge-logs","railway-logs"]){const input=structuredClone(f.desired);input.connections[0]!.connection.id="con_broker";input.connections[0]!.connection.provider=provider;input.connections[0]!.selectedSources=[];input.monitors=[];input.connections[0]!.credentials={refreshToken:"raw",tailToken:"broker",apiToken:`${env.APP_URL}/api/tail/railway/token#broker`};await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,input,f.versioner)).rejects.toThrow("Resolve raw stored credentials");}
  expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.version);
});

it("retains supported metrics destinations and provider-native all-source selection",async()=>{
  const f=await fixture(),input=structuredClone(f.desired);input.connections[0]!.connection.id="con_supabase";input.connections[0]!.connection.provider="supabase-edge-logs";input.connections[0]!.connection.externalAccountId="project";input.connections[0]!.credentials={pat:"private-pat"};input.connections[0]!.selectedSources=[];input.connections[0]!.selectAll=true;input.monitors=[];input.metrics={kind:"destination",destination:{id:"dst_metrics",kind:"datadog_metrics",displayName:"Metrics"},destinationConfig:{apiKey:"private-datadog"}};
  const result=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,input,f.versioner);expect(result.sequence).toBe(1);const assembled=await assembleDeploymentBundle(env,f.userId,f.deployment.id);expect(assembled.input.connections[0]!.selectAll).toBe(true);expect(assembled.input.metrics).toMatchObject({kind:"destination",destination:{id:"dst_metrics"}});expect(assembled.bundle.vectorYaml).toContain("datadog_metrics");
});
it("rejects duplicate providers, unknown metrics destinations, foreign origins and runtime URL overrides",async()=>{
  const f=await fixture();
  for(const mutate of [(i:GenerateInput)=>{i.connections.push({...structuredClone(i.connections[0]!),connection:{...i.connections[0]!.connection,id:"con_second"},selectedSources:[]});},(i:GenerateInput)=>{i.metrics={kind:"destination",destination:{id:"dst_unknown",kind:"unknown",displayName:"Unknown"},destinationConfig:{}};},(i:GenerateInput)=>{i.heartbeat={kind:"logtura",deploymentId:f.deployment.id,appUrl:"https://foreign.test"};},(i:GenerateInput)=>{i.runtimeEnv={LOGTURA_HEARTBEAT_URL:"https://foreign.test/collect"};}]){const input=structuredClone(f.desired);mutate(input);await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,input,f.versioner)).rejects.toThrow();}
  expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.version);
});
it("rolls back and classifies final revision guard failures, preserving non-Error storage errors",async()=>{
  const f=await fixture();await env.DB.prepare("CREATE TRIGGER test_revision_failure BEFORE INSERT ON deployment_configuration_revisions BEGIN SELECT RAISE(ABORT,'LOGT_REVISION_CONFLICT'); END").run();
  try{await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner)).rejects.toMatchObject({name:"DeploymentRevisionConflict"});}finally{await env.DB.prepare("DROP TRIGGER test_revision_failure").run();}
  let calls=0;const db={prepare:(query:string)=>env.DB.prepare(query),batch:async(statements:D1PreparedStatement[])=>{if(++calls===2)throw "opaque storage failure";return env.DB.batch(statements);}} as unknown as D1Database;
  await expect(reconcileDeploymentConfiguration({...env,DB:db},f.userId,f.deployment.id,f.version,0,f.desired,f.versioner)).rejects.toBe("opaque storage failure");expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.version);
});
it("fails closed on version signing failures before any changes",async()=>{
  const f=await fixture();f.desired.connections[0]!.connection.displayName="Must not persist";await expect(reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,async()=>{throw new Error("Signer unavailable");})).rejects.toThrow("Signer unavailable");expect(await readConfigurationVersion(env.DB,f.userId)).toBe(f.version);expect(await readDeploymentConfiguration(env.DB,f.userId,f.deployment.id)).toBeNull();
});

it.each(["supabase-edge-logs","railway-logs"])("persists raw %s OAuth credentials while the runtime bridge remains derived",async provider=>{
  const f=await fixture(),input=structuredClone(f.desired);input.connections[0]!.connection.id=`con_${provider}_oauth`;input.connections[0]!.connection.provider=provider;input.connections[0]!.selectedSources=[];input.connections[0]!.selectAll=provider==="supabase-edge-logs";input.monitors=[];input.connections[0]!.credentials={apiToken:"raw-private-token",refreshToken:"raw-private-refresh"};
  const result=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,input,f.versioner);expect(result.sequence).toBe(1);expect((await loadOwnedGraphInventory(env,f.userId)).value.connections.find(c=>c.connection.id===input.connections[0]!.connection.id)!.credentials).toEqual(input.connections[0]!.credentials);
  const runtime=(await assembleDeploymentBundle(env,f.userId,f.deployment.id)).input.connections[0]!.credentials!;if(provider==="supabase-edge-logs")expect(runtime.tailToken).toEqual(expect.any(String));else expect(runtime.apiToken).toContain("/api/tail/railway/token#");
});
it("treats a rebased legacy null metrics target as the same disabled target without another write",async()=>{
  const f=await fixture(),first=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,f.version,0,f.desired,f.versioner);
  await env.DB.prepare("UPDATE deployments SET metrics_target=NULL WHERE id=?").bind(f.deployment.id).run();
  const reissued=await issueDeploymentConfiguration(env.DB,f.userId,f.deployment.id,await readConfigurationVersion(env.DB,f.userId),1,first.document);
  const repeat=await reconcileDeploymentConfiguration(env,f.userId,f.deployment.id,reissued.configurationVersion,2,f.desired,f.versioner);expect(repeat.sequence).toBe(2);expect(repeat.configurationVersion).toBe(reissued.configurationVersion);
});
