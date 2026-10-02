import { build } from "esbuild";
import { chmodSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cli = pkg.name === "@logtura/cli";
const entry = cli ? "main" : "index";
rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: [`src/${entry}.ts`], outfile: `dist/${entry}.js`,
  bundle: true, packages: "external", format: "esm", platform: cli ? "node" : "neutral",
  target: "es2022", sourcemap: true, define: {__LOGTURA_PACKAGE_VERSION__: JSON.stringify(pkg.version)},
});
const types = spawnSync("tsc", ["-p", "tsconfig.build.json"], { stdio: "inherit" });
if (types.status !== 0) throw new Error(`Declaration build failed for ${pkg.name}`);
// Sources use bundler resolution; emitted ESM declarations must also resolve
// with NodeNext/Node16. Rewrite module nodes, never comments or literal types.
function declarationFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? declarationFiles(path) : entry.name.endsWith(".d.ts") ? [path] : [];
  });
}
for (const file of declarationFiles("dist")) {
  const content = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const changes = [];
  function rewrite(literal) {
    if (!literal || !ts.isStringLiteral(literal) || !literal.text.startsWith(".")) return;
    const specifier = literal.text;
    if (/\.(?:[cm]?js|json)$/.test(specifier)) return;
    const target = resolve(dirname(file), specifier);
    const resolved = existsSync(`${target}.d.ts`) ? `${specifier}.js` :
      existsSync(join(target, "index.d.ts")) ? `${specifier.replace(/\/$/, "")}/index.js` : null;
    if (!resolved) throw new Error(`Unresolved relative declaration import in ${file}: ${specifier}`);
    changes.push({start: literal.getStart(source), end: literal.end, text: JSON.stringify(resolved)});
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) rewrite(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) rewrite(node.argument.literal);
    else if (ts.isExternalModuleReference(node)) rewrite(node.expression);
    else if (ts.isModuleDeclaration(node)) rewrite(node.name);
    ts.forEachChild(node, visit);
  }
  visit(source);
  let output = content;
  for (const change of changes.sort((a, b) => b.start - a.start)) output = output.slice(0, change.start) + change.text + output.slice(change.end);
  if (changes.length) writeFileSync(file, output);
}
if (cli) {
  await build({entryPoints:["src/runtime-bin.ts"],outfile:"dist/runtime-bin.js",bundle:true,
    format:"esm",platform:"node",target:"node22",banner:{js:"#!/usr/bin/env node"}});
  chmodSync("dist/runtime-bin.js",0o755);
  writeFileSync("dist/bin.js", '#!/usr/bin/env node\nimport { main } from "./main.js";\nprocess.exitCode = await main();\n');
  chmodSync("dist/bin.js", 0o755);
}
