/** Runtime-neutral configuration parsing. No filesystem, process environment,
 * provider requests or global registry. The caller explicitly supplies adapters. */
import type { FilterStep, GenerateInput, GeneratorConnection, GeneratorMonitor, GeneratorSink, Source } from "./types";

type UnknownRecord = Record<string, unknown>;
export type ConfigIncludeReader = (include: string) => unknown;
export interface ConfigParseOptions {
  providers?: GenerateInput["providers"];
  destinations?: GenerateInput["destinations"];
  env?: Readonly<Record<string, string | undefined>>;
  readInclude?: ConfigIncludeReader;
  filename?: string;
}
export interface ParsedConfig {
  input: GenerateInput;
  missingEnv: string[];
  requiredEnv: string[];
  path: string;
}

export function parseConfigDocument(document: unknown, options: ConfigParseOptions = {}): ParsedConfig {
  const filename = options.filename ?? "logt.yaml";
  const doc = asRecord(document, filename);
  if (doc.schema_version !== undefined && doc.schema_version !== 1) throw new Error(`${filename}: unsupported schema_version ${String(doc.schema_version)}`);
  const missingEnv = new Set<string>();
  const requiredEnv = new Set<string>();
  const env = (value: unknown) => resolveEnv(value, missingEnv, requiredEnv, options.env ?? {});
  const readInclude: ConfigIncludeReader = options.readInclude ?? ((include) => { throw new Error(`No include reader supplied for ${include}`); });
  const providerRefs = parseProviderRefs(asRecord(doc.providers ?? {}, "providers"), env);
  const connections = parseSources(asRecord(doc.sources ?? {}, "sources"), providerRefs, env, readInclude);
  const destinations = parseSinks(asRecord(doc.sinks ?? {}, "sinks"), env, requiredEnv, readInclude);
  const sourceRefs = new Map(Object.keys(asRecord(doc.sources ?? {}, "sources")).map((key, i) => [key, connections[i]!.connection.id]));
  const monitors = parseMonitors(asArray(doc.monitors ?? [], "monitors"), destinations, sourceRefs);
  assertUnique(connections.map(c => c.connection.id), "sources");
  assertUnique(connections.flatMap(c => c.selectedSources.map(source => source.id)), "source selections");
  assertUnique([...destinations.values()].map(d => d.destination.id), "sinks");
  assertUnique(monitors.map(m => m.monitor.id), "monitors");
  assertUnique(monitors.flatMap(m => m.sinks.map(s => s.sink.id)), "monitor sinks");
  const metrics = parseMetrics(doc.metrics, destinations);
  return {input: {providers: options.providers ?? [], destinations: options.destinations ?? [], connections, monitors,
    heartbeat: {kind: "none", deploymentId: "local", appUrl: "http://localhost"}, metrics},
    missingEnv: [...missingEnv].sort(), requiredEnv: [...requiredEnv].sort(), path: filename};
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
  readInclude: ConfigIncludeReader,
): GeneratorConnection[] {
  const out: GeneratorConnection[] = [];
  for (const [id, raw] of Object.entries(sources)) {
    const s = asRecord(raw, `sources.${id}`);
    const sourceDriver = stringField(s, "source", stringField(s, "driver", sourceAlias(id)));
    if (!sourceDriver) throw new Error(`sources.${id}.source is required`);
    if (sourceDriver === "custom-vector") {
      out.push(customVectorConnection(id, s, readInclude));
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
        id: entityId(s, `con_${safeId(id)}`, `sources.${id}`, "con"),
        provider: sourceDriver,
        displayName: stringField(s, "display_name", stringField(s, "displayName", id)) ?? id,
        externalAccountId,
      },
      selectedSources: sourceRows(stringField(s, "id", id)!.replace(/^con_/, ""), sourceDriver, s, externalAccountId),
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

function customVectorConnection(id: string, s: UnknownRecord, readInclude: ConfigIncludeReader): GeneratorConnection {
  const vector = customVectorSourceConfig(s, readInclude, `sources.${id}.vector`);
  return {
    connection: {
      id: entityId(s, `con_${safeId(id)}`, `sources.${id}`, "con"),
      provider: "custom-vector",
      displayName: stringField(s, "display_name", id) ?? id,
      externalAccountId: null,
    },
    selectedSources: [
      {
        id: `src_${safeId(stringField(s, "id", id)!.replace(/^con_/, ""))}_custom_vector`,
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
  externalAccountId: string | null,
): Source[] {
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
  readInclude: ConfigIncludeReader,
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
        id: entityId(s, `dst_${safeId(id)}`, `sinks.${id}`, "dst"),
        kind,
        displayName: stringField(s, "display_name", stringField(s, "displayName", id)) ?? id,
      },
      config: sinkConfig(kind, id, s, env, requiredEnv, readInclude, `sinks.${id}`),
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
  readInclude: ConfigIncludeReader,
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
    return customVectorDestinationConfig(config, readInclude, `${path}.vector`);
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
  sourceRefs: Map<string, string>,
): GeneratorMonitor[] {
  return monitors.map((raw, i) => {
    const m = asRecord(raw, `monitors[${i}]`);
    const name = stringField(m, "name", `monitor_${i + 1}`) ?? `monitor_${i + 1}`;
    const monitorId = entityId(m, `mon_${safeId(name)}`, `monitors[${i}]`, "mon");
    const sourceRef = stringField(m, "source");
    if (sourceRef && !sourceRefs.has(sourceRef)) throw new Error(`monitors[${i}].source references unknown source ${sourceRef}`);
    const connectionId = m.connection_id;
    if (connectionId !== undefined && connectionId !== null &&
        (typeof connectionId !== "string" || ![...sourceRefs.values()].includes(connectionId))) {
      throw new Error(`monitors[${i}].connection_id references unknown connection`);
    }
    if (sourceRef && connectionId !== undefined) throw new Error(`monitors[${i}]: choose source or connection_id`);
    const sinkIds = stringList(m.sinks, `monitors[${i}].sinks`);
    const monitorSinks: GeneratorSink[] = sinkIds.map((sinkId) => {
      const dest = sinks.get(sinkId);
      if (!dest) throw new Error(`monitors[${i}] references unknown sink ${sinkId}`);
      return {
        sink: { id: `snk_${safeId(stringField(m, "id", name)!.replace(/^mon_/, ""))}_${safeId(dest.destination.id.replace(/^dst_/, ""))}`, filterSteps: [] },
        destination: dest.destination,
        destinationConfig: dest.config,
      };
    });
    return {
      monitor: {
        id: monitorId,
        connectionId: sourceRef ? sourceRefs.get(sourceRef)! : (connectionId as string | null | undefined) ?? null,
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
  readInclude: ConfigIncludeReader,
  path: string,
): { fragment: UnknownRecord; feed: string } {
  const vector = asRecord(owner.vector, path);
  if (vector.fragment === undefined && !stringField(vector, "include")) throw new Error(`${path}.include is required`);
  const feed = stringField(vector, "feed");
  if (!feed) throw new Error(`${path}.feed is required`);
  const fragment = vectorFragment(vector, readInclude, path);
  return {
    fragment,
    feed,
  };
}

function customVectorDestinationConfig(owner: UnknownRecord, readInclude: ConfigIncludeReader, path: string): { fragment: UnknownRecord; input: string | null } {
  const vector = asRecord(owner.vector, path);
  return {fragment: vectorFragment(vector, readInclude, path), input: stringField(vector, "input")};
}

function vectorFragment(vector: UnknownRecord, readInclude: ConfigIncludeReader, path: string): UnknownRecord {
  if (vector.fragment !== undefined) {
    if (vector.include !== undefined) throw new Error(`${path}: choose fragment or include`);
    return asRecord(vector.fragment, `${path}.fragment`);
  }
  const include = stringField(vector, "include");
  if (!include) throw new Error(`${path}.include is required`);
  const parsed = readInclude(include);
  if (!isRecord(parsed)) throw new Error(`${path}.include: included file must be a YAML object`);
  return parsed;
}

function resolveEnv(value: unknown, missing: Set<string>, required: Set<string>, envValues: Readonly<Record<string, string | undefined>>): unknown {
  if (typeof value !== "string" || !value.startsWith("env:")) return value;
  const name = value.slice(4);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment reference: ${value}`);
  required.add(name);
  const envValue = Object.hasOwn(envValues, name) ? envValues[name] : undefined;
  if (envValue === undefined || envValue === "") missing.add(name);
  return envValue ?? "";
}

function deepResolveEnv(value: unknown, env: (value: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => deepResolveEnv(v, env));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !["sink", "type", "kind", "display_name", "displayName", "id"].includes(k))
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

function entityId(record: UnknownRecord, fallback: string, path: string, prefix: string): string {
  if (record.id === undefined) return fallback;
  if (typeof record.id !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(record.id)) {
    throw new Error(`${path}.id must be a ${prefix}_ identifier`);
  }
  return record.id;
}

function assertUnique(ids: string[], path: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${path}: duplicate identity ${id}; provide distinct explicit ids`);
    seen.add(id);
  }
}

/** Preserve legacy generated identities while making them explicit for edits.
 * Returned documents can contain the caller's literal credentials: prefer env:
 * references before storing or sharing them. This function never resolves refs. */
export function normalizeConfigDocument(document: unknown, options: ConfigParseOptions = {}): Record<string, unknown> {
  const doc = asRecord(JSON.parse(canonicalConfigJson(document)), options.filename ?? "logt.yaml");
  // Inline custom fragments so hashes capture their content and another runtime
  // can load the document without the original local files.
  const inline = (owner: UnknownRecord, path: string) => {
    const vector = asRecord(owner.vector, `${path}.vector`);
    const reader = options.readInclude ?? ((include: string) => { throw new Error(`No include reader supplied for ${include}`); });
    vector.fragment = JSON.parse(canonicalConfigJson(vectorFragment(vector, reader, `${path}.vector`)));
    delete vector.include;
  };
  for (const [key, source] of Object.entries(asRecord(doc.sources ?? {}, "sources"))) {
    const record = asRecord(source, `sources.${key}`);
    if (record.source === "custom-vector" || record.driver === "custom-vector") inline(record, `sources.${key}`);
  }
  for (const [key, sink] of Object.entries(asRecord(doc.sinks ?? {}, "sinks"))) {
    const record = asRecord(sink, `sinks.${key}`);
    if ((record.sink ?? record.type ?? record.kind) === "custom-vector") inline(isRecord(record.config) ? record.config : record, `sinks.${key}`);
  }
  const parsed = parseConfigDocument(doc, options);
  doc.schema_version = 1;
  const sources = asRecord(doc.sources ?? {}, "sources");
  Object.values(sources).forEach((source, i) => { asRecord(source, "source").id = parsed.input.connections[i]!.connection.id; });
  const sinks = asRecord(doc.sinks ?? {}, "sinks");
  for (const [key, sink] of Object.entries(sinks)) {
    const record = asRecord(sink, "sink");
    record.id = entityId(record, `dst_${safeId(key)}`, `sinks.${key}`, "dst");
  }
  const monitors = asArray(doc.monitors ?? [], "monitors");
  monitors.forEach((monitor, i) => {
    const record = asRecord(monitor, "monitor");
    const definition = parsed.input.monitors[i]!.monitor;
    record.id = definition.id;
    record.connection_id = definition.connectionId;
    delete record.source;
    // Capture defaults before a label edit can change their interpretation.
    if (record.filter === undefined) record.filter = definition.filterSteps;
  });
  doc.sources = sources; doc.sinks = sinks; doc.monitors = monitors;
  return doc;
}

/** Deterministic JSON: sort object keys, preserve ordered pipeline arrays,
 * reject values JSON would silently discard or coerce. No input mutation. */
export function canonicalConfigJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object") throw new Error("Configuration must contain only JSON values");
    if (ancestors.has(item)) throw new Error("Configuration contains a cycle");
    ancestors.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = Array.from(item, visit);
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Configuration must contain plain objects");
      result = Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as UnknownRecord)[key])]));
    }
    ancestors.delete(item);
    return result;
  };
  return JSON.stringify(visit(value));
}

/** Hash unresolved, normalized configuration. Runtime secret values are not
 * inputs unless the caller put literal credentials in the document itself. */
export async function hashConfigDocument(document: unknown, options: ConfigParseOptions = {}): Promise<string> {
  const canonical = canonicalConfigJson(normalizeConfigDocument(document, options));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
