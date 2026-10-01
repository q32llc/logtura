import { build } from "esbuild";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cli = pkg.name === "@logtura/cli";
const entry = cli ? "main" : "index";
rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: [`src/${entry}.ts`], outfile: `dist/${entry}.js`,
  bundle: true, packages: "external", format: "esm", platform: cli ? "node" : "neutral",
  target: "es2022", sourcemap: true,
});
const types = spawnSync("tsc", ["-p", "tsconfig.build.json"], { stdio: "inherit" });
if (types.status !== 0) throw new Error(`Declaration build failed for ${pkg.name}`);
if (cli) {
  writeFileSync("dist/bin.js", '#!/usr/bin/env node\nimport { main } from "./main.js";\nprocess.exitCode = await main();\n');
  chmodSync("dist/bin.js", 0o755);
}
