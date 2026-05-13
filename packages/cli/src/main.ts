#!/usr/bin/env -S node --import tsx
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateBundle } from "@logtura/core";
import { loadConfigFile } from "./config";
import { buildInstallArchive, installBundleFiles } from "./install";
import { printStats } from "./metrics";

interface Args {
  command: string;
  config: string;
  output?: string;
  metrics?: string;
  vectorValidate: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  try {
    if (args.command === "help" || args.command === "") {
      console.log(help());
      return 0;
    }
    if (args.command === "stats") {
      if (!args.metrics) throw new Error("stats requires --metrics <file>");
      console.log(printStats(args.metrics));
      return 0;
    }

    const parsed = loadConfigFile(args.config);
    const bundle = generateBundle(parsed.input);
    if (parsed.missingEnv.length > 0) {
      console.warn(`missing env: ${parsed.missingEnv.join(", ")}`);
    }

    if (args.command === "validate") {
      validateVectorIfRequested(bundle.vectorYaml, args.vectorValidate);
      console.log(
        `ok: ${bundle.selectedCount} source(s), ${bundle.monitorSummary}`,
      );
      return parsed.missingEnv.length > 0 ? 2 : 0;
    }

    if (args.command === "bundle") {
      const outDir = resolve(args.output ?? "dist/logtura");
      mkdirSync(outDir, { recursive: true });
      for (const f of installBundleFiles(bundle, "logtura-forwarder")) {
        const rel = f.name.replace(/^logtura-forwarder\//, "");
        const dest = resolve(outDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.content);
      }
      console.log(`wrote ${outDir}`);
      return 0;
    }

    if (args.command === "install-zip") {
      const out = resolve(args.output ?? "logtura-forwarder.tgz");
      writeFileSync(out, buildInstallArchive(bundle, "logtura-forwarder"));
      console.log(`wrote ${out}`);
      return 0;
    }

    throw new Error(`unknown command: ${args.command}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    command: argv[0] ?? "help",
    config: "logtura.yaml",
    vectorValidate: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-c" || a === "--config") out.config = needValue(argv, ++i, a);
    else if (a === "-o" || a === "--output") out.output = needValue(argv, ++i, a);
    else if (a === "--metrics") out.metrics = needValue(argv, ++i, a);
    else if (a === "--vector-validate") out.vectorValidate = true;
    else if (a === "-h" || a === "--help") out.command = "help";
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

function needValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function validateVectorIfRequested(vectorYaml: string, enabled: boolean) {
  if (!enabled) return;
  if (!existsSync("vector.yaml.tmp")) {
    // Keep the temp file in the current working directory so Vector's
    // diagnostics show a short path.
  }
  writeFileSync("vector.yaml.tmp", vectorYaml);
  const res = spawnSync("vector", ["validate", "vector.yaml.tmp"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(res.stderr || res.stdout || "vector validate failed");
  }
}

function help(): string {
  return `logtura <command> [options]

Commands:
  validate      Parse config and render a bundle without writing files
  bundle        Write Dockerfile, vector.yaml, manifest.json, .env, install.sh
  install-zip   Write a gzipped install archive
  stats         Print a simple table from Vector internal_metrics JSON/NDJSON

Options:
  -c, --config <file>      Config file (default: logtura.yaml)
  -o, --output <path>      Output directory/archive path
  --metrics <file>         Metrics JSON/NDJSON for stats
  --vector-validate        Run vector validate on the generated vector.yaml
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
