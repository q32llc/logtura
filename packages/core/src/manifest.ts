import { canonicalConfigJson } from "./json";
import type { ConfigParseOptions, ParsedConfig } from "./config";
import type { GenerateInput, FilterStep, Connection, Source, Monitor, Sink, Destination } from "./types";
type Row = Record<string, unknown>;
export interface SecretReference {
    env: string;
    version: string;
}
export interface DeploymentManifest {
    kind: "logtura.deployment";
    schema_version: 1;
    connections: Array<{
        connection: Connection;
        selectedSources: Array<Omit<Source, "metadata"> & {
            metadata: SecretReference | null;
        }>;
        selectAll?: boolean;
        credentials: SecretReference | null;
    }>;
    monitors: Array<{
        monitor: Monitor;
        sinks: Array<{
            sink: Sink;
            destination: Destination;
            destinationConfig: SecretReference;
        }>;
    }>;
    heartbeat?: GenerateInput["heartbeat"];
    metrics?: {
        kind: "none";
    } | {
        kind: "logtura";
        deploymentId: string;
        appUrl: string;
    } | {
        kind: "destination";
        destination: Destination;
        destinationConfig: SecretReference;
    };
    runtimeEnv: SecretReference | null;
}
export type SecretVersioner = (name: string, value: string) => Promise<string>;
/** Stable opaque versions detect sensitive payload changes without exposing a
 * dictionary-checkable plain hash. The key remains in the caller's private store. */
export async function createSecretVersioner(key: string): Promise<SecretVersioner> {
    if (!key)
        throw new Error("A private secret-version key is required");
    const encoder = new TextEncoder();
    const signingKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return async (name, value) => { const digest = await crypto.subtle.sign("HMAC", signingKey, encoder.encode(`manifest-secret-v1\0${name}\0${value}`)); return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join(""); };
}
/** Export driver payloads as JSON-valued environment references, never guessing
 * which custom fields contain secrets. Only entity topology is public. */
export async function exportDeploymentManifest(input: GenerateInput, versioner: SecretVersioner): Promise<{
    document: DeploymentManifest;
    secretValues: Record<string, string>;
}> {
    const secretValues: Record<string, string> = {};
    const tasks: Promise<void>[] = [];
    const secret = (category: string, id: string, value: unknown): SecretReference => {
        const name = `LOGT_${category}_${[...new TextEncoder().encode(id)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
        const encoded = canonicalConfigJson(value);
        if (secretValues[name] !== undefined && secretValues[name] !== encoded)
            throw new Error(`Conflicting secret payload: ${name}`);
        secretValues[name] = encoded;
        const ref = { env: name, version: "" };
        tasks.push(versioner(name, encoded).then(version => { if (!version)
            throw new Error("Secret version must be nonempty"); ref.version = version; }));
        return ref;
    };
    const document: DeploymentManifest = { kind: "logtura.deployment", schema_version: 1,
        connections: input.connections.map(c => ({ connection: pick(c.connection, ["id", "provider", "displayName", "externalAccountId"]) as unknown as Connection, selectedSources: c.selectedSources.map(s => ({ ...pick(s, ["id", "externalId", "displayName", "sourceKind"]), metadata: s.metadata === null ? null : secret("SOURCE", s.id, s.metadata) })),
            ...(c.selectAll === undefined ? {} : { selectAll: c.selectAll }), credentials: c.credentials === undefined ? null : secret("CREDENTIALS", c.connection.id, c.credentials) })),
        monitors: input.monitors.map(m => ({ monitor: { ...pick(m.monitor, ["id", "connectionId", "displayName", "enabled"]), filterSteps: filters(m.monitor.filterSteps, "monitor filters") } as unknown as Monitor, sinks: m.sinks.map(s => ({ sink: { id: s.sink.id, filterSteps: filters(s.sink.filterSteps, "sink filters") }, destination: pick(s.destination, ["id", "kind", "displayName"]) as unknown as Destination, destinationConfig: secret("DESTINATION", s.sink.id, s.destinationConfig) })) })),
        ...(input.heartbeat === undefined ? {} : { heartbeat: pick(input.heartbeat, ["kind", "deploymentId", "appUrl"]) as GenerateInput["heartbeat"] }),
        ...(input.metrics === undefined ? {} : { metrics: input.metrics.kind === "destination" ? { kind: "destination", destination: pick(input.metrics.destination, ["id", "kind", "displayName"]) as unknown as Destination, destinationConfig: secret("METRICS", input.metrics.destination.id, input.metrics.destinationConfig) } : input.metrics.kind === "none" ? { kind: "none" } : pick(input.metrics, ["kind", "deploymentId", "appUrl"]) as {
                kind: "logtura";
                deploymentId: string;
                appUrl: string;
            } }),
        runtimeEnv: input.runtimeEnv === undefined ? null : secret("RUNTIME", "ENV", input.runtimeEnv),
    };
    await Promise.all(tasks);
    parseDeploymentManifest(document, { env: secretValues });
    return { document: JSON.parse(canonicalConfigJson(document)), secretValues };
}
function pick<T extends object, K extends keyof T>(value: T, keys: K[]): Pick<T, K> { return Object.fromEntries(keys.map(key => [key, value[key]])) as Pick<T, K>; }
function only(r: Row, keys: string[], path: string): void { if (Object.keys(r).some(key => !keys.includes(key)))
    throw new Error(`${path}: unknown field`); }
function row(value: unknown, path: string): Row { if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: expected object`); return value as Row; }
function list(value: unknown, path: string): unknown[] { if (!Array.isArray(value))
    throw new Error(`${path}: expected array`); return value; }
function text(value: unknown, path: string): string { if (typeof value !== "string" || !value)
    throw new Error(`${path}: expected nonempty string`); return value; }
function nullableText(value: unknown, path: string): string | null { return value === null ? null : text(value, path); }
function bool(value: unknown, path: string): boolean { if (typeof value !== "boolean")
    throw new Error(`${path}: expected boolean`); return value; }
function filters(value: unknown, path: string): FilterStep[] {
    return list(value, path).map((value, i) => {
        const r = row(value, `${path}[${i}]`);
        const kind = text(r.kind, path);
        const keys: Record<string, string[]> = { errors: [], level: ["level", "mode"], match: ["pattern", "mode", "field"], rate_limit: ["per_minute"], dedup: ["window_secs", "fields"], sample: ["rate"], rollup: ["window_secs", "group_by", "max_samples"] };
        if (!["errors", "level", "match", "rate_limit", "dedup", "sample", "rollup"].includes(kind))
            throw new Error(`${path}: unknown filter kind`);
        only(r, ["kind", ...keys[kind]!], path);
        if (kind === "level")
            text(r.level, path);
        if (kind === "match") {
            text(r.pattern, path);
            if (!["include", "exclude"].includes(String(r.mode)))
                throw new Error(`${path}: invalid match mode`);
        }
        if (r.mode !== undefined && !["include", "exclude"].includes(String(r.mode)))
            throw new Error(`${path}: invalid filter mode`);
        for (const key of ["window_secs", "per_minute", "rate", "max_samples"]) {
            if (r[key] !== undefined && (typeof r[key] !== "number" || !Number.isFinite(r[key]) || (r[key] as number) <= 0))
                throw new Error(`${path}: invalid ${key}`);
        }
        if (kind === "rate_limit" && r.per_minute === undefined || kind === "sample" && r.rate === undefined || kind === "dedup" && r.window_secs === undefined || kind === "rollup" && r.window_secs === undefined)
            throw new Error(`${path}: missing filter parameter`);
        for (const key of ["fields", "group_by"]) {
            if (r[key] !== undefined)
                list(r[key], path).forEach(v => text(v, path));
        }
        if (r.field !== undefined)
            text(r.field, path);
        return JSON.parse(canonicalConfigJson(r)) as FilterStep;
    });
}
export function parseDeploymentManifest(value: unknown, options: ConfigParseOptions = {}): ParsedConfig {
    const doc = row(value, "manifest");
    if (doc.kind !== "logtura.deployment" || doc.schema_version !== 1)
        throw new Error("Unsupported deployment manifest schema");
    only(doc, ["kind", "schema_version", "connections", "monitors", "heartbeat", "metrics", "runtimeEnv"], "manifest");
    const missing = new Set<string>(), required = new Set<string>(), versions = new Map<string, string>();
    const secret = (value: unknown, path: string, fallback: unknown): unknown => {
        const ref = row(value, path);
        if (Object.keys(ref).some(key => !["env", "version"].includes(key)) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(ref.env)))
            throw new Error(`${path}: expected secret reference`);
        const name = text(ref.env, path);
        const version = text(ref.version, path);
        const prior = versions.get(name);
        if (prior !== undefined && prior !== version) throw new Error("Conflicting secret reference versions");
        versions.set(name, version);
        required.add(name);
        const encoded = options.env && Object.hasOwn(options.env, name) ? options.env[name] : undefined;
        if (encoded === undefined || encoded === "") {
            missing.add(name);
            return fallback;
        }
        try {
            return JSON.parse(encoded);
        }
        catch {
            throw new Error(`${path}: invalid JSON secret ${name}`);
        }
    };
    const connections = list(doc.connections, "connections").map((value, i) => {
        const r = row(value, `connections[${i}]`), c = row(r.connection, "connection");
        only(r, ["connection", "selectedSources", "selectAll", "credentials"], "connection entry");
        only(c, ["id", "provider", "displayName", "externalAccountId"], "connection");
        const credentials = r.credentials === null ? undefined : row(secret(r.credentials, "credentials", {}), "credentials payload");
        return { connection: { id: text(c.id, "connection.id"), provider: text(c.provider, "provider"), displayName: text(c.displayName, "displayName"), externalAccountId: nullableText(c.externalAccountId, "accountId") }, credentials,
            ...(r.selectAll === undefined ? {} : { selectAll: bool(r.selectAll, "selectAll") }), selectedSources: list(r.selectedSources, "selectedSources").map(value => {
                const s = row(value, "source");
                only(s, ["id", "externalId", "displayName", "sourceKind", "metadata"], "source");
                const metadata = s.metadata === null ? null : secret(s.metadata, "metadata", null);
                return { id: text(s.id, "source.id"), externalId: text(s.externalId, "externalId"), displayName: text(s.displayName, "displayName"), sourceKind: text(s.sourceKind, "sourceKind"), metadata: metadata === null ? null : row(metadata, "metadata payload") };
            }) };
    });
    const destination = (value: unknown): Destination => { const d = row(value, "destination"); only(d, ["id", "kind", "displayName"], "destination"); return { id: text(d.id, "destination.id"), kind: text(d.kind, "destination.kind"), displayName: text(d.displayName, "displayName") }; };
    const monitors = list(doc.monitors, "monitors").map(value => {
        const r = row(value, "monitor entry"), m = row(r.monitor, "monitor");
        only(r, ["monitor", "sinks"], "monitor entry");
        only(m, ["id", "connectionId", "displayName", "enabled", "filterSteps"], "monitor");
        return {
            monitor: { id: text(m.id, "monitor.id"), connectionId: nullableText(m.connectionId, "connectionId"), displayName: text(m.displayName, "displayName"), enabled: bool(m.enabled, "enabled"), filterSteps: filters(m.filterSteps, "monitor filters") },
            sinks: list(r.sinks, "sinks").map(value => { const s = row(value, "sink entry"), entity = row(s.sink, "sink"); only(s, ["sink", "destination", "destinationConfig"], "sink entry"); only(entity, ["id", "filterSteps"], "sink"); return { sink: { id: text(entity.id, "sink.id"), filterSteps: filters(entity.filterSteps, "sink filters") }, destination: destination(s.destination), destinationConfig: secret(s.destinationConfig, "destinationConfig", {}) }; })
        };
    });
    const scoped = (value: unknown) => { const r = row(value, "reporting target"); only(r, ["kind", "deploymentId", "appUrl"], "reporting target"); if (r.kind !== "none" && r.kind !== "logtura")
        throw new Error("Invalid reporting target"); return { kind: r.kind as "none" | "logtura", deploymentId: text(r.deploymentId, "deploymentId"), appUrl: text(r.appUrl, "appUrl") }; };
    let metrics: GenerateInput["metrics"];
    if (doc.metrics !== undefined) {
        const m = row(doc.metrics, "metrics");
        only(m, m.kind === "destination" ? ["kind", "destination", "destinationConfig"] : m.kind === "none" ? ["kind"] : ["kind", "deploymentId", "appUrl"], "metrics");
        metrics = m.kind === "destination" ? { kind: "destination", destination: destination(m.destination), destinationConfig: secret(m.destinationConfig, "metrics config", {}) } : m.kind === "none" ? { kind: "none" } : scoped(m);
    }
    const runtimeEnv = doc.runtimeEnv === null ? undefined : row(secret(doc.runtimeEnv, "runtimeEnv", {}), "runtime env payload");
    if (runtimeEnv)
        for (const [name, value] of Object.entries(runtimeEnv))
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string")
                throw new Error("Invalid runtime environment value");
    const unique = (ids: string[], name: string) => { if (new Set(ids.map(id => id.replace(/[^a-zA-Z0-9_]/g, "_"))).size !== ids.length)
        throw new Error(`Duplicate ${name} identity`); };
    unique(connections.map(c => c.connection.id), "connection");
    unique(connections.flatMap(c => c.selectedSources.map(s => s.id)), "source");
    unique(monitors.map(m => m.monitor.id), "monitor");
    unique(monitors.flatMap(m => m.sinks.map(s => s.sink.id)), "sink");
    for (const m of monitors)
        if (m.monitor.connectionId !== null && !connections.some(c => c.connection.id === m.monitor.connectionId))
            throw new Error("Monitor references an unknown connection");
    return { input: { providers: options.providers ?? [], destinations: options.destinations ?? [], connections, monitors, ...(doc.heartbeat === undefined ? {} : { heartbeat: scoped(doc.heartbeat) }), ...(metrics === undefined ? {} : { metrics }), ...(runtimeEnv === undefined ? {} : { runtimeEnv: runtimeEnv as Record<string, string> }) }, missingEnv: [...missing].sort(), requiredEnv: [...required].sort(), path: options.filename ?? "logt.yaml" };
}
export function normalizeDeploymentManifest(value: unknown): Record<string, unknown> {
    const clone = JSON.parse(canonicalConfigJson(value)) as Record<string, unknown>;
    parseDeploymentManifest(clone);
    return clone;
}
