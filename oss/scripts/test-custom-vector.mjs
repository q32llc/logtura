import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
const fixture=new URL("./test-custom-vector-flow.mjs",import.meta.url);
for(const inject of [false,true]) {
  const env={...process.env};delete env.LOGT_CUSTOM_GRAPH_INJECT_FAILURE;
  if(inject)env.LOGT_CUSTOM_GRAPH_INJECT_FAILURE="after-delivery";
  const result=spawnSync(process.execPath,[fixture.pathname],{env,encoding:"utf8",timeout:240000});
  assert.equal(result.status,inject?1:0,`Custom graph fixture failed: ${result.stderr}\n${result.stdout}`);
  if(inject)assert.match(result.stderr,/Injected custom graph delivery failure/);
  assert.match(result.stdout,/Owned custom graph container, image, HTTP server and temporary files cleaned/);
  process.stdout.write(result.stdout);
  if(inject)console.log("Injected custom graph failure after actual delivery was rejected and cleaned");
}
