import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
  const script = `import assert from 'node:assert/strict';
    import {GENERATOR_VERSION,compileForwarderRuntime,verifyLoadedForwarder,reportLoadedForwarder,generateBundle,installBundleFiles,buildTar,exportDeploymentManifest,createSecretVersioner,parseDeploymentManifest,hashConfigDocument,editDeploymentManifest,diffDeploymentManifests,planDeploymentChanges,resolveDeploymentDiscovery,validateDeploymentInput,LogturaServiceClient, DeploymentReportingClient,manifestSecretName,isDeploymentPushRequestId,validateDeploymentConfigCommit} from '@logtura/core';
    import {writeFileSync,readFileSync,statSync} from 'node:fs';
    import {main,reportLoadedForwarderFile,runForwarderReporting} from '@logtura/cli';
    import {cloudflareWorkerTailDriver} from '@logtura/driver-cloudflare-worker-tail';
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
  const fakeBin=join(consumer,"fake-bin"),flyCalls=join(consumer,"fly-calls.jsonl");mkdirSync(fakeBin);
  writeFileSync(join(fakeBin,"flyctl"),`#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(flyCalls)},JSON.stringify(process.argv.slice(2))+'\\n');
process.stdin.resume();
`,{mode:0o755});
  run(join(consumer,"node_modules",".bin","logt"),["-c",linkedPath,"deploy","fly","--output",join(consumer,"linked-fly")],consumer,{...offline,PATH:fakeBin+":"+process.env.PATH});
  const commands=readFileSync(flyCalls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  assert.ok(commands.some(args=>args[0]==="deploy" && args.includes("existing-packed-forwarder")));
  assert.ok(!commands.some(args=>args[0]==="apps"));
  assert.match(readFileSync(join(consumer,"linked-fly","fly.toml"),"utf8"),/primary_region = "ord"/);
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
  console.log(`Packed consumer checks passed for ${packages.length} packages, both CLI aliases and the forwarder runtime binary`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
