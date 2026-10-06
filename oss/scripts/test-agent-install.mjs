import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? ".tmp/agent-reports");
mkdirSync(output, { recursive: true });
function run(args) { const result = spawnSync("docker", args, { stdio: "inherit", timeout: 300_000 }); if (result.status !== 0) throw new Error(`Native client test failed (${result.status})`); }
run(["build", "-t", "logtura-agent-consumers:test", join(root, "test/agents")]);
run(["run", "--rm", "--mount", `type=bind,source=${root},target=/marketplace,readonly`, "--mount", `type=bind,source=${output},target=/reports`, "logtura-agent-consumers:test"]);
