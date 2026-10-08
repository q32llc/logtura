import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packageRoot = existsSync(join(publicRoot, "packages")) ? publicRoot : dirname(publicRoot);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
export function metadata(version, catalog) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const identity = { name: "logtura", version, description: "Configure and operate the open-source Logtura CLI and forwarder across supported log sources and destinations. No Logtura account is required.", author: { name: "Logtura", url: "https://github.com/logtura" }, homepage: "https://logtura.com/docs/agent-skills", repository: "https://github.com/logtura/logtura", license: "Apache-2.0" };
  return {
    "plugins/logtura/plugin.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...identity, keywords: ["logtura", "logs", "cloudflare", "fly", "railway", "vercel", "supabase"], extensions: { "com.openai": { publication: { countries: [] }, interface: { displayName: "Logtura", shortDescription: "Configure open-source log forwarding", longDescription: "Configure and operate the open-source Logtura CLI, library, and forwarder across supported log sources and destinations. Set up standalone forwarding, filters, deployments, delivery verification, and provider integrations. A Logtura account is optional; website synchronization is available for linked deployments.", developerName: "Logtura", category: "Developer Tools", defaultPrompt: "Configure this project's log forwarding with open-source Logtura and verify delivery.", websiteURL: identity.homepage, supportURL: "https://logtura.com/support", privacyPolicyURL: "https://logtura.com/privacy", termsOfServiceURL: "https://logtura.com/terms", logo: "assets/logo.png", composerIcon: "assets/logo.png" } } } },
    "plugins/logtura/.claude-plugin/plugin.json": identity,
    ".claude-plugin/marketplace.json": { name: "logtura", owner: identity.author, plugins: [{ name: "logtura", source: "./plugins/logtura", description: identity.description }] },
    ".agents/plugins/marketplace.json": { name: "logtura", plugins: [{ name: "logtura", source: { source: "local", path: "./plugins/logtura" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }] },
    "plugins/logtura/skills/logtura/references/provider-capabilities.json": { cliVersion: version, forwarderTargets: ["docker", "fly"], providers: catalog },
  };
}

export function files(directory, prefix = "") {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), key = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), `Symlink cannot be packaged: ${key}`);
    assert.ok(!/(?:^|\/)(?:\.env(?:\..*)?|node_modules|\.git|\.local|\.aws)(?:\/|$)/.test(key), `Private file cannot be packaged: ${key}`);
    return stat.isDirectory() ? files(path, key) : [key];
  });
}

export function validate(directory, expected) {
  for (const [file, value] of Object.entries(expected)) assert.deepEqual(JSON.parse(readFileSync(join(directory, file), "utf8")), value, `Stale generated metadata: ${file}; run agent-artifacts.mjs --write after building packages`);
  const plugin = join(directory, "plugins/logtura"), names = files(plugin);
  assert.ok(names.includes("skills/logtura/SKILL.md"));
  for (const name of names.filter(name => name.endsWith(".md"))) {
    const text = readFileSync(join(plugin, name), "utf8");
    assert.ok(!/TODO|\[INSERT|\[REPLACE/.test(text), `Unfinished instructions: ${name}`);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const absolute = resolve(dirname(join(plugin, name)), target);
      const inside = relative(plugin, absolute);
      assert.ok(inside && !inside.startsWith("..") && !inside.startsWith("/"), `Reference escapes plugin: ${name}`);
      assert.ok(existsSync(absolute), `Missing reference: ${name} → ${target}`);
    }
  }
  const listing = expected["plugins/logtura/plugin.json"].extensions["com.openai"].interface;
  for (const field of ["logo", "composerIcon"]) {
    const path = resolve(plugin, listing[field]);
    assert.ok(relative(plugin,path) && !relative(plugin,path).startsWith(".."), "Listing icon escapes plugin");
    const bytes = readFileSync(path);
    assert.equal(bytes.subarray(0,8).toString("hex"), "89504e470d0a1a0a", "Listing icon must be PNG");
    assert.ok(bytes.length <= 5*1024*1024);
    const size = field === "logo" ? 256 : 48;
    assert.ok(bytes.readUInt32BE(16) >= size && bytes.readUInt32BE(16) === bytes.readUInt32BE(20), "Listing icon must be square and large enough");
  }
  const entry = readFileSync(join(plugin, "skills/logtura/SKILL.md"), "utf8");
  assert.match(entry, /^---\nname: logtura\ndescription: .+\n/);
  assert.ok(entry.split("\n").length < 500, "Move conditional detail into references");
  return names;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
}

export function archive(directory, output, expected) {
  const names = validate(directory, expected), version = expected["plugins/logtura/plugin.json"].version;
  assert.ok(!existsSync(output), "Archive output must be a new directory");
  mkdirSync(output, { recursive: true });
  const zip = `logtura-plugin-${version}.zip`, skill = `logtura-skill-${version}.tar.gz`;
  run("zip", ["-q", "-X", resolve(output, zip), ...names.map(name => `logtura/${name}`)], join(directory, "plugins"));
  run("tar", ["-czf", resolve(output, skill), "logtura"], join(directory, "plugins/logtura/skills"));
  const hashes = Object.fromEntries([zip, skill].map(file => [file, createHash("sha256").update(readFileSync(join(output, file))).digest("hex")]));
  writeFileSync(join(output, "agent-artifacts.json"), json({ version, files: hashes, payloadFiles: names }));
  return hashes;
}

export function verifyAgentArchives(directory, version) {
  const manifest = JSON.parse(readFileSync(join(directory, "agent-artifacts.json"), "utf8"));
  assert.equal(manifest.version, version);
  const expected = [`logtura-plugin-${version}.zip`, `logtura-skill-${version}.tar.gz`].sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), expected, "Incomplete or foreign agent archive inventory");
  for (const file of expected) assert.equal(createHash("sha256").update(readFileSync(join(directory, file))).digest("hex"), manifest.files[file], `Agent archive differs from tested bytes: ${file}`);
  return manifest;
}

export async function runArtifacts(args, roots = { publicRoot, packageRoot }) {
  const pkg = JSON.parse(readFileSync(join(roots.packageRoot, "packages/cli/package.json"), "utf8"));
  const { PROVIDER_CATALOG, validateProviderCatalog } = await import(pathToFileURL(join(roots.packageRoot, "packages/core/dist/index.js")));
  const { listProviders } = await import(pathToFileURL(join(roots.packageRoot, "packages/cli/dist/registry.js")));
  validateProviderCatalog(PROVIDER_CATALOG);
  assert.deepEqual(listProviders().map(driver => driver.id), PROVIDER_CATALOG.map(entry => entry.id), "Public registry and catalog differ");
  for (const descriptor of PROVIDER_CATALOG) assert.equal(listProviders().find(driver => driver.id === descriptor.id).capabilities.selection, descriptor.selection.mode, `Wrong selection capability: ${descriptor.id}`);
  const expected = metadata(pkg.version, PROVIDER_CATALOG);
  if (args[0] === "--write") {
    assert.equal(args.length, 1);
    for (const [file, value] of Object.entries(expected)) { mkdirSync(dirname(join(roots.publicRoot, file)), { recursive: true }); writeFileSync(join(roots.publicRoot, file), json(value)); }
  } else if (args[0] === "--archive") {
    assert.equal(args.length, 2, "--archive requires a new output directory");
    archive(roots.publicRoot, resolve(args[1]), expected);
  } else assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--check"), "Use --write, --check, or --archive DIR");
  validate(roots.publicRoot, expected);
  console.log(`Validated Logtura ${pkg.version} agent package and ${PROVIDER_CATALOG.length} provider descriptors`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runArtifacts(process.argv.slice(2));
