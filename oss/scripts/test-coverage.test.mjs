import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { checkedRun } from "./test-coverage.mjs";

async function run(source) {
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const code = await checkedRun(process.execPath, ["-e", source], { stdout: sink, stderr: sink });
  return { code, output };
}
test("preserves output and exit codes for passing and failing child processes", async () => {
  assert.deepEqual(await run('console.log("passing assertion");'), { code: 0, output: "passing assertion\n" });
  assert.equal((await run('console.error("failed assertion");process.exitCode=7;')).code, 7);
});
test("fails a success-exit child with uncaught Workers runtime diagnostics on either stream", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const result = await run(`process.${stream}.write('uncaught exception; source = Uncaught (in promise)\\n');`);
    assert.equal(result.code, 1);
    assert.match(result.output, /source = Uncaught/);
    assert.match(result.output, /coverage run fails/);
  }
});
test("detects RPC teardown failures split across output chunks", async () => {
  const result = await run('process.stderr.write("EnvironmentTeardown");setTimeout(()=>process.stderr.write("Error: [vitest-worker]: Closing rpc while resolve was pending\\n"),30);');
  assert.equal(result.code, 1);
  assert.match(result.output, /EnvironmentTeardownError/);
});
test("detects unsupported span RPCs and treats process signals as failures", async () => {
  assert.equal((await run('console.error("SpanParent not supported by the server");')).code, 1);
  assert.equal((await run('process.kill(process.pid,"SIGTERM");')).code, 1);
});
test("an expected application error log does not masquerade as an uncaught runtime failure", async () => {
  assert.equal((await run('console.warn("job_failed",{error:"expected provider failure"});')).code, 0);
});
test("a missing executable fails with a useful diagnostic", async () => {
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  assert.equal(await checkedRun("/missing/logtura-coverage-executable", [], { stdout: sink, stderr: sink }), 1);
  assert.match(output, /Unable to start/);
});
