import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const metrics = ["lines", "statements", "functions", "branches"];
const scopes = ["Public packages", "Service backend", "Web UI"];
const patchFloor = 95;
function sourcePath(file, root) {
  const name = relative(root, resolve(root, file)).replaceAll("\\", "/");
  if (name.startsWith("../") || name === "..") throw new Error("Coverage source is outside this checkout");
  return name;
}
function sourceScope(file) {
  if (/^packages\/[^/]+\/src\/.*\.ts$/.test(file)) return scopes[0];
  if (/^src\/web\/.*\.(ts|tsx)$/.test(file)) return scopes[2];
  if (/^src\/.*\.(ts|tsx)$/.test(file)) return scopes[1];
  return null;
}
function eligible(file) {
  return sourceScope(file) !== null && !/\.(d\.ts|test\.[^/]+)$/.test(file);
}
function count(value, label) {
  if (!value || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.covered)
    || value.total < 0 || value.covered < 0 || value.covered > value.total) {
    throw new Error(`Malformed coverage counts: ${label}`);
  }
  return { total: value.total, covered: value.covered };
}
export function readReports(directories, root = process.cwd()) {
  const files = new Map();
  const lines = new Map();
  for (const directory of directories) {
    const summary = JSON.parse(readFileSync(resolve(root, directory, "coverage-summary.json"), "utf8"));
    for (const metric of metrics) count(summary.total?.[metric], `${directory}: total ${metric}`);
    let fileCount = 0;
    for (const [file, data] of Object.entries(summary)) {
      if (file === "total") continue;
      const name = sourcePath(file, root);
      if (!eligible(name)) throw new Error(`Unexpected measured source: ${name}`);
      if (files.has(name)) throw new Error(`Source measured by more than one report: ${name}`);
      files.set(name, Object.fromEntries(metrics.map((metric) => [metric, count(data[metric], `${name}: ${metric}`)])));
      fileCount++;
    }
    if (!fileCount) throw new Error(`Empty coverage report: ${directory}`);
    for (const metric of metrics) {
      const totals = Object.entries(summary).filter(([name]) => name !== "total")
        .reduce((sum, [, data]) => ({ total: sum.total + data[metric].total, covered: sum.covered + data[metric].covered }), { total: 0, covered: 0 });
      if (totals.total !== summary.total[metric].total || totals.covered !== summary.total[metric].covered) {
        throw new Error(`JSON aggregate and file counts disagree: ${directory}: ${metric}`);
      }
    }
    const lcov = readFileSync(resolve(root, directory, "lcov.info"), "utf8");
    let current = null;
    for (const record of lcov.split(/\r?\n/)) {
      if (record.startsWith("SF:")) {
        if (current !== null) throw new Error(`Unterminated LCOV record: ${directory}`);
        current = sourcePath(record.slice(3), root);
        if (!files.has(current) || lines.has(current)) throw new Error(`Unexpected or duplicate LCOV source: ${current}`);
        lines.set(current, new Map());
      } else if (record.startsWith("DA:")) {
        const match = /^DA:(\d+),(\d+)(?:,[^,]+)?$/.exec(record);
        if (!current || !match || Number(match[1]) < 1 || !Number.isSafeInteger(Number(match[1]))
          || !Number.isSafeInteger(Number(match[2]))) throw new Error(`Malformed LCOV line: ${directory}`);
        const fileLines = lines.get(current);
        const line = Number(match[1]);
        if (fileLines.has(line)) throw new Error(`Duplicate LCOV line: ${current}:${line}`);
        fileLines.set(line, Number(match[2]) > 0);
      } else if (record === "end_of_record") {
        if (!current) throw new Error(`LCOV record without source: ${directory}`);
        current = null;
      }
    }
    if (current !== null) throw new Error(`Unterminated LCOV record: ${directory}`);
  }
  for (const [name, data] of files) {
    const measured = lines.get(name) ?? new Map();
    if (measured.size !== data.lines.total || [...measured.values()].filter(Boolean).length !== data.lines.covered) {
      throw new Error(`LCOV and JSON line counts disagree: ${name}`);
    }
  }
  const groups = new Map(scopes.map((scope) => [scope, Object.fromEntries(metrics.map((metric) => [metric, { total: 0, covered: 0 }]))]));
  for (const [file, data] of files) {
    for (const metric of metrics) {
      const group = groups.get(sourceScope(file))[metric];
      group.total += data[metric].total;
      group.covered += data[metric].covered;
    }
  }
  return { files, lines, groups, sourceRoot: root };
}
export function changedLines(diff) {
  const changes = new Map();
  let file = null;
  let inHunk = false;
  for (const record of diff.split(/\r?\n/)) {
    if (record.startsWith("diff --git ")) { file = null; inHunk = false; }
    if (!inHunk && record.startsWith("+++ b/")) {
      file = record.slice(6);
      if (eligible(file) && !changes.has(file)) changes.set(file, new Set());
    } else if (!inHunk && record.startsWith("+++ ") && record !== "+++ /dev/null") {
      throw new Error("Unsupported quoted diff path; cannot safely compute patch coverage");
    } else if (record.startsWith("@@ ")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(record);
      if (!match) throw new Error("Malformed diff hunk");
      inHunk = true;
      if (!changes.has(file)) continue;
      const start = Number(match[1]);
      const length = match[2] === undefined ? 1 : Number(match[2]);
      for (let line = start; line < start + length; line++) changes.get(file).add(line);
    }
  }
  return changes;
}
/** Istanbul can omit pure re-export barrels: their own source contains no
 * executable statements. Parse actual checkout source, never infer this from a
 * filename or a missing report. Anything else still requires instrumentation. */
function reexportsOnly(file, root) {
  if (typeof root !== "string") return false;
  try {
    if (sourcePath(file, root) !== file) return false;
    const parsed = ts.createSourceFile(file, readFileSync(resolve(root, file), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    return parsed.parseDiagnostics.length === 0 && parsed.statements.length > 0
      && parsed.statements.every(statement => ts.isExportDeclaration(statement)
        && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier));
  } catch { return false; }
}
export function patchCoverage(changes, reports) {
  const result = { covered: 0, total: 0, uncovered: [] };
  for (const [file, changed] of changes) {
    if (!changed.size) continue;
    if (!reports.files.has(file)) {
      if (reexportsOnly(file, reports.sourceRoot)) continue;
      throw new Error(`Changed source is missing from coverage: ${file}`);
    }
    const measured = reports.lines.get(file) ?? new Map();
    for (const line of changed) {
      if (!measured.has(line)) continue; // Comments, types, and other non-instrumented lines.
      result.total++;
      if (measured.get(line)) result.covered++;
      else result.uncovered.push(`${file}:${line}`);
    }
  }
  result.passed = result.total === 0 || result.covered * 100 >= patchFloor * result.total;
  return result;
}
function percentage({ covered, total }) {
  return total === 0 ? "—" : `${(covered / total * 100).toFixed(2)}% (${covered}/${total})`;
}
export function renderSummary(reports, patch, artifactUrl) {
  const output = ["## Coverage", "", "Measured locally by Istanbul; aggregate and module thresholds are enforced by Vitest.", "",
    "| Scope | Lines | Statements | Functions | Branches |", "| --- | --- | --- | --- | --- |"];
  for (const [scope, data] of reports.groups) {
    if (metrics.some((metric) => data[metric].total > 0)) output.push(`| ${scope} | ${metrics.map((metric) => percentage(data[metric])).join(" | ")} |`);
  }
  output.push("", `Changed executable lines: **${percentage(patch)}**. Required: ${patchFloor}%. **${patch.passed ? "PASS" : "FAIL"}**.`);
  if (!patch.total) output.push("No instrumented executable lines changed.");
  if (patch.uncovered.length) output.push("", "Uncovered changed lines:", "", ...patch.uncovered.slice(0, 100).map((line) => `- \`${line}\``));
  if (patch.uncovered.length > 100) output.push(`- …and ${patch.uncovered.length - 100} more (see the job log).`);
  if (artifactUrl && /^https:\/\//.test(artifactUrl)) output.push("", `[Download HTML, LCOV, and JSON reports](${artifactUrl}).`);
  return output.join("\n") + "\n";
}
function git(args, root) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
export function run(args, env = process.env, root = process.cwd()) {
  const directories = [];
  let base;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--report" && args[index + 1]) directories.push(args[++index]);
    else if (args[index] === "--base" && args[index + 1]) base = args[++index];
    else throw new Error("Usage: coverage-report.mjs --report <directory> [--report <directory>] [--base <commit>]");
  }
  if (!directories.length) throw new Error("At least one coverage report is required");
  if (!base && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    base = event.pull_request?.base?.sha ?? event.before;
    if (!/^[0-9a-f]{40,64}$/.test(base ?? "")) throw new Error("GitHub event has no valid coverage base commit");
  }
  // The initial push has no parent. Compare its whole tree with Git's empty tree.
  if (base && /^0+$/.test(base)) base = execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], { cwd: root, input: "", encoding: "utf8" }).trim();
  base ??= "HEAD^";
  const baseCommit = git(["rev-parse", "--verify", `${base}^{tree}`], root).trim();
  const diff = git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", baseCommit, "HEAD", "--", "packages", "src"], root);
  const reports = readReports(directories, root);
  const patch = patchCoverage(changedLines(diff), reports);
  const summary = renderSummary(reports, patch, env.COVERAGE_ARTIFACT_URL);
  console.log(summary);
  if (patch.uncovered.length > 100) console.log(patch.uncovered.join("\n"));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  if (!patch.passed) throw new Error(`Changed executable line coverage is below ${patchFloor}%`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(process.argv.slice(2)); }
  catch (error) {
    const message = `Coverage reporting failed: ${error.message}`;
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**${message.replaceAll("\n", " ")}**\n`);
    process.exitCode = 1;
  }
}
