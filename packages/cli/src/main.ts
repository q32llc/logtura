import { deploymentStatus } from "./deployment-link";
import { recoverFileTransaction } from "./file-transaction";
import { applyGraphEditFile, diffGraphFiles, diffRemoteGraph, editGraphFile, exportGraphFile, selectGraphSource } from "./graph";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateBundle } from "@logtura/core";
import type { BundleEnvVar } from "@logtura/core";
import {
  defaultProviderName,
  ensureListSection,
  ensureSection,
  findConfigPath,
  loadConfigFile,
  normalizeConfigFile,
  hashConfigFile,
  readConfigDoc,
  safeId,
  writeConfigDoc,
} from "./config";
import { appendMissingEnvKeys, readDotEnvFile, writeEnvValues } from "./local-env";
import { getProviderConnector } from "./provider-connectors";
import {
  allSourceConnectMetadata,
  sourceConnectMetadata,
} from "./source-metadata";
import { installBundleFiles, renderEnvFile } from "./install";
import { accountClient, loginAccount, logoutAccount } from "./account";
import { pullDeploymentConfig } from "./pull";
import { printStats } from "./metrics";

interface GlobalArgs {
  config?: string;
  json: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { global, rest } = parseGlobalArgs(argv);
    const command = rest[0] ?? "help";
    const args = rest.slice(1);
    if (command === "help" || command === "-h" || command === "--help") {
      console.log(help());
      return 0;
    }
    if (command === "init") return cmdInit(global, args);
    if (command === "login" || command === "whoami" || command === "logout") return await cmdAccount(command, global, args);
    if (command === "diff") return await cmdDiff(global,args);
    if (command === "pull") return await cmdPull(global,args);
    if (command === "config") return await cmdConfig(global, args);
    if (command === "connect") return await cmdConnect(global, args);
    if (command === "source") return await cmdSource(global, args);
    if (command === "sink") return cmdSink(global, args);
    if (command === "monitor") return cmdMonitor(global, args);
    if (command === "env") return cmdEnv(global, args);
    if (command === "validate") return cmdValidate(global, args);
    if (command === "bundle") return cmdBundle(global, args);
    if (command === "deploy") return cmdDeploy(global, args);
    if (command === "stats") return cmdStats(args);
    throw new Error(`unknown command: ${command}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function cmdDiff(global:GlobalArgs,args:string[]):Promise<number>{
  const id=args[0];if(!id || id.startsWith("-"))throw new Error("diff requires a deployment identity");const flags=parseFlags(args.slice(1));
  for(const flag of Object.keys(flags))if(flag!=="service")throw new Error(`Unsupported diff option: ${flag}`);
  const result=await diffRemoteGraph(findConfigPath(global.config).path,id,stringFlag(flags,"service"));
  console.log(global.json?JSON.stringify(result):result.changes.length?result.changes.map(c=>`${c.operation} ${c.entity} ${c.id}: ${c.fields.join(", ")}`).join("\n"):"No configuration changes");return 0;
}

async function cmdPull(global:GlobalArgs,args:string[]):Promise<number>{
  const id=args[0];if(!id || id.startsWith("-"))throw new Error("pull requires a deployment identity");
  const flags=parseFlags(args.slice(1));
  for(const flag of Object.keys(flags))if(!["service","output","force"].includes(flag))throw new Error(`Unsupported pull option: ${flag}`);
  const path=stringFlag(flags,"output")??findConfigPath(global.config).path;
  const revision=await pullDeploymentConfig(accountClient(stringFlag(flags,"service")),id,path,booleanFlag(flags,"force"));
  console.log(global.json?JSON.stringify({path,revision}):`Pulled ${id} to ${path} (${revision})`);return 0;
}

async function cmdAccount(command: string, global: GlobalArgs, args: string[]): Promise<number> {
  const flags=parseFlags(args);
  const allowed=command==="login"?["service","name","noBrowser"]:command==="logout"?["service","local"]:["service"];
  for(const flag of Object.keys(flags))if(!allowed.includes(flag))throw new Error(`Unsupported ${command} option: ${flag}`);
  const service=stringFlag(flags,"service");
  if(command==="login")await loginAccount({service,label:stringFlag(flags,"name"),noBrowser:booleanFlag(flags,"noBrowser")});
  else if(command==="logout")await logoutAccount({service,local:booleanFlag(flags,"local")});
  else {const client=accountClient(service);const user=await client.whoami();console.log(global.json?JSON.stringify({service:client.url,user}):`${user.githubLogin} (${user.id}) at ${client.url}`);}
  return 0;
}

async function cmdConfig(global: GlobalArgs, args: string[]): Promise<number> {
  const ref = findConfigPath(global.config);
  if(args[0]==="status"){
    rejectExtra(args.slice(1));console.log(JSON.stringify(await deploymentStatus(ref.path)));return 0;
  }
  if(args[0]==="recover"){
    rejectExtra(args.slice(1));const recovered=recoverFileTransaction(ref.path);
    console.log(global.json?JSON.stringify({path:ref.path,recovered}):recovered?"Recovered interrupted configuration write":"No interrupted configuration write");return 0;
  }
  if(args[0]==="edit" || args[0]==="diff"){
    if(args.length!==2)throw new Error(`config ${args[0]} requires one file`);
    const result=args[0]==="edit"?{revision:await applyGraphEditFile(ref.path,args[1]!)}:await diffGraphFiles(ref.path,args[1]!);
    console.log(JSON.stringify(result));return 0;
  }
  if(args[0]==="export"){
    const flags=parseFlags(args.slice(1));for(const flag of Object.keys(flags))if(!["output","force"].includes(flag))throw new Error(`Unsupported export option: ${flag}`);
    const output=stringFlag(flags,"output")??"portable.yaml";const revision=await exportGraphFile(ref.path,output,booleanFlag(flags,"force"));
    console.log(global.json?JSON.stringify({path:output,revision}):`Exported ${output} (${revision})`);return 0;
  }
  if (args[0] === "hash") {
    rejectExtra(args.slice(1));
    const hash = await hashConfigFile(ref.path);
    console.log(global.json ? JSON.stringify({schemaVersion: 1, hash}) : hash);
    return 0;
  }
  if (args[0] === "normalize") {
    const flags = parseFlags(args.slice(1));
    const output = stringFlag(flags, "output") ?? ref.path;
    const document = normalizeConfigFile(ref.path);
    writeConfigDoc(output, document);
    console.log(global.json ? JSON.stringify({schemaVersion: 1, path: output}) : `normalized ${output}`);
    return 0;
  }
  throw new Error("config supports: status, recover, normalize [-o file], hash, export [-o file], edit <operations.json>, diff <baseline.yaml>");
}

function cmdInit(global: GlobalArgs, args: string[]): number {
  rejectExtra(args);
  const ref = findConfigPath(global.config);
  if (ref.existed) {
    console.log(`using existing ${ref.path}`);
    return 0;
  }
  writeConfigDoc(ref.path, {
    providers: {},
    sources: {},
    sinks: {},
    monitors: [],
  });
  console.log(`created ${ref.path}`);
  return 0;
}

async function cmdConnect(global: GlobalArgs, args: string[]): Promise<number> {
  const provider = args[0];
  if (!provider) throw new Error("connect requires a provider, e.g. logt connect cloudflare");
  const flags = parseFlags(args.slice(1));
  const ref = findConfigPath(global.config);
  const doc = readConfigDoc(ref.path);
  if (doc.kind === "logtura.deployment") throw new Error("Edit portable graph identities and selections in the manifest; this command edits the shorthand configuration format");
  const providers = ensureSection(doc, "providers");
  const name = stringFlag(flags, "name") ?? defaultProviderName(provider, providers);
  const connector = getProviderConnector(provider);
  if (!connector) throw new Error(`unknown provider connector: ${provider}`);
  const envPath = envPathForConfig(ref.path);
  const connected = await connector.connect({
    name,
    env: { values: readDotEnvFile(envPath) },
    options: {
      quiet: booleanFlag(flags, "quiet"),
      force: booleanFlag(flags, "force"),
      token: stringFlag(flags, "token"),
      accountId: stringFlag(flags, "accountId"),
      metadata: connectMetadataForProvider(provider, doc, booleanFlag(flags, "all")),
    },
  });
  if (connected.skipped) return 0;
  const written = writeEnvValues(envPath, connected.envValues, {
    force: true,
  });
  if (written.skipped.length > 0) {
    throw new Error(`${written.skipped.join(", ")} already exists; pass --force to overwrite`);
  }

  const entry = (providers[name] && isRecord(providers[name]) ? providers[name] : {}) as Record<string, unknown>;
  entry.provider = provider;
  entry.display_name = stringFlag(flags, "displayName") ?? connected.displayName;
  const accountId = connected.accountId ?? providerDefaultAccountEnv(provider);
  if (accountId) entry.account_id = accountId;
  entry.credentials = {
    ...(isRecord(entry.credentials) ? entry.credentials : {}),
    ...providerDefaultCredentials(provider),
  };
  providers[name] = entry;
  mergeDiscoveredSources(doc, name, connected.sources);
  writeConfigDoc(ref.path, doc);
  console.log(`connected ${provider} as ${name} in ${ref.path}`);
  if (written.changed) console.log(`updated ${envPath}`);
  return 0;
}

async function cmdSource(global: GlobalArgs, args: string[]): Promise<number> {
  if(args[0]==="select"){
    if(!args[1] || !args[2] || args[1].startsWith("-") || args[2].startsWith("-"))throw new Error("source select requires connection and external source identities");
    const flags=parseFlags(args.slice(3));for(const flag of Object.keys(flags))if(!["kind","name","metadataFile","id"].includes(flag))throw new Error(`Unsupported source select option: ${flag}`);
    const revision=await selectGraphSource(findConfigPath(global.config).path,args[1],args[2],{kind:stringFlag(flags,"kind"),name:stringFlag(flags,"name"),metadataFile:stringFlag(flags,"metadataFile"),id:stringFlag(flags,"id")});console.log(global.json?JSON.stringify({revision}):`Updated source selections (${revision})`);return 0;
  }
  if(args[0]==="remove"){if(args.length!==2)throw new Error("source remove requires one source identity");const revision=await editGraphFile(findConfigPath(global.config).path,[{kind:"source.remove",id:args[1]!}]);console.log(global.json?JSON.stringify({revision}):`Removed source (${revision})`);return 0;}
  const sub = args[0];
  if (sub !== "add") throw new Error("source supports: add");
  const source = args[1];
  if (!source) throw new Error("source add requires a source, e.g. logt source add cloudflare-worker-tail");
  const flags = parseFlags(args.slice(2));
  const ref = findConfigPath(global.config);
  const doc = readConfigDoc(ref.path);
  if (doc.kind === "logtura.deployment") throw new Error("Edit portable graph identities and selections in the manifest; this command edits the shorthand configuration format");
  const sources = ensureSection(doc, "sources");
  const name = stringFlag(flags, "name") ?? defaultSourceName(source, sources);
  sources[name] = {
    ...(isRecord(sources[name]) ? sources[name] : {}),
    source,
    ...(stringFlag(flags, "provider") ? { provider: stringFlag(flags, "provider") } : {}),
    ...defaultSourceSelection(source),
  };
  writeConfigDoc(ref.path, doc);
  console.log(`added source ${name} (${source})`);
  return 0;
}

function cmdSink(global: GlobalArgs, args: string[]): number {
  const sub = args[0];
  if (sub !== "add") throw new Error("sink supports: add");
  const kind = args[1];
  const name = args[2];
  if (!kind || !name) throw new Error("sink add requires kind and name, e.g. logt sink add slack errors-slack");
  const flags = parseFlags(args.slice(3));
  const ref = findConfigPath(global.config);
  const doc = readConfigDoc(ref.path);
  if (doc.kind === "logtura.deployment") throw new Error("Edit portable graph identities and selections in the manifest; this command edits the shorthand configuration format");
  const sinks = ensureSection(doc, "sinks");
  sinks[name] = {
    ...(isRecord(sinks[name]) ? sinks[name] : {}),
    sink: kind,
    ...defaultSinkConfig(kind, name),
  };
  const explicitSecrets = explicitSinkSecrets(kind, name, flags);
  if (Object.keys(explicitSecrets).length > 0) {
    const written = writeEnvValues(envPathForConfig(ref.path), explicitSecrets, {
      force: booleanFlag(flags, "force"),
    });
    if (written.skipped.length > 0) {
      throw new Error(`${written.skipped.join(", ")} already exists; pass --force to overwrite`);
    }
  }
  writeConfigDoc(ref.path, doc);
  console.log(`added sink ${name} (${kind})`);
  return 0;
}

function cmdMonitor(global: GlobalArgs, args: string[]): number {
  const sub = args[0];
  if (sub !== "add") throw new Error("monitor supports: add");
  const name = args[1];
  if (!name) throw new Error("monitor add requires a name");
  const sinkIds = args.slice(2);
  const ref = findConfigPath(global.config);
  const doc = readConfigDoc(ref.path);
  if (doc.kind === "logtura.deployment") throw new Error("Edit portable graph identities and selections in the manifest; this command edits the shorthand configuration format");
  const monitors = ensureListSection(doc, "monitors");
  monitors.push({
    name,
    filter: name === "errors" ? ["errors"] : [],
    sinks: sinkIds,
  });
  writeConfigDoc(ref.path, doc);
  console.log(`added monitor ${name}`);
  return 0;
}

function cmdEnv(global: GlobalArgs, args: string[]): number {
  const flags = parseFlags(args);
  const ref = findConfigPath(global.config);
  if (!ref.existed) throw new Error(`config not found; run logt init`);
  const parsed = loadConfigFile(ref.path);
  const bundle = generateBundle(parsed.input);
  if (flags.json || global.json) {
    console.log(JSON.stringify(bundle.envVars, null, 2));
    return 0;
  }
  if (flags.check) {
    const missing = missingEnvNames(parsed.missingEnv, bundle.envVars);
    if (missing.length === 0) {
      console.log("env ok");
      return 0;
    }
    console.error(`missing env: ${missing.join(", ")}`);
    return 2;
  }
  if (flags.write !== undefined) {
    const path = stringFlag(flags, "write") || envPathForConfig(ref.path);
    const changed = appendMissingEnvKeys(path, [
      ...parsed.requiredEnv,
      ...bundle.envVars.map((v) => v.name),
    ]);
    console.log(changed ? `updated ${path}` : `${path} already has required keys`);
    return 0;
  }
  process.stdout.write(renderEnvFile(bundle.envVars));
  return 0;
}

function cmdValidate(global: GlobalArgs, args: string[]): number {
  const flags = parseFlags(args);
  const ref = findConfigPath(global.config);
  if (!ref.existed) throw new Error(`config not found; run logt init`);
  const parsed = loadConfigFile(ref.path);
  const bundle = generateBundle(parsed.input);
  if (flags.vectorValidate) validateVector(bundle.vectorYaml);
  console.log(`ok: ${bundle.selectedCount} source(s), ${bundle.monitorSummary}`);
  const missing = missingEnvNames(parsed.missingEnv, bundle.envVars);
  if (missing.length > 0) {
    console.warn(`missing env: ${missing.join(", ")}`);
    return 2;
  }
  return 0;
}

function cmdBundle(global: GlobalArgs, args: string[]): number {
  const flags = parseFlags(args);
  const ref = findConfigPath(global.config);
  if (!ref.existed) throw new Error(`config not found; run logt init`);
  const parsed = loadConfigFile(ref.path);
  const bundle = generateBundle(parsed.input);
  const outDir = resolve(stringFlag(flags, "output") ?? "dist/logt");
  writeForwarderBundle(outDir, bundle);
  console.log(`wrote ${outDir}`);
  return missingEnvNames(parsed.missingEnv, bundle.envVars).length > 0 ? 2 : 0;
}

function cmdDeploy(global: GlobalArgs, args: string[]): number {
  const target = args[0];
  if (!target) throw new Error("deploy requires a target, e.g. logt deploy fly");
  const flags = parseFlags(args.slice(1));
  if (flags.writeEnv) {
    const code = cmdEnv(global, ["--write"]);
    if (code !== 0) return code;
  }
  if (target !== "fly") {
    throw new Error(`unsupported deploy target: ${target}`);
  }
  const ref = findConfigPath(global.config);
  if (!ref.existed) throw new Error(`config not found; run logt init`);
  const parsed = loadConfigFile(ref.path);
  const bundle = generateBundle(parsed.input);
  const missing = missingEnvNames(parsed.missingEnv, bundle.envVars);
  if (missing.length > 0) {
    throw new Error(`missing env: ${missing.join(", ")}; run logt env --write`);
  }
  const appName = stringFlag(flags, "app") ?? defaultFlyAppName(ref.path);
  const region = stringFlag(flags, "region") ?? "iad";
  const org = stringFlag(flags, "org");
  const outDir = resolve(stringFlag(flags, "output") ?? "dist/logt-fly");
  writeForwarderBundle(outDir, bundle);
  writeFileSync(resolve(outDir, "fly.toml"), renderFlyToml(appName, region));
  deployWithFlyctl({
    appName,
    org,
    workdir: outDir,
    envVars: bundle.envVars,
  });
  console.log(`deployed ${appName} to Fly`);
  return 0;
}

function cmdStats(args: string[]): number {
  const flags = parseFlags(args);
  const file = stringFlag(flags, "metrics") ?? args[0];
  if (!file) throw new Error("stats requires --metrics <file>");
  console.log(printStats(file));
  return 0;
}

function writeForwarderBundle(outDir: string, bundle: ReturnType<typeof generateBundle>): void {
  mkdirSync(outDir, { recursive: true });
  for (const f of installBundleFiles(bundle, "logt-forwarder")) {
    const rel = f.name.replace(/^logt-forwarder\//, "");
    const dest = resolve(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
    if (f.mode !== undefined) chmodSync(dest, f.mode);
  }
}

function deployWithFlyctl(input: {
  appName: string;
  org?: string;
  workdir: string;
  envVars: BundleEnvVar[];
}): void {
  requireFlyctl();
  const status = spawnSync("flyctl", ["status", "--app", input.appName], {
    cwd: input.workdir,
    stdio: "ignore",
  });
  if (status.status !== 0) {
    const createArgs = ["apps", "create", input.appName];
    if (input.org) createArgs.push("--org", input.org);
    runFlyctl(createArgs, input.workdir);
  }

  const secrets = input.envVars
    .filter((v) => v.value !== null)
    .map((v) => `${v.name}=${v.value}`)
    .join("\n");
  if (secrets) {
    runFlyctl(["secrets", "import", "--app", input.appName], input.workdir, secrets + "\n");
  }
  runFlyctl(["deploy", "--app", input.appName, "--config", "fly.toml", "--remote-only"], input.workdir);
  runFlyctl(["status", "--app", input.appName], input.workdir);
}

function requireFlyctl(): void {
  const r = spawnSync("flyctl", ["version"], { stdio: "ignore" });
  if (r.status !== 0) {
    throw new Error("flyctl is required. Install it from https://fly.io/docs/flyctl/install/");
  }
}

function runFlyctl(args: string[], cwd: string, input?: string): void {
  const r = spawnSync("flyctl", args, {
    cwd,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    throw new Error(`flyctl ${args.join(" ")} failed`);
  }
}

function renderFlyToml(appName: string, region: string): string {
  return [
    "# Generated by logt",
    `app = "${appName}"`,
    `primary_region = "${region}"`,
    "",
    "[build]",
    '  dockerfile = "Dockerfile"',
    "",
    "[[vm]]",
    '  cpu_kind = "shared"',
    "  cpus = 1",
    "  memory_mb = 512",
    "",
    "[[services]]",
    "  internal_port = 9598",
    '  protocol = "tcp"',
    "  auto_stop_machines = false",
    "  auto_start_machines = true",
    "  min_machines_running = 1",
    "",
  ].join("\n");
}

function defaultFlyAppName(configPath: string): string {
  const dir = basename(dirname(resolve(configPath)));
  const cleaned = safeId(dir.toLowerCase()).replace(/_/g, "-").slice(0, 24);
  return `logt-${cleaned || "forwarder"}`;
}

function parseGlobalArgs(argv: string[]): { global: GlobalArgs; rest: string[] } {
  const global: GlobalArgs = { json: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-c" || a === "--config") global.config = needValue(argv, ++i, a);
    else if (a === "--json") global.json = true;
    else rest.push(a);
  }
  return { global, rest };
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-W" || a === "--write-env") flags.writeEnv = true;
    else if (a === "--write") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) flags.write = argv[++i]!;
      else flags.write = "";
    } else if (a === "--check") flags.check = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--vector-validate") flags.vectorValidate = true;
    else if (a === "-q" || a === "--quiet") flags.quiet = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--token") flags.token = needValue(argv, ++i, a);
    else if (a.startsWith("--token=")) flags.token = a.slice("--token=".length);
    else if (a === "--webhook") flags.webhook = needValue(argv, ++i, a);
    else if (a.startsWith("--webhook=")) flags.webhook = a.slice("--webhook=".length);
    else if (a === "-o" || a === "--output") flags.output = needValue(argv, ++i, a);
    else if (a === "--kind") flags.kind = needValue(argv, ++i, a);
    else if (a === "--id") flags.id = needValue(argv, ++i, a);
    else if (a === "--metadata-file") flags.metadataFile = needValue(argv, ++i, a);
    else if (a === "--service") flags.service = needValue(argv, ++i, a);
    else if (a === "--no-browser") flags.noBrowser = true;
    else if (a === "--local") flags.local = true;
    else if (a === "--metrics") flags.metrics = needValue(argv, ++i, a);
    else if (a === "--name") flags.name = needValue(argv, ++i, a);
    else if (a === "--provider") flags.provider = needValue(argv, ++i, a);
    else if (a === "--account-id") flags.accountId = needValue(argv, ++i, a);
    else if (a === "--display-name") flags.displayName = needValue(argv, ++i, a);
    else if (a === "--app") flags.app = needValue(argv, ++i, a);
    else if (a === "--region") flags.region = needValue(argv, ++i, a);
    else if (a === "--org") flags.org = needValue(argv, ++i, a);
    else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function stringFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(
  flags: Record<string, string | boolean>,
  name: string,
): boolean {
  return flags[name] === true;
}

function needValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function rejectExtra(args: string[]): void {
  if (args.length > 0) throw new Error(`unexpected argument: ${args[0]}`);
}

function defaultSourceName(source: string, existing: Record<string, unknown>): string {
  const base = safeId(source.replace(/-logs?$|-tail$/g, ""));
  if (!(base in existing)) return base;
  let i = 2;
  while (`${base}-${i}` in existing) i++;
  return `${base}-${i}`;
}

function defaultSourceSelection(source: string): Record<string, unknown> {
  if (source === "cloudflare-worker-tail") return { scripts: [] };
  if (source === "cloudflare-ai-gateway") return { gateways: [] };
  if (source === "fly-log-tail") return { apps: [] };
  if (source === "railway-logs") return { services: [] };
  if (source === "vercel-logs") return { projects: [] };
  if (source === "supabase-edge-logs") return { functions: [], gateway: true };
  return { sources: [] };
}

function defaultSinkConfig(kind: string, name: string): Record<string, unknown> {
  const envName = safeEnv(`${kind}_${name}`);
  if (kind === "slack") return { webhook_url: `env:${envName}_WEBHOOK_URL` };
  if (kind === "webhook") return { url: `env:${envName}_URL` };
  if (kind === "datadog_metrics") {
    return { api_key: `env:${envName}_API_KEY`, site: "datadoghq.com" };
  }
  return {};
}

function explicitSinkSecrets(
  kind: string,
  name: string,
  flags: Record<string, string | boolean>,
): Record<string, string> {
  const webhook = stringFlag(flags, "webhook");
  if (kind === "slack" && webhook) {
    return { [`SLACK_${safeEnv(name)}_WEBHOOK_URL`]: webhook };
  }
  if (kind === "webhook" && webhook) {
    return { [`WEBHOOK_${safeEnv(name)}_URL`]: webhook };
  }
  return {};
}

function providerDefaultAccountEnv(provider: string): string | null {
  if (provider === "cloudflare") return "env:CLOUDFLARE_ACCOUNT_ID";
  if (provider === "supabase") return "env:SUPABASE_PROJECT_REF";
  return null;
}

function providerDefaultCredentials(provider: string): Record<string, unknown> {
  if (provider === "cloudflare") return { api_token: "env:CLOUDFLARE_API_TOKEN" };
  if (provider === "fly") return { api_token: "env:FLY_API_TOKEN" };
  if (provider === "railway") return { api_token: "env:RAILWAY_API_TOKEN" };
  if (provider === "supabase") return { pat: "env:SUPABASE_PAT" };
  if (provider === "vercel") return { api_token: "env:VERCEL_API_TOKEN" };
  return {};
}

function missingEnvNames(parserMissing: string[], envVars: BundleEnvVar[]): string[] {
  const missing = new Set(parserMissing);
  for (const v of envVars) {
    if (!v.value) missing.add(v.name);
  }
  return [...missing].sort();
}

function envPathForConfig(configPath: string): string {
  return resolve(dirname(resolve(configPath)), ".env");
}

function mergeDiscoveredSources(
  doc: Record<string, unknown>,
  providerName: string,
  discovered: Array<{ id: string; source: string; items: Array<{ externalId: string }> }>,
): void {
  const sources = ensureSection(doc, "sources");
  for (const group of discovered) {
    const key = defaultSourceName(group.source, sources);
    const existing = (sources[key] && isRecord(sources[key]) ? sources[key] : {}) as Record<string, unknown>;
    sources[key] = {
      ...existing,
      source: group.source,
      provider: providerName,
      ...sourceInventoryField(group.source, group.items.map((i) => i.externalId)),
    };
  }
}

function sourceInventoryField(source: string, ids: string[]): Record<string, unknown> {
  if (source === "cloudflare-worker-tail") return { scripts: ids };
  if (source === "cloudflare-ai-gateway") return { gateways: ids };
  if (source === "fly-log-tail") return { apps: ids };
  if (source === "railway-logs") return { services: ids };
  if (source === "vercel-logs") return { projects: ids };
  if (source === "supabase-edge-logs") return { functions: ids, gateway: true };
  return { sources: ids };
}

function connectMetadataForProvider(
  provider: string,
  doc: Record<string, unknown>,
  forceAllKnownScopes: boolean,
): Record<string, unknown> | undefined {
  const sourceIds = forceAllKnownScopes
    ? Object.entries(allSourceConnectMetadata())
        .filter(([, meta]) => meta.provider === provider)
        .map(([source]) => source)
    : sourceIdsForProvider(doc, provider);
  const sourceMetadata = sourceIds
    .map((source) => sourceConnectMetadata(source)?.metadata)
    .filter((m): m is Record<string, unknown> => isRecord(m));
  return mergeProviderMetadata(sourceMetadata);
}

function mergeProviderMetadata(items: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  if (items.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (Array.isArray(value)) {
        const prior = Array.isArray(out[key]) ? out[key] : [];
        out[key] = [...prior, ...value];
      } else if (isRecord(value) && isRecord(out[key])) {
        out[key] = { ...(out[key] as Record<string, unknown>), ...value };
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function sourceIdsForProvider(doc: Record<string, unknown>, provider: string): string[] {
  const rawSources = doc.sources;
  if (!isRecord(rawSources)) return [];
  const out: string[] = [];
  for (const raw of Object.values(rawSources)) {
    if (!isRecord(raw)) continue;
    const source = typeof raw.source === "string" ? raw.source : null;
    if (!source) continue;
    const meta = sourceConnectMetadata(source);
    if (meta?.provider === provider) out.push(source);
  }
  return out;
}

function validateVector(vectorYaml: string): void {
  writeFileSync("vector.yaml.tmp", vectorYaml);
  const res = spawnSync("vector", ["validate", "vector.yaml.tmp"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(res.stderr || res.stdout || "vector validate failed");
  }
}

function safeEnv(value: string): string {
  return safeId(value).replace(/-/g, "_").toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function help(): string {
  return `logt <command> [options]

Commands:
  init                              Create logt.yaml
  pull <deployment-id> [-o file]     Pull a website deployment and private .env
  login [--service URL]             Approve CLI access in your browser
  whoami [--service URL]            Show the signed-in service account
  logout [--local]                  Revoke CLI access and remove credentials
  config export [-o file]            Export a shorthand config as a portable graph
  config edit <operations.json>     Apply graph changes, including private payloads
  config diff <baseline.yaml>       Compare graph identities and changed fields
  diff <deployment-id>              Compare local graph with the website
  source select <connection> <site> Add a site to a portable graph
  source remove <source-id>         Remove a site from a portable graph
  config normalize [-o file]        Add stable IDs and inline custom fragments
  config hash                       Print the portable configuration revision
  config recover                    Recover an interrupted YAML/.env/link write
  config status                     Show local linked deployment changes
  connect <provider>                Add a provider connection (cloudflare, fly, railway, ...)
  source add <source>               Add a source driver (cloudflare-worker-tail, ...)
  sink add <kind> <name>            Add a sink
  monitor add <name> [sinks...]     Add a monitor
  env [--write [file]|--check]      Print, write, or check required env vars
  validate                          Parse config and render a bundle
  bundle [-o dir]                   Write Dockerfile, vector.yaml, manifest, .env
  deploy fly [-W|--write-env]       Deploy locally through flyctl
  stats --metrics <file>            Print a table from Vector internal_metrics JSON/NDJSON

Global options:
  -c, --config <file>               Config file. Defaults to logt.yaml, then logtura.yaml.
  --json                            JSON output where supported

Connect options:
  -q, --quiet                       Never prompt or open a browser
  --token <value>                   Use a pasted/provider token
  --force                           Overwrite existing .env token values
  --all                             Use metadata from all known source drivers for the provider

Fly deploy options:
  --app <name>                      Fly app name (default: logt-<directory>)
  --region <code>                   Primary region (default: iad)
  --org <slug>                      Fly org for first app creation
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
