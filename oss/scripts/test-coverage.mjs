import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Preserve every diagnostic and reject runtime failures that a pool can emit
 * without propagating a nonzero Vitest exit. Keep only a bounded cross-chunk tail. */
export function checkedRun(command, args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
    let runtimeFailure = false;
    const inspect = () => {
      let tail = "";
      return (chunk) => {
        const output = tail + chunk.toString("utf8");
        if (/(?:^|\n)uncaught exception;|EnvironmentTeardownError: \[vitest-worker\]|SpanParent.*not supported by (?:the )?server/.test(output)) runtimeFailure = true;
        tail = output.slice(-512);
      };
    };
    child.stdout.on("data", inspect());
    child.stderr.on("data", inspect());
    child.stdout.pipe(stdout, { end: false });
    child.stderr.pipe(stderr, { end: false });
    const signals = ["SIGINT", "SIGTERM"];
    const forward = signals.map((signal) => () => child.kill(signal));
    signals.forEach((signal, index) => process.once(signal, forward[index]));
    let finished = false;
    function finish(code) {
      if (finished) return;
      finished = true;
      signals.forEach((signal, index) => process.removeListener(signal, forward[index]));
      if (runtimeFailure) stderr.write("Unexpected runtime exception detected; the coverage run fails even if Vitest exits successfully.\n");
      done(code === 0 && runtimeFailure ? 1 : code);
    }
    child.on("error", () => { stderr.write("Unable to start the coverage runner.\n"); finish(1); });
    child.on("close", (code) => finish(code ?? 1));
  });
}
export async function coverage(args = process.argv.slice(2)) {
  const require = createRequire(import.meta.url);
  const binary = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  return checkedRun(process.execPath, [binary, "run", "--coverage", ...args]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await coverage();
