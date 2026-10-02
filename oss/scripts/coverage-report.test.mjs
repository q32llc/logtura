import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { changedLines, patchCoverage, readReports, renderSummary } from "./coverage-report.mjs";

const script = fileURLToPath(new URL("./coverage-report.mjs", import.meta.url));
const source = "packages/core/src/example.ts";
const metrics = ["lines", "statements", "functions", "branches"];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "logtura-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function report(root, directory, entries, { absolute = true } = {}) {
  mkdirSync(join(root, directory), { recursive: true });
  const summary = { total: Object.fromEntries(metrics.map((metric) => [metric, { total: 0, covered: 0 }])) };
  const lcov = [];
  for (const [file, hits] of Object.entries(entries)) {
    const covered = hits.filter(Boolean).length;
    summary[absolute ? join(root, file) : file] = Object.fromEntries(metrics.map((metric) => [metric, { total: hits.length, covered }]));
    for (const metric of metrics) {
      summary.total[metric].total += hits.length;
      summary.total[metric].covered += covered;
    }
    lcov.push(`SF:${file}`, ...hits.map((hit, index) => `DA:${index + 1},${hit ? 3 : 0}`), "end_of_record");
  }
  writeFileSync(join(root, directory, "coverage-summary.json"), JSON.stringify(summary));
  writeFileSync(join(root, directory, "lcov.info"), lcov.join("\n"));
}
test("groups real report shapes without double counting separate scopes", (t) => {
  const root = fixture(t);
  report(root, "coverage", { [source]: [true, true, false], "src/worker.ts": [true, false] });
  report(root, "coverage/ui", { "src/web/App.tsx": [true, true] }, { absolute: false });
  const measured = readReports(["coverage", "coverage/ui"], root);
  assert.deepEqual(measured.groups.get("Public packages").lines, { covered: 2, total: 3 });
  assert.deepEqual(measured.groups.get("Service backend").lines, { covered: 1, total: 2 });
  assert.deepEqual(measured.groups.get("Web UI").lines, { covered: 2, total: 2 });
  const summary = renderSummary(measured, { total: 0, covered: 0, uncovered: [], passed: true }, "https://github.com/example/repo/actions/runs/1/artifacts/2");
  assert.match(summary, /66\.67% \(2\/3\)/);
  assert.match(summary, /No instrumented executable lines changed/);
  assert.match(summary, /Download HTML, LCOV, and JSON/);
});
test("multi-hunk diffs measure only added executable lines, including new files", () => {
  const diff = `diff --git a/${source} b/${source}\n--- a/${source}\n+++ b/${source}\n@@ -1 +1,2 @@\n-removed\n+new\n+comment\n@@ -8,2 +9 @@\n+new\ndiff --git a/src/deleted.ts b/src/deleted.ts\n--- a/src/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new\n`;
  const changed = changedLines(diff);
  assert.deepEqual([...changed.get(source)], [1, 2, 9]);
  assert.deepEqual([...changed.get("src/new.ts")], [1]);
  assert.equal(changed.has("src/deleted.ts"), false);
  const measured = { files: new Map([[source, {}], ["src/new.ts", {}]]), lines: new Map([[source, new Map([[1, true], [9, false]])], ["src/new.ts", new Map([[1, true]])]]) };
  assert.deepEqual(patchCoverage(changed, measured), { covered: 2, total: 3, uncovered: [`${source}:9`], passed: false });
});
test("95% passes exactly; one fewer covered line fails", (t) => {
  const root = fixture(t);
  const changed = new Map([[source, new Set(Array.from({ length: 20 }, (_, index) => index + 1))]]);
  report(root, "coverage", { [source]: [...Array(19).fill(true), false] });
  assert.equal(patchCoverage(changed, readReports(["coverage"], root)).passed, true);
  report(root, "coverage", { [source]: [...Array(18).fill(true), false, false] });
  assert.equal(patchCoverage(changed, readReports(["coverage"], root)).passed, false);
});
test("declarations and tests are excluded; unmeasured production files fail", (t) => {
  const root = fixture(t);
  report(root, "coverage", { [source]: [true] });
  const diff = ["src/a.d.ts", "src/web/a.test.tsx", "packages/core/src/a.test.ts", "src/unmeasured.ts"].map((file) => `diff --git a/${file} b/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+new`).join("\n");
  const changed = changedLines(diff);
  assert.deepEqual([...changed.keys()], ["src/unmeasured.ts"]);
  assert.throws(() => patchCoverage(changed, readReports(["coverage"], root)), /missing from coverage/);
});
test("missing expected UI reports, malformed JSON, and empty reports fail", (t) => {
  const root = fixture(t);
  report(root, "coverage", { [source]: [true] });
  assert.throws(() => readReports(["coverage", "coverage/ui"], root), /ENOENT/);
  writeFileSync(join(root, "coverage/coverage-summary.json"), "{bad");
  assert.throws(() => readReports(["coverage"], root), SyntaxError);
  report(root, "coverage", {});
  assert.throws(() => readReports(["coverage"], root), /Empty coverage report/);
});
test("invalid counts, truncated LCOV, disagreement, and duplicate measurements fail", (t) => {
  const root = fixture(t);
  report(root, "coverage", { [source]: [true] });
  const path = join(root, "coverage/coverage-summary.json");
  const summary = JSON.parse(readFileSync(path, "utf8"));
  summary.total.lines.covered = 2;
  writeFileSync(path, JSON.stringify(summary));
  assert.throws(() => readReports(["coverage"], root), /Malformed coverage counts/);
  summary.total.lines.total = 2;
  writeFileSync(path, JSON.stringify(summary));
  assert.throws(() => readReports(["coverage"], root), /aggregate and file counts disagree/);
  report(root, "coverage", { [source]: [true] });
  writeFileSync(join(root, "coverage/lcov.info"), `SF:${source}\nDA:1,1`);
  assert.throws(() => readReports(["coverage"], root), /Unterminated LCOV/);
  writeFileSync(join(root, "coverage/lcov.info"), `SF:${source}\nDA:1,0\nend_of_record`);
  assert.throws(() => readReports(["coverage"], root), /counts disagree/);
  writeFileSync(join(root, "coverage/lcov.info"), `SF:${source}\nDA:1,1\nDA:1,1\nend_of_record`);
  assert.throws(() => readReports(["coverage"], root), /Duplicate LCOV line/);
  report(root, "coverage", { [source]: [true] });
  report(root, "duplicate", { [source]: [true] });
  assert.throws(() => readReports(["coverage", "duplicate"], root), /more than one report/);
});
test("unsafe source paths and unsupported quoted diffs fail closed", (t) => {
  const root = fixture(t);
  report(root, "coverage", { "../outside.ts": [true] });
  assert.throws(() => readReports(["coverage"], root), /outside this checkout/);
  assert.throws(() => changedLines('+++ "b/src/file with spaces.ts"\n'), /Unsupported quoted diff path/);
  assert.throws(() => changedLines("@@ bad @@"), /Malformed diff hunk/);
});
function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Coverage test", GIT_AUTHOR_EMAIL: "coverage@example.invalid", GIT_COMMITTER_NAME: "Coverage test", GIT_COMMITTER_EMAIL: "coverage@example.invalid" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
test("actual CLI uses PR/push bases, writes the summary, and rejects a failing patch or unavailable base", (t) => {
  const root = fixture(t);
  git(root, "init", "-q");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "baseline");
  const base = git(root, "rev-parse", "HEAD");
  mkdirSync(dirname(join(root, source)), { recursive: true });
  writeFileSync(join(root, source), Array.from({ length: 20 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n");
  git(root, "add", source);
  git(root, "commit", "-qm", "new executable source");
  const event = join(root, "event.json");
  const summary = join(root, "step-summary.md");
  const env = { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary, COVERAGE_ARTIFACT_URL: "" };
  const cli = (...args) => spawnSync(process.execPath, [script, "--report", "coverage", ...args], { cwd: root, env, encoding: "utf8" });
  report(root, "coverage", { [source]: [...Array(19).fill(true), false] });
  for (const body of [{ before: base }, { pull_request: { base: { sha: base } } }, { before: "0".repeat(40) }]) {
    writeFileSync(event, JSON.stringify(body));
    const result = cli();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /95\.00% \(19\/20\)/);
  }
  assert.match(readFileSync(summary, "utf8"), /\*\*PASS\*\*/);
  report(root, "coverage", { [source]: [...Array(18).fill(true), false, false] });
  const failure = cli("--base", base);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /below 95%/);
  assert.match(readFileSync(summary, "utf8"), /\*\*FAIL\*\*/);
  assert.equal(cli("--base", "f".repeat(40)).status, 1);
  writeFileSync(event, "{}");
  assert.match(cli().stderr, /no valid coverage base commit/);
  rmSync(join(root, "coverage/lcov.info"));
  assert.equal(cli("--base", base).status, 1);
});

test("omitted re-export-only barrels have no executable lines; missing executable sources still fail", (t) => {
  const root=fixture(t), barrel="packages/core/src/index.ts";
  mkdirSync(dirname(join(root,barrel)),{recursive:true});
  report(root,"coverage",{[source]:[true]});
  const reports=readReports(["coverage"],root), changed=new Map([[barrel,new Set([1,2])]]);
  for(const content of ["export { value } from './value';", "export * from './value';\nexport type { Shape } from './types';", "// export const ignored = 1;\nexport { type Shape, value as named } from './value';"]){
    writeFileSync(join(root,barrel),content);
    assert.deepEqual(patchCoverage(changed,reports),{covered:0,total:0,uncovered:[],passed:true});
  }
  for(const content of ["export const value = 1;", "export { value } from './value';\nrun();", "import './side-effect';\nexport * from './value';", "export { local };", "export default () => 1;", "export {} from './value';\nif (true) run();", "// export * from './value';", "export * from ;", "export class Value {}"]){
    writeFileSync(join(root,barrel),content);
    assert.throws(()=>patchCoverage(changed,reports),/missing from coverage/);
  }
  rmSync(join(root,barrel));
  assert.throws(()=>patchCoverage(changed,reports),/missing from coverage/);
});


test("omitted interface/type-only modules are non-executable; mixed runtime modules fail", (t) => {
  const root=fixture(t), file="src/web/types.ts";
  mkdirSync(dirname(join(root,file)),{recursive:true});
  report(root,"coverage",{[source]:[true]});
  const reports=readReports(["coverage"],root), changed=new Map([[file,new Set([1,2,3])]]);
  for(const content of [
    "export interface Shape { encoding?: 'base64'; mode?: number }",
    "import type { Value } from './value';\nexport interface Shape { value: Value }\nexport type Name = string;",
    "type Internal = string;\nexport interface Shape { name: Internal }\nexport * from './value';",
    "// A runtime-looking comment: run();\nexport type Name = string;",
  ]) {
    writeFileSync(join(root,file),content);
    assert.deepEqual(patchCoverage(changed,reports),{covered:0,total:0,uncovered:[],passed:true});
  }
  for(const content of [
    "export interface Shape {}\nexport const runtime = 1;",
    "import './side-effect';\nexport type Name = string;",
    "import { Value } from './value';\nexport interface Shape { value: Value }",
    "export enum Mode { A, B }", "export const enum Mode { A, B }",
    "export namespace Runtime { export const value = 1 }",
    "export interface Shape {", "export type Name = ;", "// interface only?",
    "export type Name = string;\nrun();",
  ]) {
    writeFileSync(join(root,file),content);
    assert.throws(()=>patchCoverage(changed,reports),/missing from coverage/);
  }
  rmSync(join(root,file));
  assert.throws(()=>patchCoverage(changed,reports),/missing from coverage/);
});
