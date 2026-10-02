import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
  for (const name of packages) run("pnpm", ["pack", "--pack-destination", artifacts], join(root, "packages", name));
  const archives = readdirSync(artifacts).filter((name) => name.endsWith(".tgz")).map((name) => join(artifacts, name));
  assert.equal(archives.length, packages.length, "every package must produce a tarball");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...archives], consumer);
  // Typecheck the installed tarballs with their declarations, without skipLibCheck.
  const typesFile = join(consumer, "consumer.mts");
  writeFileSync(typesFile, packages.map((name, index) => `import * as package${index} from '@logtura/${name}';`).join("\n") + `
    import {type GenerateInput, type DeploymentInstanceReceipt, LogturaServiceClient} from '@logtura/core';
    import {type PendingActivation, type PendingFlyApply, activateLinkedDeployment} from '@logtura/cli';
    const typedActivation: (client:LogturaServiceClient,config:string,options?:{resume?:boolean})=>Promise<DeploymentInstanceReceipt> = activateLinkedDeployment;
    // @ts-expect-error Config fields remain required; these exports must not become any.
    const invalidInput:GenerateInput = {};
    // @ts-expect-error Private journal fields remain required.
    const invalidPending:PendingActivation = {schemaVersion:1};
    // @ts-expect-error Apply intent retains its required private fields.
    const invalidApply:PendingFlyApply = {schemaVersion:1};
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
    import {parseMetricsBody,applyMetricsToSnapshot,rateFor,GENERATOR_VERSION,compileForwarderRuntime,verifyLoadedForwarder,reportLoadedForwarder,generateBundle,installBundleFiles,buildTar,exportDeploymentManifest,createSecretVersioner,parseDeploymentManifest,hashConfigDocument,editDeploymentManifest,diffDeploymentManifests,planDeploymentChanges,resolveDeploymentDiscovery,validateDeploymentInput,FlyMachinesClient,LogturaServiceClient, DeploymentReportingClient,manifestSecretName,isDeploymentPushRequestId,validateDeploymentConfigCommit} from '@logtura/core';
    import {writeFileSync,readFileSync,statSync} from 'node:fs';
    import {main,applyLinkedFlyDeployment,readPendingFlyApply,activateLinkedDeployment,readPendingActivation,finishLinkedActivation,reportLoadedForwarderFile,runForwarderReporting} from '@logtura/cli';
    import {cloudflareWorkerTailDriver} from '@logtura/driver-cloudflare-worker-tail';
    const metrics=applyMetricsToSnapshot(null,parseMetricsBody(readFileSync('metrics file.ndjson','utf8')));assert.equal(metrics.byComponent.packed_sink.sent,7);assert.equal(rateFor(metrics.byComponent.packed_sink,'sent'),null);
    const largeMetric={kind:'source',type:'exec',sent:1e308,lastSeen:60000,prev:{sent:0,sampleAt:0}};
    assert.equal(rateFor(largeMetric,'sent'),1e308);
    assert.equal(rateFor({...largeMetric,lastSeen:1},'sent'),null);
    assert.equal(rateFor({...largeMetric,sent:NaN},'sent'),null);
    const input={providers:[cloudflareWorkerTailDriver],destinations:[],monitors:[],
      connections:[{connection:{id:'fixture',provider:cloudflareWorkerTailDriver.id,displayName:'Fixture',externalAccountId:'fixture-account'},
        selectedSources:[{id:'worker',externalId:'fixture-worker',displayName:'fixture-worker',sourceKind:'worker',metadata:null}],credentials:{apiToken:'fixture-token'}}]};
    const bundle=generateBundle(input);
    validateDeploymentInput(input);
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
    const applyRevision=await hashConfigDocument(applyExport.document),applyResult={...applyExport,revision:applyRevision,configurationVersion:3,desiredSequence:1,deployment:{id:'dep_apply',displayName:'Apply'},target:{kind:'fly',managed:false,imageDigest:null,fly:{appName:'packed-app',region:'ord'}}};
    let applyReceipt=null,applyUpdates=0,applyIssues=0,loseUpdate=true;
    const applyState={desired:{sequence:1,revision:applyRevision,document:applyExport.document,configurationVersion:3},activeInstanceId:null,lastReportSequence:0,stale:true,applied:null};
    const accountFetch=async(url,init)=>{
      if(url.endsWith('/me'))return Response.json({user:{id:'usr_apply',githubLogin:'apply'}});
      if(url.endsWith('/state'))return Response.json({state:applyState});
      if(init.method==='POST'){applyIssues++;const request=JSON.parse(init.body);applyReceipt={requestId:request.requestId,instanceId:'00000000-0000-4000-8000-000000000004',sequence:1,configurationVersion:3,revision:applyRevision};applyState.activeInstanceId=applyReceipt.instanceId;return Response.json(applyReceipt);}
      if(url.includes('/instances/'))return applyReceipt?Response.json(applyReceipt):Response.json({error:'receipt_not_found'},{status:404});
      return Response.json(applyResult);
    };
    globalThis.fetch=accountFetch;process.env.LOGT_SERVICE_TOKEN='lt_cli_'+'T'.repeat(43);
    try{assert.equal(await main(['pull','dep_apply','--service','https://apply.test','-o','packed-apply/logt.yaml']),0);}finally{globalThis.fetch=savedFetch;process.env.LOGT_SERVICE_TOKEN=savedToken;}
    const applyImage='registry.test/forwarder@sha256:'+'a'.repeat(64);
    let applyMachine={id:'machine123',instance_id:'version1',state:'started',region:'ord',config:{image:'registry.test/old:latest',env:{OLD:'private-old-fixture'}},image_ref:{registry:'registry.test',repository:'old',digest:'sha256:'+'b'.repeat(64)}};
    const fly=new FlyMachinesClient({token:'fly-fixture',fetch:async(url,init)=>{
      if(url.endsWith('/lease'))return init.method==='DELETE'?new Response(null,{status:204}):Response.json({data:{nonce:'lease-fixture'}});
      if(init.method==='POST'){applyUpdates++;const intent=await readPendingFlyApply('packed-apply/logt.yaml'),request=JSON.parse(init.body);assert.deepEqual(request.config,intent.plan.after);assert.equal(request.current_version,'version1');applyMachine={...applyMachine,instance_id:'version2',config:request.config,image_ref:{registry:'registry.test',repository:'forwarder',digest:'sha256:'+'a'.repeat(64)}};applyState.lastReportSequence=1;applyState.stale=false;applyState.applied={sequence:1,revision:applyRevision,at:Date.now()};if(loseUpdate)throw new TypeError('packed provider acknowledgement lost');return Response.json(applyMachine);}
      if(url.endsWith('/machines'))return Response.json([applyMachine]);
      if(url.endsWith('/volumes'))return Response.json([{id:'vol_checkpoint',region:'ord',state:'created',encrypted:true,attached_machine_id:applyUpdates?applyMachine.id:null}]);
      if(url.endsWith('/machine123'))return Response.json(applyMachine);
      return Response.json({name:'packed-app',organization:{slug:'personal'}});
    }});
    const applyAccount=new LogturaServiceClient({url:'https://apply.test',token:'lt_cli_'+'T'.repeat(43),fetch:accountFetch});
    await assert.rejects(applyLinkedFlyDeployment(applyAccount,'packed-apply/logt.yaml',{fly,image:applyImage,volume:'vol_checkpoint'}),/provider acknowledgement lost/);
    const applyIntent=await readPendingFlyApply('packed-apply/logt.yaml');assert.equal(statSync('packed-apply/.logtura-apply.json').mode&0o777,0o600);loseUpdate=false;
    const applied=await applyLinkedFlyDeployment(applyAccount,'packed-apply/logt.yaml',{fly,resume:true});assert.equal(applyUpdates,1);assert.equal(applyIssues,1);assert.equal(applied.instanceId,applyReceipt.instanceId);assert.equal(await readPendingFlyApply('packed-apply/logt.yaml'),null);assert.deepEqual(JSON.parse(readFileSync(applied.rollbackFile,'utf8')),applyIntent);

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
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
