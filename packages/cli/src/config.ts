import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
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

export interface ParsedConfig {
  input: GenerateInput;
  missingEnv: string[];
}

export function loadConfigFile(path: string): ParsedConfig {
  return parseConfig(readFileSync(path, "utf8"), path);
}

export function parseConfig(text: string, filename = "logtura.yaml"): ParsedConfig {
  const doc = parseYaml(text) as unknown;
  if (!isRecord(doc)) throw new Error(`${filename}: expected a YAML object`);
  const missingEnv = new Set<string>();
  const env = (value: unknown): unknown => resolveEnv(value, missingEnv);

  const connections = parseSources(asRecord(doc.sources, "sources"), env);
  const destinations = parseSinks(asRecord(doc.sinks, "sinks"), env);
  const monitors = parseMonitors(asArray(doc.monitors, "monitors"), destinations);
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
  };
}

function parseSources(
  sources: UnknownRecord,
  env: (value: unknown) => unknown,
): GeneratorConnection[] {
  const out: GeneratorConnection[] = [];
  for (const [id, raw] of Object.entries(sources)) {
    const s = asRecord(raw, `sources.${id}`);
    const provider = stringField(s, "provider", sourceProviderAlias(id));
    if (!provider) throw new Error(`sources.${id}.provider is required`);
    const displayName = stringField(s, "display_name", id) ?? id;
    const externalAccountId =
      stringValue(env(s.account_id ?? s.external_account_id)) ?? null;
    const credentials = sourceCredentials(provider, s, env);
    const selectedSources = sourceRows(id, provider, s);
    const selectAll = boolField(s, "all", false);
    out.push({
      connection: {
        id: `con_${safeId(id)}`,
        provider,
        displayName,
        externalAccountId,
      },
      selectedSources,
      selectAll,
      credentials,
    });
  }
  return out;
}

function sourceProviderAlias(id: string): string | null {
  if (id === "workers" || id === "cloudflare_workers") {
    return "cloudflare-worker-tail";
  }
  if (id === "edge" || id === "supabase_edge") return "supabase-edge-logs";
  if (id === "fly" || id === "fly_apps") return "fly-log-tail";
  if (id === "ai_gateway" || id === "cloudflare_ai_gateway") {
    return "cloudflare-ai-gateway";
  }
  return null;
}

function sourceCredentials(
  provider: string,
  s: UnknownRecord,
  env: (value: unknown) => unknown,
): Record<string, unknown> {
  const rawCreds = isRecord(s.credentials) ? s.credentials : {};
  const from = (key: string, fallback?: unknown) =>
    env(rawCreds[key] ?? s[key] ?? fallback);
  if (provider.startsWith("cloudflare-")) {
    return { apiToken: stringValue(from("api_token")) ?? "" };
  }
  if (provider === "supabase-edge-logs") {
    return { pat: stringValue(from("pat")) ?? "" };
  }
  if (provider === "fly-log-tail") {
    return { apiToken: stringValue(from("api_token")) ?? "" };
  }
  return Object.fromEntries(
    Object.entries(rawCreds).map(([k, v]) => [k, env(v)]),
  );
}

function sourceRows(id: string, provider: string, s: UnknownRecord): Source[] {
  if (provider === "cloudflare-worker-tail") {
    return stringList(s.scripts ?? s.sources, `sources.${id}.scripts`).map(
      (name) => source(id, name, "cf_worker"),
    );
  }
  if (provider === "fly-log-tail") {
    return stringList(s.apps ?? s.sources, `sources.${id}.apps`).map((name) =>
      source(id, name, "fly_app"),
    );
  }
  if (provider === "cloudflare-ai-gateway") {
    return stringList(s.gateways ?? s.sources, `sources.${id}.gateways`).map(
      (name) => source(id, name, "cf_ai_gateway"),
    );
  }
  if (provider === "supabase-edge-logs") {
    const rows: Source[] = [];
    for (const item of asArray(s.functions ?? [], `sources.${id}.functions`)) {
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
    source(id, name, provider),
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

function parseSinks(
  sinks: UnknownRecord,
  env: (value: unknown) => unknown,
): Map<string, { destination: { id: string; kind: string; displayName: string }; config: unknown }> {
  const out = new Map<
    string,
    { destination: { id: string; kind: string; displayName: string }; config: unknown }
  >();
  for (const [id, raw] of Object.entries(sinks)) {
    const s = asRecord(raw, `sinks.${id}`);
    const kind = stringField(s, "type", stringField(s, "kind"));
    if (!kind) throw new Error(`sinks.${id}.type is required`);
    out.set(id, {
      destination: {
        id: `dst_${safeId(id)}`,
        kind,
        displayName: stringField(s, "display_name", id) ?? id,
      },
      config: sinkConfig(kind, s, env),
    });
  }
  return out;
}

function sinkConfig(
  kind: string,
  s: UnknownRecord,
  env: (value: unknown) => unknown,
): unknown {
  const config = isRecord(s.config) ? s.config : s;
  if (kind === "slack") {
    return {
      webhookUrl: stringValue(env(config.webhook_url ?? config.webhookUrl)) ?? "",
      teamName: stringField(config, "team_name", stringField(config, "teamName")),
      channel: stringField(config, "channel"),
    };
  }
  return deepResolveEnv(config, env);
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
        filterSteps: parseFilterSteps(m.filter ?? []),
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

function resolveEnv(value: unknown, missing: Set<string>): unknown {
  if (typeof value !== "string") return value;
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const envValue = process.env[name];
  if (envValue === undefined) missing.add(name);
  return envValue ?? "";
}

function deepResolveEnv(value: unknown, env: (value: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => deepResolveEnv(v, env));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !["type", "kind", "display_name"].includes(k))
        .map(([k, v]) => [camel(k), deepResolveEnv(v, env)]),
    );
  }
  return env(value);
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

function boolField(
  rec: UnknownRecord,
  field: string,
  fallback: boolean,
): boolean {
  const value = rec[field];
  return typeof value === "boolean" ? value : fallback;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

function camel(value: string): string {
  return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
