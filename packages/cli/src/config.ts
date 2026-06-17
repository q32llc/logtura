import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  FilterStep,
  GenerateInput,
  GeneratorConnection,
  GeneratorMonitor,
  GeneratorSink,
  Source,
} from "@logtura/core";
import { listDestinations, listProviders } from "./registry";

type UnknownRecord = Record<string, unknown>;

export const CONFIG_FILENAMES = [
  "logt.yaml",
  "logt.yml",
  "logtura.yaml",
  "logtura.yml",
] as const;

export interface ConfigFileRef {
  path: string;
  existed: boolean;
}

export interface ParsedConfig {
  input: GenerateInput;
  missingEnv: string[];
  requiredEnv: string[];
  path: string;
}

export function findConfigPath(explicit?: string): ConfigFileRef {
  if (explicit) return { path: explicit, existed: existsSync(explicit) };
  const fromEnv = process.env.LOGT_CONFIG;
  if (fromEnv) return { path: fromEnv, existed: existsSync(fromEnv) };
  for (const name of CONFIG_FILENAMES) {
    if (existsSync(name)) return { path: name, existed: true };
  }
  return { path: "logt.yaml", existed: false };
}

export function loadConfigFile(path: string): ParsedConfig {
  return parseConfig(readFileSync(path, "utf8"), path);
}

export function readConfigDoc(path: string): UnknownRecord {
  if (!existsSync(path)) return {};
  const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) throw new Error(`${path}: expected a YAML object`);
  return parsed;
}

export function writeConfigDoc(path: string, doc: UnknownRecord): void {
  writeFileSync(path, stringifyYaml(doc, { lineWidth: 96 }));
}

export function parseConfig(text: string, filename = "logt.yaml"): ParsedConfig {
  const doc = parseYaml(text) as unknown;
  if (!isRecord(doc)) throw new Error(`${filename}: expected a YAML object`);
  const missingEnv = new Set<string>();
  const requiredEnv = new Set<string>();
  const baseDir = dirname(resolve(filename));
  const envValues = readDotEnv(resolve(baseDir, ".env"));
  const env = (value: unknown): unknown =>
    resolveEnv(value, missingEnv, requiredEnv, envValues);

  const providerRefs = parseProviderRefs(asRecord(doc.providers ?? {}, "providers"), env);
  const connections = parseSources(
    asRecord(doc.sources ?? {}, "sources"),
    providerRefs,
    env,
    baseDir,
  );
  const destinations = parseSinks(asRecord(doc.sinks ?? {}, "sinks"), env, requiredEnv, baseDir);
  const monitors = parseMonitors(asArray(doc.monitors ?? [], "monitors"), destinations);
  const metrics = parseMetrics(doc.metrics, destinations);

  return {
    input: {
      providers: listProviders(),
      destinations: listDestinations(),
      connections,
      monitors,
      heartbeat: { kind: "none", deploymentId: "local", appUrl: "http://localhost" },
      metrics,
    },
    missingEnv: [...missingEnv].sort(),
    requiredEnv: [...requiredEnv].sort(),
    path: filename,
  };
}

interface ProviderRef {
  id: string;
  provider: string;
  displayName: string;
  externalAccountId: string | null;
  credentials: Record<string, unknown>;
}

function parseProviderRefs(
  providers: UnknownRecord,
  env: (value: unknown) => unknown,
): Map<string, ProviderRef> {
  const out = new Map<string, ProviderRef>();
  for (const [id, raw] of Object.entries(providers)) {
    const p = asRecord(raw, `providers.${id}`);
    const provider = stringField(p, "provider", id);
    if (!provider) throw new Error(`providers.${id}.provider is required`);
    const accountId = stringValue(
      env(p.account_id ?? p.accountId ?? p.external_account_id ?? p.externalAccountId),
    );
    out.set(id, {
      id,
      provider,
      displayName: stringField(p, "display_name", stringField(p, "displayName", id)) ?? id,
      externalAccountId: accountId,
      credentials: providerCredentials(provider, p, env),
    });
  }
  return out;
}

function providerCredentials(
  provider: string,
  p: UnknownRecord,
  env: (value: unknown) => unknown,
): Record<string, unknown> {
  const raw = isRecord(p.credentials) ? p.credentials : {};
  const from = (key: string, fallback?: unknown) => env(raw[key] ?? p[key] ?? fallback);
  if (provider === "cloudflare") return { apiToken: stringValue(from("api_token")) ?? "" };
  if (provider === "fly") return { apiToken: stringValue(from("api_token")) ?? "" };
  if (provider === "railway") {
    return {
      apiToken: stringValue(from("api_token")) ?? "",
      projectId: stringValue(from("project_id")),
      environmentId: stringValue(from("environment_id")),
    };
  }
  if (provider === "supabase") return { pat: stringValue(from("pat")) ?? "" };
  if (provider === "vercel") return { apiToken: stringValue(from("api_token")) ?? "" };
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, env(v)]));
}

function parseSources(
  sources: UnknownRecord,
  providers: Map<string, ProviderRef>,
  env: (value: unknown) => unknown,
  baseDir: string,
): GeneratorConnection[] {
  const out: GeneratorConnection[] = [];
  for (const [id, raw] of Object.entries(sources)) {
    const s = asRecord(raw, `sources.${id}`);
    const sourceDriver = stringField(s, "source", stringField(s, "driver", sourceAlias(id)));
    if (!sourceDriver) throw new Error(`sources.${id}.source is required`);
    if (sourceDriver === "custom-vector") {
      out.push(customVectorConnection(id, s, baseDir));
      continue;
    }
    const providerKind = providerKindForSource(sourceDriver);
    const providerId = stringField(s, "provider");
    const provider = resolveProviderRef(providers, providerKind, providerId, `sources.${id}`);
    const externalAccountId =
      stringValue(
        env(
          s.account_id ??
            s.accountId ??
            s.external_account_id ??
            s.externalAccountId ??
            (sourceDriver === "vercel-logs" ? s.team_id ?? s.teamId : undefined) ??
            (sourceDriver === "railway-logs" ? s.environment_id ?? s.environmentId : undefined),
        ),
      ) ?? provider.externalAccountId;
    out.push({
      connection: {
        id: `con_${safeId(id)}`,
        provider: sourceDriver,
        displayName: stringField(s, "display_name", stringField(s, "displayName", id)) ?? id,
        externalAccountId,
      },
      selectedSources: sourceRows(id, sourceDriver, s, baseDir, externalAccountId),
      selectAll: boolField(s, "all", false),
      credentials: credentialsForSource(sourceDriver, provider, s, env),
    });
  }
  return out;
}

function resolveProviderRef(
  providers: Map<string, ProviderRef>,
  providerKind: string,
  providerId: string | null,
  path: string,
): ProviderRef {
  if (providerId) {
    const p = providers.get(providerId);
    if (!p) throw new Error(`${path}.provider references unknown provider ${providerId}`);
    if (p.provider !== providerKind) {
      throw new Error(`${path}.provider must reference a ${providerKind} provider`);
    }
    return p;
  }
  const matches = [...providers.values()].filter((p) => p.provider === providerKind);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(`${path}.provider is required; run logt connect ${providerKind}`);
  }
  throw new Error(`${path}.provider is required because multiple ${providerKind} providers exist`);
}

function credentialsForSource(
  sourceDriver: string,
  provider: ProviderRef,
  s: UnknownRecord,
  env: (value: unknown) => unknown,
): Record<string, unknown> {
  const creds = { ...provider.credentials };
  if (sourceDriver === "railway-logs") {
    return {
      ...creds,
      projectId:
        stringValue(env(s.project_id ?? s.projectId)) ??
        stringValue(creds.projectId),
      environmentId:
        stringValue(env(s.environment_id ?? s.environmentId)) ??
        stringValue(creds.environmentId),
    };
  }
  return creds;
}

function providerKindForSource(sourceDriver: string): string {
  if (sourceDriver.startsWith("cloudflare-")) return "cloudflare";
  if (sourceDriver === "fly-log-tail") return "fly";
  if (sourceDriver === "railway-logs") return "railway";
  if (sourceDriver === "supabase-edge-logs") return "supabase";
  if (sourceDriver === "vercel-logs") return "vercel";
  throw new Error(`unknown source driver: ${sourceDriver}`);
}

function sourceAlias(id: string): string | null {
  if (id === "workers" || id === "cloudflare_workers") return "cloudflare-worker-tail";
  if (id === "edge" || id === "supabase_edge") return "supabase-edge-logs";
  if (id === "fly" || id === "fly_apps") return "fly-log-tail";
  if (id === "railway" || id === "railway_logs") return "railway-logs";
  if (id === "ai_gateway" || id === "cloudflare_ai_gateway") return "cloudflare-ai-gateway";
  if (id === "vercel" || id === "vercel_logs") return "vercel-logs";
  return null;
}

function customVectorConnection(id: string, s: UnknownRecord, baseDir: string): GeneratorConnection {
  const vector = customVectorSourceConfig(s, baseDir, `sources.${id}.vector`);
  return {
    connection: {
      id: `con_${safeId(id)}`,
      provider: "custom-vector",
      displayName: stringField(s, "display_name", id) ?? id,
      externalAccountId: null,
    },
    selectedSources: [
      {
        id: `src_${safeId(id)}_custom_vector`,
        externalId: vector.feed,
        displayName: stringField(s, "display_name", id) ?? id,
        sourceKind: "custom_vector",
        metadata: { customVector: vector },
      },
    ],
    credentials: {},
  };
}

function sourceRows(
  id: string,
  driver: string,
  s: UnknownRecord,
  baseDir: string,
  externalAccountId: string | null,
): Source[] {
  if (driver === "custom-vector") {
    const vector = customVectorSourceConfig(s, baseDir, `sources.${id}.vector`);
    return [
      {
        id: `src_${safeId(id)}_custom_vector`,
        externalId: vector.feed,
        displayName: stringField(s, "display_name", id) ?? id,
        sourceKind: "custom_vector",
        metadata: { customVector: vector },
      },
    ];
  }
  if (driver === "cloudflare-worker-tail") {
    return stringList(s.scripts ?? s.workers ?? s.include ?? s.sources, `sources.${id}.scripts`)
      .map((name) => source(id, name, "cf_worker"));
  }
  if (driver === "cloudflare-ai-gateway") {
    return stringList(s.gateways ?? s.include ?? s.sources, `sources.${id}.gateways`)
      .map((name) => source(id, name, "cf_ai_gateway"));
  }
  if (driver === "fly-log-tail") {
    return stringList(s.apps ?? s.include ?? s.sources, `sources.${id}.apps`)
      .map((name) => source(id, name, "fly_app"));
  }
  if (driver === "vercel-logs") {
    return stringList(s.projects ?? s.include ?? s.sources, `sources.${id}.projects`)
      .map((projectId) => source(id, projectId, "vercel_project"));
  }
  if (driver === "railway-logs") {
    return railwayServiceRows(
      id,
      s.services ?? s.include ?? s.sources,
      `sources.${id}.services`,
      externalAccountId,
    );
  }
  if (driver === "supabase-edge-logs") {
    const rows: Source[] = [];
    for (const item of asArray(s.functions ?? s.include ?? [], `sources.${id}.functions`)) {
      if (typeof item === "string") {
        rows.push(source(id, item, "supabase_edge_fn"));
      } else {
        const rec = asRecord(item, `sources.${id}.functions[]`);
        const slug = stringField(rec, "slug", stringField(rec, "name"));
        if (!slug) throw new Error(`sources.${id}.functions[].slug is required`);
        rows.push(
          source(id, slug, "supabase_edge_fn", {
            function_id: stringField(rec, "function_id", "") ?? "",
          }),
        );
      }
    }
    if (s.gateway === true) {
      rows.push({
        id: `src_${safeId(id)}_gateway`,
        externalId: "_gateway_",
        displayName: "Project HTTP gateway",
        sourceKind: "supabase_gateway",
        metadata: null,
      });
    }
    return rows;
  }
  return stringList(s.sources, `sources.${id}.sources`).map((name) =>
    source(id, name, driver),
  );
}

function source(
  owner: string,
  externalId: string,
  sourceKind: string,
  metadata: Record<string, unknown> | null = null,
): Source {
  return {
    id: `src_${safeId(owner)}_${safeId(externalId)}`,
    externalId,
    displayName: externalId,
    sourceKind,
    metadata,
  };
}

function railwayServiceRows(
  owner: string,
  raw: unknown,
  path: string,
  environmentId: string | null,
): Source[] {
  const rows: Source[] = [];
  for (const item of asArray(raw ?? [], path)) {
    if (typeof item === "string") {
      rows.push(
        source(owner, item, "railway_service", {
          environment_id: environmentId,
        }),
      );
      continue;
    }
    const rec = asRecord(item, `${path}[]`);
    const id = stringField(rec, "id", stringField(rec, "service_id"));
    if (!id) throw new Error(`${path}[].id is required`);
    rows.push({
      id: `src_${safeId(owner)}_${safeId(id)}`,
      externalId: id,
      displayName: stringField(rec, "name", id) ?? id,
      sourceKind: "railway_service",
      metadata: {
        environment_id:
          stringField(rec, "environment_id", stringField(rec, "environmentId")) ??
          environmentId,
      },
    });
  }
  return rows;
}

function parseSinks(
  sinks: UnknownRecord,
  env: (value: unknown) => unknown,
  requiredEnv: Set<string>,
  baseDir: string,
): Map<string, { destination: { id: string; kind: string; displayName: string }; config: unknown }> {
  const out = new Map<
    string,
    { destination: { id: string; kind: string; displayName: string }; config: unknown }
  >();
  for (const [id, raw] of Object.entries(sinks)) {
    const s = asRecord(raw, `sinks.${id}`);
    const kind = stringField(s, "sink", stringField(s, "type", stringField(s, "kind")));
    if (!kind) throw new Error(`sinks.${id}.sink is required`);
    out.set(id, {
      destination: {
        id: `dst_${safeId(id)}`,
        kind,
        displayName: stringField(s, "display_name", stringField(s, "displayName", id)) ?? id,
      },
      config: sinkConfig(kind, id, s, env, requiredEnv, baseDir, `sinks.${id}`),
    });
  }
  return out;
}

function sinkConfig(
  kind: string,
  id: string,
  s: UnknownRecord,
  env: (value: unknown) => unknown,
  requiredEnv: Set<string>,
  baseDir: string,
  path: string,
): unknown {
  const config = isRecord(s.config) ? s.config : s;
  if (kind === "slack") {
    return {
      webhookUrl:
        stringValue(env(config.webhook_url ?? config.webhookUrl)) ??
        envPlaceholder(`SLACK_${safeEnv(id)}_WEBHOOK_URL`, requiredEnv),
      teamName: stringField(config, "team_name", stringField(config, "teamName")),
      channel: stringField(config, "channel"),
      maxMessageChars: numberOrNullField(
        config,
        "max_message_chars",
        numberOrNullField(config, "maxMessageChars"),
      ),
    };
  }
  if (kind === "webhook") {
    return {
      url:
        stringValue(env(config.url ?? config.webhook_url ?? config.webhookUrl)) ??
        envPlaceholder(`WEBHOOK_${safeEnv(id)}_URL`, requiredEnv),
    };
  }
  if (kind === "datadog_metrics") {
    return {
      apiKey:
        stringValue(env(config.api_key ?? config.apiKey)) ??
        envPlaceholder(`DATADOG_${safeEnv(id)}_API_KEY`, requiredEnv),
      site: stringField(config, "site", "datadoghq.com") ?? "datadoghq.com",
    };
  }
  if (kind === "custom-vector") {
    return customVectorDestinationConfig(config, baseDir, `${path}.vector`);
  }
  return deepResolveEnv(config, env);
}

function envPlaceholder(name: string, requiredEnv: Set<string>): string {
  requiredEnv.add(name);
  return "";
}

function parseMonitors(
  monitors: unknown[],
  sinks: Map<string, { destination: { id: string; kind: string; displayName: string }; config: unknown }>,
): GeneratorMonitor[] {
  return monitors.map((raw, i) => {
    const m = asRecord(raw, `monitors[${i}]`);
    const name = stringField(m, "name", `monitor_${i + 1}`) ?? `monitor_${i + 1}`;
    const sinkIds = stringList(m.sinks, `monitors[${i}].sinks`);
    const monitorSinks: GeneratorSink[] = sinkIds.map((sinkId) => {
      const dest = sinks.get(sinkId);
      if (!dest) throw new Error(`monitors[${i}] references unknown sink ${sinkId}`);
      return {
        sink: { id: `snk_${safeId(name)}_${safeId(sinkId)}`, filterSteps: [] },
        destination: dest.destination,
        destinationConfig: dest.config,
      };
    });
    return {
      monitor: {
        id: `mon_${safeId(name)}`,
        connectionId: null,
        displayName: name,
        filterSteps: parseFilterSteps(m.filter ?? (name === "errors" ? ["errors"] : [])),
        enabled: m.enabled !== false,
      },
      sinks: monitorSinks,
    };
  });
}

function parseFilterSteps(raw: unknown): FilterStep[] {
  return asArray(raw, "filter").map((step, i) => {
    if (typeof step === "string") {
      if (step === "errors") return { kind: "errors" };
      throw new Error(`filter[${i}]: unknown shorthand ${step}`);
    }
    const rec = asRecord(step, `filter[${i}]`);
    if ("rollup" in rec) {
      const r = asRecord(rec.rollup, `filter[${i}].rollup`);
      return {
        kind: "rollup",
        window_secs: numberField(r, "window_secs", 30),
        group_by: stringList(r.group_by ?? [], `filter[${i}].rollup.group_by`),
        max_samples: numberField(r, "max_samples", 5),
      };
    }
    const kind = stringField(rec, "kind");
    if (kind === "errors") return { kind: "errors" };
    throw new Error(`filter[${i}]: unsupported filter step`);
  });
}

function parseMetrics(
  raw: unknown,
  sinks: Map<string, { destination: { id: string; kind: string; displayName: string }; config: unknown }>,
): GenerateInput["metrics"] {
  if (raw === undefined || raw === null || raw === "none" || raw === false) {
    return { kind: "none" };
  }
  if (raw === "logtura") {
    return { kind: "logtura", deploymentId: "local", appUrl: "http://localhost" };
  }
  const rec = asRecord(raw, "metrics");
  const sinkId = stringField(rec, "sink");
  if (sinkId) {
    const sink = sinks.get(sinkId);
    if (!sink) throw new Error(`metrics.sink references unknown sink ${sinkId}`);
    return {
      kind: "destination",
      destination: sink.destination,
      destinationConfig: sink.config,
    };
  }
  return { kind: "none" };
}

function customVectorSourceConfig(
  owner: UnknownRecord,
  baseDir: string,
  path: string,
): { fragment: UnknownRecord; feed: string } {
  const vector = asRecord(owner.vector, path);
  const include = stringField(vector, "include");
  if (!include) throw new Error(`${path}.include is required`);
  const feed = stringField(vector, "feed");
  if (!feed) throw new Error(`${path}.feed is required`);
  return {
    fragment: readVectorFragment(include, baseDir, `${path}.include`),
    feed,
  };
}

function customVectorDestinationConfig(
  owner: UnknownRecord,
  baseDir: string,
  path: string,
): { fragment: UnknownRecord; input: string | null } {
  const vector = asRecord(owner.vector, path);
  const include = stringField(vector, "include");
  if (!include) throw new Error(`${path}.include is required`);
  return {
    fragment: readVectorFragment(include, baseDir, `${path}.include`),
    input: stringField(vector, "input"),
  };
}

function readVectorFragment(
  include: string,
  baseDir: string,
  path: string,
): UnknownRecord {
  const includePath = resolve(baseDir, include);
  const parsed = parseYaml(readFileSync(includePath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path}: included file must be a YAML object`);
  return parsed;
}

function resolveEnv(
  value: unknown,
  missing: Set<string>,
  required: Set<string>,
  envValues: Map<string, string>,
): unknown {
  if (typeof value !== "string") return value;
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  required.add(name);
  const envValue = process.env[name] ?? envValues.get(name);
  if (envValue === undefined || envValue === "") missing.add(name);
  return envValue ?? "";
}

function readDotEnv(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    out.set(m[1]!, unquoteEnv(m[2] ?? ""));
  }
  return out;
}

function unquoteEnv(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function deepResolveEnv(value: unknown, env: (value: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => deepResolveEnv(v, env));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !["sink", "type", "kind", "display_name", "displayName"].includes(k))
        .map(([k, v]) => [camel(k), deepResolveEnv(v, env)]),
    );
  }
  return env(value);
}

export function ensureSection(doc: UnknownRecord, name: string): UnknownRecord {
  if (doc[name] === undefined) doc[name] = {};
  return asRecord(doc[name], name);
}

export function ensureListSection(doc: UnknownRecord, name: string): unknown[] {
  if (doc[name] === undefined) doc[name] = [];
  return asArray(doc[name], name);
}

export function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

export function defaultProviderName(provider: string, existing: UnknownRecord): string {
  const base = safeId(provider);
  if (!(base in existing)) return base;
  let i = 2;
  while (`${base}-${i}` in existing) i++;
  return `${base}-${i}`;
}

function stringList(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  return asArray(value, path).map((v) => {
    if (typeof v !== "string") throw new Error(`${path}: expected string item`);
    return v;
  });
}

function asArray(value: unknown, path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
  return value;
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${path}: expected object`);
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  rec: UnknownRecord,
  field: string,
  fallback?: string | null,
): string | null {
  const value = rec[field];
  return typeof value === "string" ? value : (fallback ?? null);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberField(
  rec: UnknownRecord,
  field: string,
  fallback: number,
): number {
  const value = rec[field];
  return typeof value === "number" ? value : fallback;
}

function numberOrNullField(
  rec: UnknownRecord,
  field: string,
  fallback?: number | null,
): number | null | undefined {
  const value = rec[field];
  if (value === null) return null;
  return typeof value === "number" ? value : fallback;
}

function boolField(
  rec: UnknownRecord,
  field: string,
  fallback: boolean,
): boolean {
  const value = rec[field];
  return typeof value === "boolean" ? value : fallback;
}

function safeEnv(value: string): string {
  return safeId(value).replace(/-/g, "_").toUpperCase();
}

function camel(value: string): string {
  return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
