import assert from "node:assert/strict";
import {existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
const root=process.cwd();
const {vercelLogsDriver}=await import(pathToFileURL(join(root,"packages/driver-vercel-logs/dist/index.js")));
const pipeline=vercelLogsDriver.generatePipeline({connection:{id:"con",externalAccountId:"team_fixture",displayName:"Vercel"},selection:{kind:"list",sources:[{id:"api",externalId:"prj_fixture",sourceKind:"vercel_project",displayName:"Fixture",metadata:null}]}});
const asset=pipeline.runtimeAssets.find(asset=>asset.path.endsWith(".mjs"));
assert.ok(asset,"Generated Vercel helper asset missing");
const image=pipeline.dockerfileDeps.find(line=>line.directive.startsWith("COPY --from=oven/bun:"))?.directive.match(/^COPY --from=(\S+)/)?.[1];
assert.ok(image,"Generated Vercel Bun image requirement missing");
const temporary=mkdtempSync(join(tmpdir(),"logtura-vercel-bun-"));
const container=`logtura-vercel-bun-${crypto.randomUUID()}`;
const vectorImage=`${container}-vector`;
try {
  // Host-owned directory keeps container-created wrapper files removable.
  mkdirSync(join(temporary,"bin"));
  writeFileSync(join(temporary,"vercel.mjs"),asset.content);
  copyFileSync(new URL("./fixtures/vercel-bun-fixture.mjs",import.meta.url),join(temporary,"fixture.mjs"));
  const result=spawnSync("docker",["run","--rm","--name",container,"--network","none","--mount",`type=bind,src=${temporary},dst=/fixture`,image,"bun","/fixture/fixture.mjs"],{encoding:"utf8",timeout:180_000});
  assert.equal(result.status,0,`Real Bun Vercel fixture failed: ${result.stderr}\n${result.stdout}`);
  process.stdout.write(result.stdout);
  // Build the complete public self-deploy context, including the generated
  // helper and the driver's Bun dependency. Vector launches the unmodified
  // generated exec source; a fixture PATH wrapper redirects only its API origin.
  const {generateBundle,selfDeployFiles}=await import(pathToFileURL(join(root,"packages/core/dist/index.js")));
  const {webhookDriver}=await import(pathToFileURL(join(root,"packages/destination-webhook/dist/index.js")));
  const bundle=generateBundle({providers:[vercelLogsDriver],destinations:[webhookDriver],
    connections:[{connection:{id:"con",provider:vercelLogsDriver.id,externalAccountId:"team_fixture",displayName:"Vercel"},credentials:{apiToken:"fixture-vercel-token"},selectedSources:[{id:"api",externalId:"prj_fixture",sourceKind:"vercel_project",displayName:"Fixture",metadata:null}]}],
    monitors:[{monitor:{id:"errors",connectionId:null,displayName:"Errors",enabled:true,filterSteps:[{kind:"errors"}]},sinks:[{sink:{id:"delivery",filterSteps:[]},destination:{id:"webhook",kind:"webhook",displayName:"Receiver"},destinationConfig:{url:"http://127.0.0.1:9001/events"}}]}]});
  const context=join(temporary,"image"); mkdirSync(context);
  for(const file of selfDeployFiles(bundle)) { const path=join(context,file.name); mkdirSync(join(path,".."),{recursive:true}); writeFileSync(path,file.content,{mode:file.mode}); }
  const built=spawnSync("docker",["build","--quiet","--tag",vectorImage,context],{encoding:"utf8",timeout:180_000});
  assert.equal(built.status,0,`Vercel generated forwarder build failed: ${built.stderr}`);
  const env=bundle.envVars.flatMap(variable=>variable.value===null?[]:["--env",`${variable.name}=${variable.value}`]);
  const delivery=spawnSync("docker",["run","--rm","--name",container,"--network","none","--mount",`type=bind,src=${temporary},dst=/fixture`,...env,"--env","LOGT_VERCEL_VECTOR=1","--entrypoint","bun",vectorImage,"/fixture/fixture.mjs"],{encoding:"utf8",timeout:90_000});
  assert.equal(delivery.status,0,`Real Vercel Vector delivery failed: ${delivery.stderr}\n${delivery.stdout}`);
  process.stdout.write(delivery.stdout);
  const failure=spawnSync("docker",["run","--rm","--name",container,"--network","none","--mount",`type=bind,src=${temporary},dst=/fixture`,...env,"--env","LOGT_VERCEL_VECTOR=1","--env","LOGT_VERCEL_INJECT_FAILURE=after-delivery","--entrypoint","bun",vectorImage,"/fixture/fixture.mjs"],{encoding:"utf8",timeout:90_000});
  assert.equal(failure.status,1,`Injected Vercel fixture must fail: ${failure.stderr}`);
  assert.match(failure.stderr,/Injected Vercel delivery failure/);
  process.stdout.write("Injected failure after actual webhook delivery was rejected\n");
} finally {
  spawnSync("docker",["rm","-f",container],{stdio:"ignore",timeout:30_000});
  spawnSync("docker",["image","rm","-f",vectorImage],{stdio:"ignore",timeout:30_000});
  rmSync(temporary,{recursive:true,force:true});
  assert.equal(existsSync(temporary),false);
  for(const [label,args] of [["containers",["ps","--all","--filter",`name=${container}`,"--format","{{.Names}}"]],["images",["image","ls","--filter",`reference=${vectorImage}`,"--format","{{.Repository}}"]]]) {
    const remaining=spawnSync("docker",args,{encoding:"utf8",timeout:30_000});
    assert.equal(remaining.status,0,`Unable to verify owned ${label} cleanup`);
    assert.equal(remaining.stdout.trim(),"",`Owned ${label} leaked`);
  }
  process.stdout.write("Owned Vercel children, containers, image and temporary files cleaned\n");
}
