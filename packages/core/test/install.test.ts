import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installBundleFiles, renderEnvFile } from "../src/install";
import { buildTar } from "../src/tar";
import type { GeneratedBundle } from "../src/types";

const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "logtura-install-test-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function bundle(value: string | null = "test-secret"): GeneratedBundle {
  return { dockerfile: "FROM scratch", vectorYaml: "sources: {}", runtimeAssets: [{driverId: "test", path: "helper.sh", content: "echo ok", mode: 0o755}], runCommand: "", envVars: [{name: "TEST_SECRET", description: "credential\nkeep private", source: "credential", value}], selectedCount: 0, monitorSummary: "", componentManifest: [] };
}
function installer(value: string | null = "test-secret") {
  const dir = temp();
  const files = installBundleFiles(bundle(value));
  for (const file of files.filter(f => !f.name.includes("/assets/"))) writeFileSync(join(dir, file.name.split("/").at(-1)!), file.content, {mode: file.mode});
  // Record only the inherited variable and arguments; no Docker service needed.
  writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\nif [ "$1" = run ]; then printf "%s" "$TEST_SECRET" > "$VALUE_FILE"; fi\n', {mode: 0o755});
  const env = {...process.env, PATH: `${dir}:${process.env.PATH}`, RECORD: join(dir,"calls"), VALUE_FILE: join(dir,"value"), TEST_SECRET: ""};
  return {dir, env, run: (...args: string[]) => spawnSync("sh", ["install.sh", ...args], {cwd: dir, env, encoding: "utf8"})};
}

describe("shared install files", () => {
  it("keeps modes, runtime assets and the existing component manifest", () => {
    const files = installBundleFiles(bundle(), "My Forwarder", "Display name");
    expect(files.map(f => f.name)).toContain("my-forwarder/assets/test/helper.sh");
    expect(files.find(f => f.name.endsWith("/.env"))?.mode).toBe(0o600);
    expect(files.find(f => f.name.endsWith("/install.sh"))?.mode).toBe(0o755);
    expect(files.find(f => f.name.endsWith("/manifest.json"))?.content).toBe("[]");
    expect(files.find(f => f.name.endsWith("/README.md"))?.content).toContain("# Display name");
    expect(installBundleFiles(bundle(), "")[0]?.name).toBe("logtura/Dockerfile");
  });
  it.each(["plain", "quotes'\" spaces $value `command` \\path", "first\nsecond", "$(touch should-never-exist)"])("passes secrets unchanged to the runtime: %j", value => {
    const i = installer(value); const result = i.run("--non-interactive");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(i.dir,"value"),"utf8")).toBe(value);
    expect(readFileSync(join(i.dir,"calls"),"utf8")).toContain("-e TEST_SECRET");
  });
  it("dry-run performs no runtime mutations", () => {
    const i = installer(); const result = i.run("--dry-run");
    expect(result.status).toBe(0); expect(result.stdout).toContain("would build and run");
    expect(() => readFileSync(join(i.dir,"calls"))).toThrow();
  });
  it("help and unknown flags exit before runtime access", () => {
    const i = installer(); expect(i.run("--help").status).toBe(0); expect(i.run("--bogus").status).toBe(2);
  });
  it.each([null, ""])("missing credentials fail without changing the running forwarder", value => {
    const i = installer(value); const result = i.run("--non-interactive");
    expect(result.status).toBe(1); expect(result.stderr).toContain("missing env keys");
    expect(() => readFileSync(join(i.dir,"calls"))).toThrow();
    expect(i.run().stderr).toContain("no TTY");
  });
  it("checks values cleared after generation", () => {
    const i = installer(); writeFileSync(join(i.dir,".env"), "TEST_SECRET=''\n");
    expect(i.run("--non-interactive").status).toBe(1);
  });
  it.each(["X;echo bad", "X Y", "1NAME", "A\nB"])("rejects invalid environment keys: %j", name => {
    const b = bundle(); b.envVars[0]!.name = name;
    expect(() => installBundleFiles(b)).toThrow("Invalid environment variable");
    expect(() => renderEnvFile(b.envVars)).toThrow("Invalid environment variable");
  });
  it("rejects NUL in secrets and path traversal in assets", () => {
    expect(() => installBundleFiles(bundle("a\0b"))).toThrow("NUL");
    const b = bundle(); b.runtimeAssets[0]!.path = "../../escape";
    expect(() => buildTar(installBundleFiles(b))).toThrow("unsafe path");
  });
});

describe("shared tar writer", () => {
  it("produces reproducible archives native tar can extract with exact UTF-8 and modes", () => {
    const dir = temp(); const files = [{name: "hello.txt", content: "héllo 🌏"}, {name:"script.sh",content:"#!/bin/sh\n",mode:0o755,mtime:123}];
    const bytes = buildTar(files); expect(buildTar(files)).toEqual(bytes);
    writeFileSync(join(dir,"archive.tar"),bytes);
    const result = spawnSync("tar", ["xf", "archive.tar"], {cwd:dir,encoding:"utf8"});
    expect(result.status, result.stderr).toBe(0); expect(readFileSync(join(dir,"hello.txt"),"utf8")).toBe("héllo 🌏");
    const list = spawnSync("tar", ["tvf", "archive.tar"], {cwd:dir,encoding:"utf8"});
    expect(list.stdout).toContain("-rwxr-xr-x");
  });
  it("handles binary bodies, block boundaries and an empty archive", () => {
    expect(buildTar([])).toEqual(new Uint8Array(1024));
    const body = new Uint8Array(513).fill(255); const tar = buildTar([{name:"data",content:body}]);
    expect(tar.length).toBe(2560); expect(tar.slice(512,1025)).toEqual(body);
  });
  it.each(["", "/absolute", "../escape", "a/../b", "a/./b", "a//b", "a\\b", "nul\0path"])("rejects unsafe paths: %j", name => {
    expect(() => buildTar([{name,content:""}])).toThrow("unsafe path");
  });
  it("rejects duplicate and byte-overlong paths", () => {
    expect(() => buildTar([{name:"x",content:""},{name:"x",content:""}])).toThrow("duplicate");
    expect(() => buildTar([{name:"é".repeat(51),content:""}])).toThrow("100 bytes");
    expect(() => buildTar([{name:"a".repeat(100),content:""}])).not.toThrow();
  });
  it.each([-1, NaN, Infinity, 1.5, 2**40])("rejects invalid numeric header fields: %j", mode => {
    expect(() => buildTar([{name:"x",content:"",mode}])).toThrow("numeric");
  });
});
