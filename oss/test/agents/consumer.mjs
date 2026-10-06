// Runs in a disposable container, with its default empty home and no credentials.
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

cpSync("/marketplace", "/tmp/marketplace", { recursive: true });
const root = "/tmp/marketplace", selector = "logtura@logtura";
const report = { clients: {}, checks: [] };
function run(command, args) {
  const result = spawnSync(command, args, { cwd: "/tmp", encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function find(directory, filename) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? find(join(directory, entry.name), filename) : entry.name === filename ? [join(directory, entry.name)] : []);
}
async function codexSkills(expected = true) {
  const child = spawn("codex", ["app-server"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(); let id = 0, errors = "";
  child.stderr.on("data", data => { errors += String(data); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (pending.has(value.id)) { const { resolve, reject } = pending.get(value.id); pending.delete(value.id); value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result); }
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++id; pending.set(requestId, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
  }
  const timer = setTimeout(() => { for (const { reject } of pending.values()) reject(new Error(`App server timed out: ${errors}`)); child.kill(); }, 20_000);
  try {
    await call("initialize", { clientInfo: { name: "logtura-install-test", version: "1.0.0" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const result = await call("skills/list", { cwds: [root], forceReload: true });
    const skills = result.data.flatMap(entry => entry.skills);
    const skill = skills.find(skill => skill.name === "logtura:logtura");
    if (!expected) { assert.equal(skill, undefined, "Removed skill is still discovered"); return null; }
    assert.ok(skill, `Codex did not discover Logtura: ${JSON.stringify(result)}`);
    assert.ok(readFileSync(skill.path, "utf8").includes("# Logtura onboarding"));
    assert.ok(existsSync(join(skill.path.replace(/\/SKILL.md$/, ""), "references/providers/railway.md")));
    return skill;
  } finally { clearTimeout(timer); lines.close(); child.kill(); }
}

report.clients.claude = run("claude", ["--version"]).trim();
report.clients.codex = run("codex", ["--version"]).trim();
report.clients.gitLfs = run("git", ["lfs", "version"]).trim();
run("claude", ["plugin", "validate", join(root, "plugins/logtura")]);
run("claude", ["plugin", "validate", root]);
run("claude", ["plugin", "marketplace", "add", root]);
run("claude", ["plugin", "install", selector, "--scope", "user"]);
const details = run("claude", ["plugin", "details", "logtura"]);
assert.match(details, /logtura/);
assert.match(details, /Skills/);
assert.ok(find("/root/.claude/plugins/cache", "SKILL.md").some(file => readFileSync(file, "utf8").includes("# Logtura onboarding")));
report.checks.push("claude native validation, installation, skill inventory and contained references");
run("codex", ["plugin", "marketplace", "add", root]);
run("codex", ["plugin", "add", selector]);
await codexSkills();
report.checks.push("codex native installation and app-server skill discovery");
for (const cache of ["/root/.claude/plugins/cache", "/root/.codex/plugins"]) {
  assert.ok(find(cache, "logo.png").some(file => readFileSync(file).subarray(0, 8).toString("hex") === "89504e470d0a1a0a"), "Installed plugin branding must be hydrated PNG bytes, not an LFS pointer");
}
report.checks.push("both installed packages contain hydrated PNG branding");

for (const name of ["plugin.json", ".claude-plugin/plugin.json"]) {
  const file = join(root, "plugins/logtura", name), manifest = JSON.parse(readFileSync(file));
  manifest.version = "99.0.0"; writeFileSync(file, JSON.stringify(manifest));
}
const updated = join(root, "plugins/logtura/skills/logtura/SKILL.md");
writeFileSync(updated, `${readFileSync(updated, "utf8")}\nNative installer update fixture marker.\n`);
run("claude", ["plugin", "update", selector]);
assert.ok(find("/root/.claude/plugins/cache", "plugin.json").some(file => JSON.parse(readFileSync(file)).version === "99.0.0"));
run("codex", ["plugin", "add", selector]);
const refreshed = await codexSkills();
assert.ok(readFileSync(refreshed.path, "utf8").includes("Native installer update fixture marker"));
assert.ok(find("/root/.codex/plugins", "plugin.json").some(file => JSON.parse(readFileSync(file)).version === "99.0.0"));
assert.ok(find("/root/.claude/plugins/cache", "SKILL.md").some(file => file.includes("99.0.0") && readFileSync(file, "utf8").includes("Native installer update fixture marker")));
report.checks.push("both clients reload an updated local-marketplace package");
run("claude", ["plugin", "uninstall", selector]);
run("codex", ["plugin", "remove", selector]);
await codexSkills(false);
assert.ok(!JSON.stringify(JSON.parse(run("codex", ["plugin", "list", "--json"]))).includes('"installed":true'));
report.checks.push("both native uninstall commands complete");
mkdirSync("/reports", { recursive: true });
writeFileSync("/reports/native-install.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
