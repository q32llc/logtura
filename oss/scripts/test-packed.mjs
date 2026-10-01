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
    import {generateBundle,installBundleFiles,buildTar,exportDeploymentManifest,createSecretVersioner,parseDeploymentManifest,hashConfigDocument,editDeploymentManifest,diffDeploymentManifests,planDeploymentChanges,resolveDeploymentDiscovery,validateDeploymentInput} from '@logtura/core';
    import {writeFileSync} from 'node:fs';
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
  console.log(`Packed consumer checks passed for ${packages.length} packages and both CLI aliases`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
