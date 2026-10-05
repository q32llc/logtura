import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { integrity, inventory, checkTag } from './release-artifacts.mjs';
import { normalizePackedArchives } from './normalize-packed.mjs';
import { downloadRegistryArchives } from './registry-artifacts.mjs';

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "logtura-packed-"));
const artifacts = join(temporary, "artifacts");
const consumer = join(temporary, "consumer");
mkdirSync(artifacts); mkdirSync(consumer);
function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", ...extra }, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const packages = readdirSync(join(root, "packages")).filter((name) => {
    try { return JSON.parse(readFileSync(join(root, "packages", name, "package.json"))).name.startsWith("@logtura/"); } catch { return false; }
  });
  const registryManifest=process.env.LOGT_PACKED_REGISTRY_MANIFEST;
  if(registryManifest){
    assert.ok(!process.env.LOGT_PACKED_ARTIFACTS,'Registry verification must not export a new release manifest');
    const receipt=await downloadRegistryArchives(resolve(registryManifest),inventory(root),artifacts);
    console.log(`Downloaded ${receipt.packages.length} registry archives matching the tested release`);
  }else for (const name of packages) run("pnpm", ["pack", "--pack-destination", artifacts], join(root, "packages", name));
  const archives = readdirSync(artifacts).filter((name) => name.endsWith(".tgz")).map((name) => join(artifacts, name));
  assert.equal(archives.length, packages.length, "every package must produce a tarball");
  // pnpm resolves workspace ranges using workspace traversal order. That can
  // shuffle dependency JSON keys between identical checkouts. Normalize only
  // unordered dependency maps; preserve conditional exports' significant order.
  // Consumers below validate the final archives that will actually be published.
  if(!registryManifest)await normalizePackedArchives(archives,temporary,artifacts,(program,args,cwd)=>run(program,args,cwd??root));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...archives], consumer);
  // Typecheck the installed tarballs with their declarations, without skipLibCheck.
  const typesFile = join(consumer, "consumer.mts");
  writeFileSync(typesFile, packages.map((name, index) => `import * as package${index} from '@logtura/${name}';`).join("\n") + `
    import {type GenerateInput, type DeploymentInstanceReceipt, LogturaServiceClient, FlyMachinesClient, buildFlyRuntimeConfig, flyBundleFiles, resolveFlyImage, selfDeployFiles, runtimeAssetFiles, renderDockerRunCommand, validateFilterSteps, type FilterStep, type FlyReplacementCleanupState, type FlyReplacementCleanupStore, planFlyReplacementCleanup, executeFlyReplacementCleanup} from '@logtura/core';
    import {type PendingActivation, type PendingFlyApply, activateLinkedDeployment, PrivateFlyReplacementStore, readPrivateFlyReplacement,rollbackLinkedFlyDeployment,readPendingFlyRollback,type PendingFlyRollback,cleanupLinkedFlyDeployment,readPendingFlyCleanup,PrivateFlyCleanupStore,type PendingFlyCleanup} from '@logtura/cli';
    import {type FlyReplacementStore,type FlyReplacementState} from '@logtura/core';
    import {type FlyRollbackRequest,type FlyRollbackReceipt,type FlyRollbackRebaseRequest,type FlyRollbackRebaseReceipt,validateFlyRollbackFence} from '@logtura/core';
    const rollbackClient = new LogturaServiceClient({url:'https://service.fixture',fetch});
    import {type DeploymentCreationRequest,type DeploymentCreationReceipt,validateDeploymentCreationRequest} from '@logtura/core';
    import {createLinkedDeployment,readPendingDeploymentCreation,type PendingDeploymentCreation} from '@logtura/cli';
    const typedCreate:(request:DeploymentCreationRequest)=>Promise<DeploymentCreationReceipt> = rollbackClient.createDeployment.bind(rollbackClient);
    const typedCreationLookup:(requestId:string)=>Promise<DeploymentCreationReceipt|null> = rollbackClient.getDeploymentCreation.bind(rollbackClient);
    const typedCreationJournal:PendingDeploymentCreation|null = readPendingDeploymentCreation('config.yaml');
    const typedLinkedCreation:typeof createLinkedDeployment = createLinkedDeployment;
    // @ts-expect-error Creation retains complete owner intent, including explicit source and monitor selection.
    rollbackClient.createDeployment({connectionId:'con',displayName:'Name'});
    // @ts-expect-error Private recovery retains its request, origin, owner and receipt.
    const invalidCreationJournal:PendingDeploymentCreation = {schemaVersion:1};
    void typedCreate;void typedCreationLookup;void typedCreationJournal;void typedLinkedCreation;void invalidCreationJournal;void validateDeploymentCreationRequest;

    import {type FlyCleanupRequest,type FlyCleanupReceipt,type FlyCleanupRebaseReceipt} from '@logtura/core';
    const typedCleanupPrepare:(id:string,input:FlyCleanupRequest)=>Promise<FlyCleanupReceipt> = rollbackClient.prepareFlyCleanup.bind(rollbackClient);
    const typedCleanupComplete:(id:string,requestId:string)=>Promise<FlyCleanupReceipt> = rollbackClient.completeFlyCleanup.bind(rollbackClient);
    const typedCleanupRebase:(id:string,cleanupId:string,input:FlyRollbackRebaseRequest)=>Promise<FlyCleanupRebaseReceipt> = rollbackClient.rebaseFlyCleanup.bind(rollbackClient);
    // @ts-expect-error Cleanup requires retained identity, hashes and current owner graph fences.
    rollbackClient.prepareFlyCleanup('dep',{requestId:'request'});
    void typedCleanupPrepare;void typedCleanupComplete;void typedCleanupRebase;
    const typedRollbackPrepare:(id:string,input:FlyRollbackRequest)=>Promise<FlyRollbackReceipt> = rollbackClient.prepareFlyRollback.bind(rollbackClient);
    const typedRollbackComplete:(id:string,requestId:string)=>Promise<FlyRollbackReceipt> = rollbackClient.completeFlyRollback.bind(rollbackClient);
    const typedRollbackRebase:(id:string,rollbackId:string,input:FlyRollbackRebaseRequest)=>Promise<FlyRollbackRebaseReceipt> = rollbackClient.rebaseFlyRollback.bind(rollbackClient);
    // @ts-expect-error Rollback fences require the manifest revision.
    rollbackClient.rebaseFlyRollback('dep','rollback',{requestId:'request',configurationVersion:1,sequence:1});
    void typedRollbackPrepare;void typedRollbackComplete;void typedRollbackRebase;
    const typedLinkedRollback:typeof rollbackLinkedFlyDeployment = rollbackLinkedFlyDeployment;
    const typedPrivateRollback:Promise<PendingFlyRollback|null> = readPendingFlyRollback('config.yaml');
    // @ts-expect-error Rollback handoff requires an explicitly authenticated provider client.
    rollbackLinkedFlyDeployment(rollbackClient,'config.yaml',{});
    void typedLinkedRollback;void typedPrivateRollback;
    const typedLinkedCleanup:typeof cleanupLinkedFlyDeployment = cleanupLinkedFlyDeployment;
    const typedPrivateCleanup:Promise<PendingFlyCleanup|null> = readPendingFlyCleanup('config.yaml');
    const typedPrivateCleanupStore:FlyReplacementCleanupStore = new PrivateFlyCleanupStore('config.yaml');
    // @ts-expect-error Cleanup requires an explicitly authenticated provider client.
    cleanupLinkedFlyDeployment(rollbackClient,'config.yaml',{});
    // @ts-expect-error Private cleanup retains the complete owner intent and provider proof.
    const invalidPrivateCleanup:PendingFlyCleanup = {schemaVersion:1};
    void typedLinkedCleanup;void typedPrivateCleanup;void typedPrivateCleanupStore;void invalidPrivateCleanup;
    const typedReplacementStore:FlyReplacementStore = new PrivateFlyReplacementStore('config.yaml');
    const typedReplacementState:FlyReplacementState|null = readPrivateFlyReplacement('config.yaml');
    void typedReplacementStore;void typedReplacementState;
    const typedCleanup:(store:FlyReplacementCleanupStore,client:FlyMachinesClient,options:{assertCurrent:()=>Promise<void>})=>Promise<FlyReplacementCleanupState> = executeFlyReplacementCleanup;
    // @ts-expect-error Cleanup requires both complete provider snapshots and a terminal journal.
    planFlyReplacementCleanup({machines:[]});
    // @ts-expect-error The native transport cannot force destruction or omit its lease nonce.
    new FlyMachinesClient({token:'fixture'}).destroy('app','machine');
    void typedCleanup;
    const validatedFilters:FilterStep[] = validateFilterSteps([{kind:"errors"}]);
    // @ts-expect-error The filter parser returns a typed array, never any.
    const invalidFilters:string = validateFilterSteps([]);
    void validatedFilters;void invalidFilters;
    const typedActivation: (client:LogturaServiceClient,config:string,options?:{resume?:boolean})=>Promise<DeploymentInstanceReceipt> = activateLinkedDeployment;
    // @ts-expect-error Config fields remain required; these exports must not become any.
    const invalidInput:GenerateInput = {};
    // @ts-expect-error Private journal fields remain required.
    const invalidPending:PendingActivation = {schemaVersion:1};
    // @ts-expect-error Apply intent retains its required private fields.
    const invalidApply:PendingFlyApply = {schemaVersion:1};
    // @ts-expect-error Generated bundle fields remain required.
    flyBundleFiles({});
    // @ts-expect-error Generic contexts retain the complete bundle type.
    selfDeployFiles({});
    // @ts-expect-error Asset modes retain their number type.
    runtimeAssetFiles([{driverId:'fixture',path:'helper',content:'text',mode:'755'}]);
    // @ts-expect-error Environment values remain required, even when null.
    renderDockerRunCommand([{name:'TOKEN'}]);
    // @ts-expect-error Registry tokens retain their string type.
    resolveFlyImage('registry.test/image@sha256:'+'a'.repeat(64),{token:1});
    // @ts-expect-error Discharged provider authorization only supports its two schemes.
    new FlyMachinesClient({token:'fixture',authorizationScheme:'Basic'});
    // @ts-expect-error Machine creation retains its required immutable configuration.
    new FlyMachinesClient({token:'fixture'}).create('app',{name:'forwarder',region:'ord'});
    // @ts-expect-error Volume provisioning requires explicit compute placement.
    new FlyMachinesClient({token:'fixture'}).createVolume('app',{name:'checkpoint',region:'ord',sizeGb:1});
    // @ts-expect-error Creation configuration still requires a verified runtime artifact.
    buildFlyRuntimeConfig({base:{image:'fixture'},volume:'vol_checkpoint',image:'fixture'});
    void invalidApply;void typedActivation;void invalidInput;void invalidPending;
  `);
  for (const [module, resolution] of [["NodeNext", "NodeNext"], ["Node16", "Node16"], ["ESNext", "Bundler"]]) {
    run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", module,
      "--moduleResolution", resolution, "--target", "ES2022", typesFile], consumer);
  }
  const guard = join(consumer, "deny-network.mjs");
  writeFileSync(guard, "globalThis.fetch = () => { throw new Error('Network access denied in standalone consumer smoke'); };\n");
  const offline = { NODE_OPTIONS: `--import=${pathToFileURL(guard)}`, LOGT_AUTH_FILE: join(consumer, "account.json"), LOGT_SERVICE_TOKEN: "", LOGT_SERVICE_URL: "https://fixture.test" };
  const bin = (alias, args) => run(join(consumer, "node_modules", ".bin", alias), args, consumer, offline);
  assert.match(bin("logt", ["--help"]), /logt/);
  assert.match(bin("logtura", ["--help"]), /logt/);
  assert.match(bin("logt-forwarder", ["--help"]), /private.*artifact|artifact.*private/);
  const anonymous = spawnSync(join(consumer, "node_modules", ".bin", "logt"), ["whoami"], {cwd: consumer, encoding: "utf8", env: {...process.env, ...offline}});
  assert.equal(anonymous.status, 1);
  assert.match(anonymous.stderr, /Sign in first/);
  bin("logtura", ["logout", "--local"]);
  bin("logt", ["init"]); bin("logt", ["init"]);
  assert.match(readFileSync(join(consumer, "logt.yaml"), "utf8"), /providers:/);
  writeFileSync(join(consumer, "logt.yaml"), `providers:
  fixture:
    provider: cloudflare
    account_id: fixture-account
    credentials: {api_token: fixture-token}
sources:
  workers:
    source: cloudflare-worker-tail
    provider: fixture
    scripts: [fixture-worker]
sinks: {}
monitors: []
`);
  bin("logt", ["validate"]);
  const revision = bin("logt", ["config", "hash"]).trim();
  assert.match(revision, /^sha256:[a-f0-9]{64}$/);
  bin("logtura", ["config", "normalize", "--output", "portable.yaml"]);
  assert.equal(bin("logt", ["--config", "portable.yaml", "config", "hash"]).trim(), revision);
  assert.match(readFileSync(join(consumer, "portable.yaml"), "utf8"), /schema_version: 1/);
  bin("logt", ["bundle", "--output", "bundle with spaces"]);
  const yaml = readFileSync(join(consumer, "bundle with spaces", "vector.yaml"), "utf8");
  assert.ok(!yaml.includes("/api/heartbeat/"), "standalone bundle must not require hosted heartbeat");
  assert.ok(!yaml.includes("/api/metrics/"), "standalone bundle must not require hosted metrics");
  const metricEvents=[{name:"vector_component_sent_events_total",timestamp:"2026-10-01T00:00:00Z",tags:{component_id:"packed_sink",component_kind:"sink",component_type:"http"},counter:{value:7}}];
  writeFileSync(join(consumer,"metrics file.json"),JSON.stringify(metricEvents));
  writeFileSync(join(consumer,"metrics file.ndjson"),metricEvents.map(event=>JSON.stringify(event)).join("\n"));
  const stats=bin("logt",["stats","--metrics","metrics file.json"]);
  assert.equal(bin("logtura",["stats","metrics file.ndjson"]),stats);
  assert.match(stats,/packed_sink\tsink\thttp\t-\t7\t-/);
  const script = `import assert from 'node:assert/strict';
    import {selfDeployFiles,flySelfDeployFiles,runtimeAssetFiles,renderDockerRunCommand,parseMetricsBody,applyMetricsToSnapshot,rateFor,buildFlyRuntimeConfig,flyBundleFiles,resolveFlyImage,GENERATOR_VERSION,compileForwarderRuntime,verifyLoadedForwarder,reportLoadedForwarder,generateBundle,installBundleFiles,buildTar,exportDeploymentManifest,createSecretVersioner,parseDeploymentManifest,hashConfigDocument,editDeploymentManifest,diffDeploymentManifests,planDeploymentChanges,resolveDeploymentDiscovery,validateDeploymentInput,validateFilterSteps,FlyMachinesClient,LogturaServiceClient, DeploymentReportingClient,manifestSecretName,isDeploymentPushRequestId,validateDeploymentConfigCommit,planFlyReplacement,planFlyReplacementCleanup,validateFlyReplacementCleanupState,executeFlyReplacementCleanup} from '@logtura/core';
    import {writeFileSync,readFileSync,statSync,mkdirSync} from 'node:fs';
    import {main,applyLinkedFlyDeployment,readPendingFlyApply,activateLinkedDeployment,readPendingActivation,finishLinkedActivation,reportLoadedForwarderFile,runForwarderReporting,PrivateFlyReplacementStore,readPrivateFlyReplacement} from '@logtura/cli';
    import {cloudflareWorkerTailDriver} from '@logtura/driver-cloudflare-worker-tail';
    const metrics=applyMetricsToSnapshot(null,parseMetricsBody(readFileSync('metrics file.ndjson','utf8')));assert.equal(metrics.byComponent.packed_sink.sent,7);assert.equal(rateFor(metrics.byComponent.packed_sink,'sent'),null);
    const largeMetric={kind:'source',type:'exec',sent:1e308,lastSeen:60000,prev:{sent:0,sampleAt:0}};
    assert.equal(rateFor(largeMetric,'sent'),1e308);
    assert.equal(rateFor({...largeMetric,lastSeen:1},'sent'),null);
    assert.equal(rateFor({...largeMetric,sent:NaN},'sent'),null);
    const cleanupImage='registry.test/new@sha256:'+'a'.repeat(64);
    const cleanupBefore={id:'cleanup-old',name:'forwarder',instance_id:'old-version',state:'started',region:'ord',config:{image:'registry.test/old:latest',env:{PRIVATE:'retained'}},image_ref:{registry:'registry.test',repository:'old',digest:'sha256:'+'b'.repeat(64)}};
    const cleanupPlan=planFlyReplacement({id:'00000000-0000-4000-8000-000000000001',app:'cleanup-app',org:'personal',machine:cleanupBefore,volume:'vol_cleanup',volumes:[{id:'vol_cleanup',region:'ord',state:'created',encrypted:true,attached_machine_id:null}],config:{image:cleanupImage,mounts:[{path:'/var/lib/logtura',volume:'vol_cleanup'}]}});
    mkdirSync('private-replacement',{mode:0o700});
    const replacementConfig='private-replacement/logt.yaml',privateStore=new PrivateFlyReplacementStore(replacementConfig);
    assert.equal(readPrivateFlyReplacement(replacementConfig),null);await privateStore.prepare({plan:cleanupPlan,phase:'prepared',machineId:null});
    assert.equal(statSync('private-replacement/.logtura-replacement.json').mode&0o777,0o600);
    await privateStore.runExclusive(async tx=>{for(const [phase,machineId] of [['creating',null],['created','cleanup-new'],['switching','cleanup-new'],['installed','cleanup-new']]){const before=await tx.read();assert.equal(await tx.compareAndSwap(before,{...before,phase,machineId}),true);}});
    const privateState=readPrivateFlyReplacement(replacementConfig);assert.equal(privateState.phase,'installed');let archiveChecks=0;
    const replacementArchive=await privateStore.archive(privateState,async()=>{archiveChecks++;});assert.equal(archiveChecks,2);assert.equal(readPrivateFlyReplacement(replacementConfig),null);assert.equal(statSync(replacementArchive).mode&0o777,0o600);assert.deepEqual(JSON.parse(readFileSync(replacementArchive,'utf8')).state,privateState);
    let cleanupMachines=[{...cleanupBefore,state:'stopped'},{id:'cleanup-new',name:cleanupPlan.name,instance_id:'new-version',state:'started',region:'ord',config:cleanupPlan.after,image_ref:{registry:'registry.test',repository:'new',digest:'sha256:'+'a'.repeat(64)}}];
    let cleanupJournal={plan:planFlyReplacementCleanup({replacement:{plan:cleanupPlan,phase:'installed',machineId:'cleanup-new'},machines:cleanupMachines}),phase:'prepared'},cleanupDeletes=0;
    const cleanupClient=new FlyMachinesClient({token:'private',fetch:async(url,request)=>{
      const path=new URL(url).pathname;assert.equal(new URL(url).origin,'https://api.machines.dev');
      if(path.endsWith('/lease'))return request.method==='DELETE'?new Response(null,{status:204}):Response.json({data:{nonce:'private-lease'}});
      if(path.endsWith('/volumes'))return Response.json([{id:'vol_cleanup',region:'ord',state:'created',encrypted:true,attached_machine_id:'cleanup-new'}]);
      if(path.endsWith('/machines'))return Response.json(cleanupMachines);
      if(request.method==='DELETE'){assert.equal(path,'/v1/apps/cleanup-app/machines/cleanup-old');assert.equal(new URL(url).search,'');assert.equal(cleanupJournal.phase,'deleting');assert.equal(request.headers['fly-machine-lease-nonce'],'private-lease');cleanupMachines=cleanupMachines.filter(m=>m.id!=='cleanup-old');cleanupDeletes++;return new Response(null,{status:204});}
      return Response.json({name:'cleanup-app',organization:{slug:'personal'}});
    }});
    const cleanupStore={async runExclusive(operation){return operation({read:async()=>structuredClone(cleanupJournal),compareAndSwap:async(expected,next)=>{assert.deepEqual(cleanupJournal,expected);cleanupJournal=structuredClone(next);return true;}});}};
    assert.equal((await executeFlyReplacementCleanup(cleanupStore,cleanupClient,{assertCurrent:async()=>{}})).phase,'deleted');
    assert.equal(validateFlyReplacementCleanupState(cleanupJournal).phase,'deleted');
    await executeFlyReplacementCleanup(cleanupStore,cleanupClient,{assertCurrent:async()=>{}});assert.equal(cleanupDeletes,1);assert.equal(cleanupMachines[0].id,'cleanup-new');
    const input={providers:[cloudflareWorkerTailDriver],destinations:[],monitors:[],
      connections:[{connection:{id:'fixture',provider:cloudflareWorkerTailDriver.id,displayName:'Fixture',externalAccountId:'fixture-account'},
        selectedSources:[{id:'worker',externalId:'fixture-worker',displayName:'fixture-worker',sourceKind:'worker',metadata:null}],credentials:{apiToken:'fixture-token'}}]};
    const bundle=generateBundle(input);
    validateDeploymentInput(input);
    assert.deepEqual(validateFilterSteps([{kind:"errors"}]),[{kind:"errors"}]);
    assert.throws(()=>validateFilterSteps([{kind:"errors",private:"fixture-private-filter"}]),/unknown field/);
    const plan=planDeploymentChanges({connections:[],sources:[],destinations:[],monitors:[],sinks:[]},input);
    assert.equal(plan.connections[0].connection.id,'fixture');
    assert.equal(plan.sources[0].source.id,'worker');
    assert.deepEqual(generateBundle(plan.input),bundle);
    const discovery=resolveDeploymentDiscovery({connections:[],sources:[{connectionId:'fixture',source:{id:'newly_discovered',externalId:'future-worker',displayName:'Future',sourceKind:'worker',metadata:null}}],destinations:[],monitors:[],sinks:[]},{...input,discoverMonitors:true,connections:input.connections.map(c=>({...c,discoverSources:true}))});
    assert.equal(discovery.connections[0].selectedSources[1].id,'newly_discovered');
    assert.equal(discovery.connections[0].discoverSources,true);
    assert.equal(discovery.discoverMonitors,true);
    assert.ok(generateBundle(discovery).vectorYaml.includes('future-worker'));
    const exported=await exportDeploymentManifest(input,await createSecretVersioner('private-fixture-key'));
    assert.ok(!JSON.stringify(exported.document).includes('fixture-token'));
    const savedFetch=globalThis.fetch,savedToken=process.env.LOGT_SERVICE_TOKEN;
    process.env.LOGT_SERVICE_TOKEN='lt_cli_'+'T'.repeat(43);
    let hostedCurrent={...exported,configurationVersion:3,desiredSequence:0,revision:await hashConfigDocument(exported.document),deployment:{id:'dep_fixture',displayName:'Existing'},target:{kind:'fly',managed:false,imageDigest:null,fly:{appName:'existing-packed-forwarder',region:'ord'}}},hostedReceipt=null,writes=0;
    globalThis.fetch=async(url,init)=>{
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer lt_cli_'+'T'.repeat(43));
      if(url==='https://fixture.test/api/me')return Response.json({user:{id:'usr_fixture',githubLogin:'fixture'}});
      if(url.includes('/config/receipts/'))return hostedReceipt?Response.json(hostedReceipt):Response.json({error:'receipt_not_found'},{status:404});
      if(init.method==='PUT'){
        writes++;const body=JSON.parse(init.body);assert.equal(body.expectedConfigurationVersion,3);assert.equal(body.expectedSequence,0);assert.equal(body.secretValues,undefined);
        const result={configurationVersion:4,sequence:1,document:body.document,revision:await hashConfigDocument(body.document),sourceAliases:{}};
        hostedReceipt={requestId:body.requestId,result};hostedCurrent={...hostedCurrent,...result,desiredSequence:1};
        throw new Error('packed fixture dropped the committed response');
      }
      assert.equal(url,'https://fixture.test/api/deployments/dep_fixture/config?includeSecrets=1');return Response.json(hostedCurrent);
    };
    try{
      assert.equal(await main(['pull','dep_fixture','--service','https://fixture.test','-o','linked/logt.yaml']),0);
      assert.equal(await main(['-c','linked/logt.yaml','source','select','fixture','pushed-site','--id','src_pushed']),0);
      assert.equal(await main(['-c','linked/logt.yaml','push']),1);
      assert.equal(statSync('linked/.logtura-push.json').mode&0o777,0o600);
      assert.equal(await main(['-c','linked/logt.yaml','push','--resume']),0);assert.equal(writes,1);
    }finally{globalThis.fetch=savedFetch;process.env.LOGT_SERVICE_TOKEN=savedToken;}
    const linked=JSON.parse(readFileSync('linked/logt.yaml.logtura-link.json','utf8'));
    assert.equal(linked.accountId,'usr_fixture');assert.equal(linked.configurationVersion,4);assert.equal(linked.desiredSequence,1);
    assert.equal(statSync('linked/logt.yaml.logtura-link.json').mode&0o777,0o600);
    assert.ok(!JSON.stringify(linked).includes('fixture-token'));

    let issuedReceipt=null,instanceWrites=0;
    const issuedState={desired:{sequence:linked.desiredSequence,revision:linked.revision,document:linked.document,configurationVersion:linked.configurationVersion},applied:null,activeInstanceId:null,lastReportSequence:0,stale:true};
    const issuer=new LogturaServiceClient({url:linked.service,token:'lt_cli_'+'T'.repeat(43),fetch:async(url,init)=>{
      if(url.endsWith('/me'))return Response.json({user:{id:linked.accountId,githubLogin:'fixture'}});
      if(url.endsWith('/state'))return Response.json({state:issuedState});
      if(init.method==='POST'){
        instanceWrites++;const request=JSON.parse(init.body);
        issuedReceipt={requestId:request.requestId,instanceId:'00000000-0000-4000-8000-000000000003',configurationVersion:linked.configurationVersion,sequence:linked.desiredSequence,revision:linked.revision};
        issuedState.activeInstanceId=issuedReceipt.instanceId;
        throw new TypeError('packed fixture lost activation acknowledgement');
      }
      return issuedReceipt?Response.json(issuedReceipt):Response.json({error:'receipt_not_found'},{status:404});
    }});
    await assert.rejects(activateLinkedDeployment(issuer,'linked/logt.yaml'),/lost activation/);
    assert.equal((await readPendingActivation('linked/logt.yaml')).receipt,null);
    const recoveredInstance=await activateLinkedDeployment(issuer,'linked/logt.yaml',{resume:true});
    assert.deepEqual(recoveredInstance,issuedReceipt);assert.equal(instanceWrites,1);
    assert.equal(statSync('linked/.logtura-activation.json').mode&0o777,0o600);
    assert.ok(!readFileSync('linked/.logtura-activation.json','utf8').includes('fixture-token'));
    await assert.rejects(finishLinkedActivation(issuer,'linked/logt.yaml'),/not acknowledged/);
    const linkedRuntime=await compileForwarderRuntime({service:linked.service,deploymentId:linked.deployment.id,document:linked.document,instance:recoveredInstance,env:exported.secretValues,providers:input.providers,destinations:input.destinations});
    const linkedObservation={files:{'vector.yaml':linkedRuntime.bundle.vectorYaml,...Object.fromEntries(linkedRuntime.bundle.runtimeAssets.map(asset=>['assets/'+asset.driverId+'/'+asset.path,asset.content]))},environment:Object.fromEntries(linkedRuntime.bundle.envVars.map(v=>[v.name,v.value])),generatorVersion:GENERATOR_VERSION,vectorVersion:'0.55.0',ready:true};
    await reportLoadedForwarderFile({checkpoint:'linked/runtime-checkpoint.json',artifact:linkedRuntime.artifact,observed:linkedObservation,report:async(report)=>{
      assert.equal(report.instanceId,recoveredInstance.instanceId);assert.equal(report.reportSequence,1);
      issuedState.applied={sequence:report.sequence,revision:report.revision,at:Date.now()};issuedState.lastReportSequence=1;issuedState.stale=false;return true;
    }});
    await finishLinkedActivation(issuer,'linked/logt.yaml');assert.equal(await readPendingActivation('linked/logt.yaml'),null);

    // Installed-shape linked apply exercises the same public backend operations.
    const applyExport=await exportDeploymentManifest({...input,heartbeat:{kind:'logtura',deploymentId:'dep_apply',appUrl:'https://apply.test'},runtimeEnv:{LOGTURA_HEARTBEAT_TOKEN:'private-report-fixture'}},await createSecretVersioner('apply-private'));
    const applyRevision=await hashConfigDocument(applyExport.document),applyResult={...applyExport,revision:applyRevision,configurationVersion:3,desiredSequence:1,deployment:{id:'dep_apply',displayName:'Apply'},target:{kind:'fly',managed:false,imageDigest:null,fly:{appName:'packed-app',machineId:'abc123',region:'ord',orgSlug:'personal'}}};
    let applyReceipt=null,applyBinding=null,applySnapshot=applyResult,applyUpdates=0,applyIssues=0,loseUpdate=true;
    const applyState={desired:{sequence:1,revision:applyRevision,document:applyExport.document,configurationVersion:3},activeInstanceId:null,lastReportSequence:0,stale:false,applied:null};
    const accountFetch=async(url,init)=>{
      if(url.endsWith('/me'))return Response.json({user:{id:'usr_apply',githubLogin:'apply'}});
      if(url.endsWith('/state'))return Response.json({state:applyState});
      if(url.endsWith('/fly-capabilities'))return Response.json({schemaVersion:1,features:['replacement','image-update']});
      if(url.endsWith('/fly-binding'))return Response.json({binding:null});
      if(url.includes('/fly-bindings/'))return applyBinding?Response.json(applyBinding):Response.json({error:'receipt_not_found'},{status:404});
      if(url.endsWith('/fly-bindings')){const request=JSON.parse(init.body);applyBinding={request,configurationVersion:3};applySnapshot={...applyResult,target:{kind:'fly',managed:false,imageDigest:request.imageDigest,fly:{appName:request.appName,machineId:request.machineId,region:request.region,orgSlug:request.orgSlug}}};return Response.json(applyBinding);}
      if(init.method==='POST'){applyIssues++;const request=JSON.parse(init.body);applyReceipt={requestId:request.requestId,instanceId:'00000000-0000-4000-8000-000000000004',sequence:1,configurationVersion:3,revision:applyRevision};applyState.activeInstanceId=applyReceipt.instanceId;return Response.json(applyReceipt);}
      if(url.includes('/instances/'))return applyReceipt?Response.json(applyReceipt):Response.json({error:'receipt_not_found'},{status:404});
      return Response.json(applySnapshot);
    };
    globalThis.fetch=accountFetch;process.env.LOGT_SERVICE_TOKEN='lt_cli_'+'T'.repeat(43);
    try{assert.equal(await main(['pull','dep_apply','--service','https://apply.test','-o','packed-apply/logt.yaml']),0);}finally{globalThis.fetch=savedFetch;process.env.LOGT_SERVICE_TOKEN=savedToken;}
    const applyManifest=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{digest:'sha256:'+'a'.repeat(64)},layers:[]});
    const applyDigest='sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(applyManifest))).toString('hex');
    const applyImage='registry.test/forwarder@'+applyDigest;
    const applyIndex=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{mediaType:'application/vnd.oci.image.manifest.v1+json',digest:applyDigest,size:Buffer.byteLength(applyManifest),platform:{os:'linux',architecture:'amd64'}}]});
    const applyRoot='sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(applyIndex))).toString('hex');
    let registryReads=0;
    const imageFetch=async(url,init)=>{assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).has('authorization'),false);registryReads++;if(url==='https://registry.test/v2/forwarder/manifests/'+applyRoot)return new Response(applyIndex);assert.equal(url,'https://registry.test/v2/forwarder/manifests/'+applyDigest);return new Response(applyManifest);};
    let applyMachine={id:'abc123',instance_id:'version1',state:'started',region:'ord',config:{image:'registry.test/old:latest',env:{OLD:'private-old-fixture'},mounts:[{path:'/var/lib/logtura',volume:'vol_checkpoint'}]},image_ref:{registry:'registry.test',repository:'old',digest:'sha256:'+'b'.repeat(64)}};
    const fly=new FlyMachinesClient({token:'fly-fixture',fetch:async(url,init)=>{
      if(url.endsWith('/lease'))return init.method==='DELETE'?new Response(null,{status:204}):Response.json({data:{nonce:'lease-fixture'}});
      if(url.endsWith('/stop')){assert.ok(await readPendingFlyApply('packed-apply/logt.yaml'));applyMachine.state='stopped';return new Response(null,{status:204});}
      if(url.endsWith('/start')){applyMachine.state='started';return new Response(null,{status:204});}
      if(init.method==='POST'){assert.equal(applyMachine.state,'stopped');assert.equal(JSON.parse(init.body).skip_launch,true);}
      if(init.method==='POST'){applyUpdates++;const intent=await readPendingFlyApply('packed-apply/logt.yaml'),request=JSON.parse(init.body);assert.deepEqual(request.config,intent.plan.after);assert.equal(request.current_version,'version1');applyMachine={...applyMachine,instance_id:'version2',config:request.config,image_ref:{registry:'registry.test',repository:'forwarder',digest:applyDigest}};applyState.lastReportSequence=1;applyState.stale=false;applyState.applied={sequence:1,revision:applyRevision,at:Date.now()};if(loseUpdate)throw new TypeError('packed provider acknowledgement lost');return Response.json(applyMachine);}
      if(url.endsWith('/machines'))return Response.json([applyMachine]);
      if(url.endsWith('/volumes'))return Response.json([{id:'vol_checkpoint',region:'ord',state:'created',encrypted:true,attached_machine_id:applyMachine.id}]);
      if(url.endsWith('/abc123'))return Response.json(applyMachine);
      return Response.json({name:'packed-app',organization:{slug:'personal'}});
    }});
    const creationConfig={image:applyImage,env:{PRIVATE:'packed-create-private'}};
    let creations=0;const creating=new FlyMachinesClient({token:'fo1_scoped',authorizationScheme:'FlyV1',fetch:async(url,init)=>{creations++;assert.equal(url,'https://api.machines.dev/v1/apps/packed-app/machines');assert.equal(init.redirect,'manual');assert.equal(new Headers(init.headers).get('authorization'),'FlyV1 fo1_scoped');assert.deepEqual(JSON.parse(init.body),{name:'forwarder',region:'ord',config:creationConfig});return Response.json({...applyMachine,name:'forwarder',config:creationConfig});}});
    assert.equal((await creating.create('packed-app',{name:'forwarder',region:'ord',config:creationConfig})).id,'abc123');assert.equal(creations,1);
    const volumeOptions={name:'packed_checkpoint',region:'ord',sizeGb:1,compute:{cpu_kind:'shared',cpus:2,memory_mb:4096}};
    const provisioning=new FlyMachinesClient({token:'fly-fixture',fetch:async(url,init)=>{assert.equal(url,'https://api.machines.dev/v1/apps/packed-app/volumes');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.deepEqual(JSON.parse(init.body),{name:volumeOptions.name,region:volumeOptions.region,size_gb:1,compute:volumeOptions.compute,encrypted:true,machines_only:true,require_unique_zone:true});return Response.json({id:'vol_checkpoint',name:volumeOptions.name,region:'ord',size_gb:1,state:'created',encrypted:true,attached_machine_id:null});}});
    assert.equal((await provisioning.createVolume('packed-app',volumeOptions)).id,'vol_checkpoint');
    const applyAccount=new LogturaServiceClient({url:'https://apply.test',token:'lt_cli_'+'T'.repeat(43),fetch:accountFetch});
    await assert.rejects(applyLinkedFlyDeployment(applyAccount,'packed-apply/logt.yaml',{fly,image:'registry.test/forwarder@'+applyRoot,imageFetch,volume:'vol_checkpoint'}),/provider acknowledgement lost/);
    const applyIntent=await readPendingFlyApply('packed-apply/logt.yaml');assert.equal(registryReads,2);assert.equal(applyIntent.plan.after.image,applyImage);const creationArtifact=JSON.parse(Buffer.from(applyIntent.plan.after.files.find(file=>file.guest_path==='/etc/vector/logtura-runtime.json').raw_value,'base64').toString());const creationCompiled=await compileForwarderRuntime({service:creationArtifact.service,deploymentId:creationArtifact.deploymentId,document:creationArtifact.document,instance:creationArtifact.instance,env:applyExport.secretValues,providers:input.providers,destinations:input.destinations});const creationRuntime=await buildFlyRuntimeConfig({base:{image:applyImage},image:applyImage,volume:'vol_checkpoint',artifact:creationArtifact,bundle:creationCompiled.bundle});assert.deepEqual(creationRuntime.init,applyIntent.plan.after.init);assert.deepEqual(creationRuntime.files,applyIntent.plan.after.files);assert.equal(statSync('packed-apply/.logtura-apply.json').mode&0o777,0o600);loseUpdate=false;
    const applied=await applyLinkedFlyDeployment(applyAccount,'packed-apply/logt.yaml',{fly,resume:true});assert.equal(applied.image,applyImage);assert.equal(registryReads,2);assert.equal(applyUpdates,1);assert.equal(applyIssues,1);assert.equal(applied.instanceId,applyReceipt.instanceId);assert.equal(await readPendingFlyApply('packed-apply/logt.yaml'),null);const completedApply=JSON.parse(readFileSync(applied.rollbackFile,'utf8'));for(const key of Object.keys(applyIntent))assert.deepEqual(completedApply[key],applyIntent[key]);assert.equal(completedApply.completion.binding.request.machineId,'abc123');

    assert.equal(manifestSecretName('CREDENTIALS','fixture'),exported.document.connections[0].credentials.env);
    const requestId='00000000-0000-4000-8000-000000000001';assert.equal(isDeploymentPushRequestId(requestId),true);
    const commit={configurationVersion:1,sequence:1,revision:await hashConfigDocument(exported.document),document:exported.document,sourceAliases:{}};
    assert.equal((await validateDeploymentConfigCommit(commit)).sequence,1);
    const service=new LogturaServiceClient({url:'https://service.test',token:'lt_cli_'+'T'.repeat(43),fetch:async(url,init)=>{
      if(url==='https://service.test/api/deployments/fixture/config/receipts/'+requestId){assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).get('authorization'),'Bearer lt_cli_'+'T'.repeat(43));return Response.json({requestId,result:commit});}
      assert.equal(url,'https://service.test/api/deployments/fixture/config');
      assert.equal(init.method,'PUT');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer lt_cli_'+'T'.repeat(43));
      const body=JSON.parse(init.body);assert.equal(body.requestId,requestId);assert.equal(body.expectedSequence,0);assert.equal(body.secretValues,undefined);
      return Response.json(commit);
    }});
    assert.equal((await service.pushDeploymentConfig('fixture',{document:exported.document,expectedConfigurationVersion:0,expectedSequence:0,requestId})).sequence,1);
    assert.deepEqual(await service.getDeploymentPushReceipt('fixture',requestId),{requestId,result:commit});
    const instanceId='00000000-0000-4000-8000-000000000002';
    const activation={requestId,expectedConfigurationVersion:1,expectedSequence:1,revision:commit.revision,expectedInstanceId:null};
    const instanceReceipt={requestId,instanceId,configurationVersion:1,sequence:1,revision:commit.revision};
    const state={desired:{sequence:1,revision:commit.revision,document:commit.document,configurationVersion:1},applied:null,activeInstanceId:null,lastReportSequence:0,stale:false};
    const instances=new LogturaServiceClient({url:'https://service.test',token:'lt_cli_'+'T'.repeat(43),fetch:async(url,init)=>{
      if(url.endsWith('/config/state'))return Response.json({state});
      if(init.method==='POST'){assert.deepEqual(JSON.parse(init.body),activation);return Response.json(instanceReceipt);}
      assert.ok(url.endsWith('/config/instances/'+requestId));return Response.json(instanceReceipt);
    }});
    assert.deepEqual(await instances.getDeploymentConfigurationState('fixture'),state);
    assert.deepEqual(await instances.activateDeploymentInstance('fixture',activation),instanceReceipt);
    assert.deepEqual(await instances.getDeploymentInstanceReceipt('fixture',requestId),instanceReceipt);
    const reporting=new DeploymentReportingClient({url:'https://service.test',token:'fixture-report-token',fetch:async(url,init)=>{
      assert.equal(url,'https://service.test/api/applied/fixture');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-report-token');assert.equal(JSON.parse(init.body).instanceId,instanceId);return Response.json({accepted:true});
    }});
    assert.equal(await reporting.reportApplied('fixture',{instanceId,sequence:1,revision:commit.revision,reportSequence:1}),true);
    assert.equal(GENERATOR_VERSION,JSON.parse(readFileSync('node_modules/@logtura/core/package.json','utf8')).version);
    const compiled=await compileForwarderRuntime({service:'https://service.test',deploymentId:'fixture',document:exported.document,instance:instanceReceipt,env:exported.secretValues,providers:input.providers,destinations:input.destinations});
    assert.deepEqual(compiled.bundle,bundle);
    const imageManifest=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{digest:'sha256:'+'b'.repeat(64)},layers:[]});
    const imageDigest='sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(imageManifest))).toString('hex');
    const pinnedImage='registry.test/forwarder@'+imageDigest;
    assert.equal((await resolveFlyImage(pinnedImage,{fetch:async(url,init)=>{assert.equal(url,'https://registry.test/v2/forwarder/manifests/'+imageDigest);assert.equal(init.redirect,'manual');return new Response(imageManifest);}})).image,pinnedImage);
    const providerFiles=flyBundleFiles({...bundle,runtimeAssets:[{driverId:'fixture',path:'helper.bin',content:new Uint8Array([0,255,1]),mode:0o755},{driverId:'fixture',path:'unicode.txt',content:'héllo'}]});
    assert.deepEqual(providerFiles.slice(1),[{guest_path:'/opt/logtura/assets/fixture/helper.bin',raw_value:'AP8B',mode:0o755},{guest_path:'/opt/logtura/assets/fixture/unicode.txt',raw_value:Buffer.from('héllo').toString('base64'),mode:0o644}]);
    assert.equal(providerFiles[0].mode,0o400);
    const completeBundle={...bundle,runtimeAssets:[{driverId:'fixture',path:'nested/helper.bin',content:new Uint8Array([0,255,128]),mode:0o700}]};
    assert.deepEqual(runtimeAssetFiles(completeBundle.runtimeAssets),[{name:'assets/fixture/nested/helper.bin',content:new Uint8Array([0,255,128]),mode:0o700}]);
    assert.deepEqual(selfDeployFiles(completeBundle).slice(3),flySelfDeployFiles({bundle:completeBundle,appName:'fixture-app'}).slice(4));
    assert.ok(renderDockerRunCommand([{name:'TOKEN',value:'literal $(payload)'}]).includes("'TOKEN=literal $(payload)'"));
    assert.throws(()=>flyBundleFiles({...bundle,runtimeAssets:[{driverId:'fixture',path:'../escape',content:'invalid'}]}),/Invalid runtime asset/);
    const observed={files:{'vector.yaml':bundle.vectorYaml,...Object.fromEntries(bundle.runtimeAssets.map(asset=>['assets/'+asset.driverId+'/'+asset.path,asset.content]))},environment:Object.fromEntries(bundle.envVars.map(v=>[v.name,v.value])),generatorVersion:GENERATOR_VERSION,vectorVersion:'0.55.0',ready:true};
    assert.deepEqual(await verifyLoadedForwarder(compiled.artifact,observed),compiled.artifact);
    assert.ok(!JSON.stringify(compiled.artifact).includes('fixture-token'));
    let checkpoint=null;
    const reportStore={load:async()=>checkpoint,save:async(value)=>{checkpoint=structuredClone(value)}};
    assert.deepEqual(await reportLoadedForwarder({artifact:compiled.artifact,observed,store:reportStore,report:async()=>true}),{reportSequence:1,accepted:true});
    assert.equal(checkpoint.lastReportSequence,1);
    const checkpointFile='runtime-checkpoint.json';
    assert.deepEqual(await reportLoadedForwarderFile({checkpoint:checkpointFile,artifact:compiled.artifact,observed,report:async()=>true}),{reportSequence:1,accepted:true});
    assert.equal(statSync(checkpointFile).mode&0o777,0o600);
    const stopReporting=new AbortController();
    await runForwarderReporting({checkpoint:checkpointFile,artifact:compiled.artifact,observe:async()=>observed,report:async()=>true,signal:stopReporting.signal,onResult:()=>stopReporting.abort()});
    assert.equal(JSON.parse(readFileSync(checkpointFile,'utf8')).lastReportSequence,2);
    const parsed=parseDeploymentManifest(exported.document,{env:exported.secretValues,providers:input.providers,destinations:input.destinations});
    assert.deepEqual(generateBundle(parsed.input),bundle);
    const edited=await editDeploymentManifest(exported.document,exported.secretValues,[{kind:'source.add',connectionId:'fixture',source:{id:'src_second',externalId:'fixture-second',displayName:'Second',sourceKind:'worker',metadata:null}}],await createSecretVersioner('local-private-key'));
    assert.deepEqual(edited.document.connections[0].credentials,exported.document.connections[0].credentials);
    assert.equal((await diffDeploymentManifests(exported.document,edited.document)).changes[0].operation,'add');
    writeFileSync('graph.yaml',JSON.stringify(exported.document));
    writeFileSync('graph-baseline.yaml',JSON.stringify(exported.document));
    writeFileSync('.env',Object.entries(exported.secretValues).map(([key,value])=>key+'='+JSON.stringify(value)).join('\\n')+'\\n',{mode:0o600});
    assert.match(await hashConfigDocument(exported.document),/^sha256:[a-f0-9]{64}$/);
    assert.ok(bundle.vectorYaml.includes('internal_metrics'));
    const files=installBundleFiles(bundle);
    assert.equal(files.find(f=>f.name.endsWith('/.env')).mode,0o600);
    assert.ok(files.find(f=>f.name.endsWith('/install.sh')).content.includes('-e CLOUDFLARE_API_TOKEN'));
    assert.ok(buildTar(files).length>1024);
    ${packages.map((name) => `await import(${JSON.stringify(`@logtura/${name}`)});`).join("\n")}
    console.log('all public packages import in ordinary Node');`;
  writeFileSync(join(consumer, "consumer.mjs"), script);
  run(process.execPath, ["consumer.mjs"], consumer, offline);
  const linkedPath=join(consumer,"linked","logt.yaml"),linkedState=readFileSync(`${linkedPath}.logtura-link.json`,"utf8");
  assert.equal(JSON.parse(bin("logt",["-c",linkedPath,"config","status"])).linked,true);
  assert.equal(JSON.parse(linkedState).target.fly.appName,"existing-packed-forwarder");
  const legacyLinked = spawnSync(join(consumer,"node_modules",".bin","logt"),["-c",linkedPath,"deploy","fly","--output",join(consumer,"linked-fly")],{cwd:consumer,encoding:"utf8",env:{...process.env,...offline}});
  assert.equal(legacyLinked.status,1);assert.match(legacyLinked.stderr,/Unsupported linked deploy option/);
  bin("logtura",["-c",linkedPath,"source","select","fixture","linked-new-site","--id","src_linked_new"]);
  assert.equal(readFileSync(`${linkedPath}.logtura-link.json`,"utf8"),linkedState);
  const linkedStatus=JSON.parse(bin("logt",["-c",linkedPath,"config","status","--json"]));
  assert.equal(linkedStatus.configurationVersion,4);assert.equal(linkedStatus.desiredSequence,1);
  assert.ok(linkedStatus.changes.some(change=>change.id==="src_linked_new"));assert.deepEqual(linkedStatus.privateChanges,[]);
  const initialGraphRevision = bin("logt", ["-c", "graph.yaml", "config", "hash"]).trim();
  bin("logtura", ["-c", "graph.yaml", "source", "select", "fixture", "fixture-second", "--id", "src_second"]);
  const diff = JSON.parse(bin("logt", ["-c", "graph.yaml", "config", "diff", "graph-baseline.yaml"]));
  assert.equal(diff.changes[0].entity, "source"); assert.equal(diff.changes[0].id, "src_second");
  bin("logt", ["-c", "graph.yaml", "validate"]);
  bin("logt", ["-c", "graph.yaml", "bundle", "-o", "graph bundle"]);
  assert.ok(readFileSync(join(consumer, "graph bundle", "vector.yaml"), "utf8").includes("fixture-second"));
  bin("logt", ["-c", "graph.yaml", "source", "remove", "src_second"]);
  assert.equal(bin("logt", ["-c", "graph.yaml", "config", "hash"]).trim(), initialGraphRevision);
  writeFileSync(join(consumer, "discovery-edits.json"), JSON.stringify([{kind:"connection.update",id:"fixture",patch:{},discoverSources:true},{kind:"selection.update",discoverMonitors:true}]));
  bin("logtura", ["-c", "graph.yaml", "config", "edit", "discovery-edits.json"]);
  assert.match(readFileSync(join(consumer, "graph.yaml"), "utf8"), /discoverSources: true/);
  bin("logt", ["-c", "graph.yaml", "source", "select", "fixture", "fixture-second", "--id", "src_second"]);
  bin("logtura", ["-c", "graph.yaml", "source", "remove", "src_second"]);
  assert.match(readFileSync(join(consumer, "graph.yaml"), "utf8"), /discoverSources: false/);
  assert.match(readFileSync(join(consumer, "graph.yaml"), "utf8"), /discoverMonitors: true/);
  bin("logt", ["-c", "graph.yaml", "validate"]);
  // Crash a compiled transaction in an isolated installed consumer, then recover
  // through the actual executable. No TypeScript loader or service is available.
  const recoveryDir = join(consumer, "recovery"); mkdirSync(recoveryDir);
  const recoveryConfig = join(recoveryDir, "logt.yaml");
  const recoveryFiles = [join(recoveryDir, ".env"), recoveryConfig].map((target, i) => {
    const original = readFileSync(join(consumer, i === 0 ? ".env" : "graph.yaml"), "utf8");
    writeFileSync(target, original, {mode: i === 0 ? 0o600 : 0o644}); return {target, original};
  });
  const crashScript = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    let count=0; const rename=fs.renameSync; fs.renameSync=(...args)=>{rename(...args); if(++count===2)process.kill(process.pid,'SIGKILL')};
    syncBuiltinESMExports(); const {main}=await import('@logtura/cli');
    process.exitCode=await main(['-c',${JSON.stringify(recoveryConfig)},'source','select','fixture','crash-test','--id','src_crash']);`;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript], {cwd: consumer, encoding: "utf8", env: {...process.env, ...offline}});
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  assert.equal(JSON.parse(bin("logtura", ["-c", recoveryConfig, "config", "recover", "--json"])).recovered, true);
  for (const file of recoveryFiles) assert.equal(readFileSync(file.target, "utf8"), file.original);
  assert.deepEqual(readdirSync(recoveryDir), [".env", "logt.yaml"]);
  assert.equal(JSON.parse(bin("logt", ["-c", recoveryConfig, "config", "recover", "--json"])).recovered, false);
  const providerFixture = join(consumer, "provider-fixture.mjs");
  writeFileSync(providerFixture, String.raw`import assert from 'node:assert/strict';
for(const key of ['RAILWAY_API_TOKEN','VERCEL_API_TOKEN','SUPABASE_PAT','SUPABASE_PROJECT_REF'])delete process.env[key];
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-provider-secret');
  if (url.origin === 'https://api.vercel.com') {
    if (url.pathname === '/v2/user') return Response.json({user:{uid:'user',username:'User'}});
    if (url.pathname === '/v9/projects') { assert.equal(url.searchParams.has('teamId'),false);return Response.json({projects:[{id:'vercel-project',name:'Site'}]}); }
  }
  if (url.origin === 'https://api.supabase.com') {
    if (url.pathname === '/v1/projects') return Response.json([{id:'project',ref:'project-ref',name:'Shop'}]);
    if (url.pathname === '/v1/projects/project-ref/functions') return Response.json([{id:'function-id',slug:'api'}]);
  }
  if (url.href === 'https://backboard.railway.com/graphql/v2') {
    const {query,variables}=JSON.parse(init.body),operation=/query\s+(\w+)/.exec(query)?.[1];
    if(operation==='ProjectToken' || operation==='ProjectTokenScope')return Response.json({data:{}});
    if(operation==='ExternalProjects')return Response.json({data:{externalWorkspaces:[{projects:[{id:'project',name:'Shop'}]}]}});
    assert.deepEqual(variables,{projectId:'project'});
    if(operation==='Project')return Response.json({data:{project:{id:'project',name:'Shop'}}});
    if(operation==='ProjectEnvironments')return Response.json({data:{project:{environments:{edges:['production','staging'].map(id=>({node:{id,serviceInstances:{edges:[{node:{serviceId:'api',serviceName:'API'}}]}}}))}}}});
  }
  throw new Error('Unexpected outbound request in installed provider fixture');
};`);
  const providerEnvironment = {...offline, NODE_OPTIONS:`--import=${pathToFileURL(providerFixture)}`, RAILWAY_API_TOKEN:"", VERCEL_API_TOKEN:"", SUPABASE_PAT:"", SUPABASE_PROJECT_REF:""};
  for (const [provider, marker] of [["railway", '== "staging"'], ["vercel", "vercel-project"], ["supabase", "function-id"]]) {
    const directory = join(consumer, "provider-configs", provider); mkdirSync(directory, {recursive:true});
    const config = join(directory, "logt.yaml"); writeFileSync(config, "{}\n");
    for (const alias of ["logt", "logtura"]) run(join(consumer,"node_modules",".bin",alias), ["-c",config,"connect",provider,"--name","site","--token","fixture-provider-secret","--quiet"],consumer,providerEnvironment);
    const contents = readFileSync(config,"utf8"); assert.ok(!contents.includes("fixture-provider-secret"));
    assert.equal((contents.match(/^    source: /gm)??[]).length,1,contents);
    assert.equal(statSync(join(directory,".env")).mode&0o777,0o600);
    run(join(consumer,"node_modules",".bin","logt"),["-c",config,"validate"],consumer,providerEnvironment);
    const bundleDirectory=join(directory,"bundle");run(join(consumer,"node_modules",".bin","logtura"),["-c",config,"bundle","-o",bundleDirectory],consumer,providerEnvironment);
    assert.ok(readFileSync(join(bundleDirectory,"vector.yaml"),"utf8").includes(marker));
  }
  console.log(`Packed consumer checks passed for ${packages.length} packages, both CLI aliases and the forwarder runtime binary`);
  if(process.env.LOGT_PACKED_ARTIFACTS){
    const output=resolve(process.env.LOGT_PACKED_ARTIFACTS),publicPackages=inventory(root);
    const version=publicPackages[0].version;checkTag(publicPackages,`v${version}`);
    mkdirSync(dirname(output),{recursive:true});mkdirSync(output);
    const rows=publicPackages.map(p=>{const file=`${p.name.replace('@','').replace('/','-')}-${p.version}.tgz`;const archive=archives.find(a=>basename(a)===file);assert.ok(archive,`Missing tested archive ${file}`);copyFileSync(archive,join(output,file));return {name:p.name,version:p.version,file,integrity:integrity(readFileSync(archive))};});
    const manifest={schemaVersion:1,version,sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceClean:run('git',['status','--porcelain','--','packages','scripts','oss','pnpm-lock.yaml','package.json'],root).trim()==='',packages:rows};
    writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    console.log(`Exported ${rows.length} tested release archives to ${output}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
