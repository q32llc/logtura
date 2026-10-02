import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, copyFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
const root=process.cwd();
const {railwayLogsDriver}=await import(pathToFileURL(join(root,"packages/driver-railway-logs/dist/index.js")));
const pipeline=railwayLogsDriver.generatePipeline({connection:{id:"con",externalAccountId:"production",displayName:"Railway"},selection:{kind:"list",sources:[{id:"api",externalId:"api",sourceKind:"railway_service",displayName:"API",metadata:null}]}});
const asset=pipeline.runtimeAssets.find(asset=>asset.path.endsWith(".mjs"));
assert.ok(asset,"Generated Railway helper asset missing");
const image=pipeline.dockerfileDeps.find(line=>line.directive.startsWith("COPY --from=oven/bun:"))?.directive.match(/^COPY --from=(\S+)/)?.[1];
assert.ok(image,"Generated Railway Bun image requirement missing");
const temporary=mkdtempSync(join(tmpdir(),"logtura-railway-bun-"));
const container=`logtura-railway-bun-${crypto.randomUUID()}`;
try {
  writeFileSync(join(temporary,"railway.mjs"),asset.content);
  copyFileSync(new URL("./fixtures/railway-bun-fixture.mjs",import.meta.url),join(temporary,"fixture.mjs"));
  const result=spawnSync("docker",["run","--rm","--name",container,"--network","none","--mount",`type=bind,src=${temporary},dst=/fixture`,image,"bun","/fixture/fixture.mjs"],{encoding:"utf8",timeout:180_000});
  assert.equal(result.status,0,`Real Bun Railway fixture failed: ${result.stderr}\n${result.stdout}`);
  process.stdout.write(result.stdout);
} finally {
  spawnSync("docker",["rm","-f",container],{stdio:"ignore",timeout:30_000});
  rmSync(temporary,{recursive:true,force:true});
}
