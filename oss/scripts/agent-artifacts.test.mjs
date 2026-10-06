import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { archive, metadata, validate, publicRoot, verifyAgentArchives } from "./agent-artifacts.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "logtura-agent-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(publicRoot, "plugins"), join(root, "plugins"), { recursive: true });
  const expected = metadata("0.3.5", []);
  for (const [file, value] of Object.entries(expected)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), JSON.stringify(value)); }
  return { root, expected };
}
test("a portable payload archives all references and hidden compatibility manifests", t => {
  const { root, expected } = fixture(t), out = join(root, "archives");
  const hashes = archive(root, out, expected);
  assert.equal(verifyAgentArchives(out, "0.3.5").version, "0.3.5");
  assert.equal(Object.keys(hashes).length, 2);
  const extract = join(root, "extract"); mkdirSync(extract);
  const unzip = spawnSync("unzip", ["-q", join(out, "logtura-plugin-0.3.5.zip"), "-d", extract]); assert.equal(unzip.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(extract, "logtura/.claude-plugin/plugin.json"))), expected["plugins/logtura/.claude-plugin/plugin.json"]);
  assert.ok(readFileSync(join(extract, "logtura/skills/logtura/references/providers/railway.md")).length);
  assert.throws(() => archive(root, out, expected), /new directory/);
  assert.equal(spawnSync("tar", ["-tzf", join(out, "logtura-skill-0.3.5.tar.gz")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).every(file => file.startsWith("logtura/")), true);
});
test("archive receipt rejects substitution, missing files and foreign inventory", t => {
  const { root, expected } = fixture(t), out = join(root, "archives");
  archive(root, out, expected);
  assert.throws(() => verifyAgentArchives(out, "0.3.6"));
  writeFileSync(join(out, "logtura-plugin-0.3.5.zip"), "substituted");
  assert.throws(() => verifyAgentArchives(out, "0.3.5"), /tested bytes/);
  const file = join(out, "agent-artifacts.json"), receipt = JSON.parse(readFileSync(file));
  receipt.files["../foreign.zip"] = "wrong"; writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => verifyAgentArchives(out, "0.3.5"), /inventory/);
});
test("metadata drift cannot silently ship with another CLI version", t => {
  const { root, expected } = fixture(t);
  writeFileSync(join(root, "plugins/logtura/plugin.json"), JSON.stringify({ ...expected["plugins/logtura/plugin.json"], version: "0.3.4" }));
  assert.throws(() => validate(root, expected), /Stale generated metadata/);
  assert.throws(() => metadata("v1.0.0", []));
});
test("a referenced file must be contained and present", t => {
  const { root, expected } = fixture(t), entry = join(root, "plugins/logtura/skills/logtura/SKILL.md");
  const text = readFileSync(entry, "utf8");
  writeFileSync(entry, `${text}\n[escape](../../../../package.json)`); assert.throws(() => validate(root, expected), /escapes plugin/);
  writeFileSync(entry, `${text}\n[missing](references/absent.md)`); assert.throws(() => validate(root, expected), /Missing reference/);
});
test("private files and symlinks cannot enter the package", t => {
  const { root, expected } = fixture(t), plugin = join(root, "plugins/logtura");
  writeFileSync(join(plugin, ".env"), "fixture-secret"); assert.throws(() => validate(root, expected), /Private file/); rmSync(join(plugin, ".env"));
  symlinkSync("/etc/passwd", join(plugin, "secret.md")); assert.throws(() => validate(root, expected), /Symlink/);
});
