import { applyMetricsToSnapshot, type MetricsSnapshot, type ParsedMetric } from "./metrics-snapshot";

type Result = "ok" | "not_found" | "invalid_token";
type IngestResult = Result | "busy";
type Entry = { token: string; loadedAt: number; accessedAt: number; status: string | null; seenAt: number | null; raw: string | null; persisted: MetricsSnapshot | null; snapshot: MetricsSnapshot | null; pending: Map<string, ParsedMetric> };
type Row = { heartbeat_token: string | null; status: string | null; last_seen_at: number | null; metrics_snapshot_json: string | null };
const TRACKED = new Set(["component_received_events_total", "component_sent_events_total", "component_errors_total", "component_discarded_events_total", "uptime_seconds", "build_info"]);
function equal(a: string, b: string): boolean { let difference = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return difference === 0; }
function decode(raw: string | null): MetricsSnapshot | null {
  try {
    if (!raw) return null;
    const value = JSON.parse(raw) as MetricsSnapshot;
    if (!value || !value.byComponent || Array.isArray(value.byComponent) || !value.totals || !value.lifetimeOffset || !Number.isFinite(value.updatedAt) || Object.keys(value.byComponent).length > 256) return null;
    if (value.processStartAt !== null && !Number.isFinite(value.processStartAt)) return null;
    for (const field of ["received", "sent", "errors", "discarded"] as const) {
      if (!Number.isFinite(value.totals[field]) || value.totals[field] < 0 || !Number.isFinite(value.lifetimeOffset[field]) || value.lifetimeOffset[field] < 0) return null;
    }
    for (const component of Object.values(value.byComponent)) {
      if (!component || typeof component !== "object" || Array.isArray(component) || Object.keys(component.errorsByType ?? {}).length > 32) return null;
    }
    return value;
  } catch { return null; }
}
function urgent(previous: MetricsSnapshot | null, next: MetricsSnapshot): boolean {
  if (!previous || previous.processStartAt !== next.processStartAt || previous.vectorVersion !== next.vectorVersion) return true;
  // Filters intentionally discard ordinary events. Their cumulative counter is
  // checkpointed with received/sent traffic; it is not an urgent failure signal.
  if (next.totals.errors > previous.totals.errors) return true;
  for (const field of ["received", "sent", "errors", "discarded"] as const) if (next.lifetimeOffset[field] > previous.lifetimeOffset[field]) return true;
  const keys = Object.keys(next.byComponent); return keys.length !== Object.keys(previous.byComponent).length || keys.some(key => !Object.hasOwn(previous.byComponent, key));
}
function remember(entry: Entry, events: ParsedMetric[]): void {
  for (const event of events) {
    if (!TRACKED.has(event.bareName)) continue;
    const global = event.bareName === "uptime_seconds" || event.bareName === "build_info";
    if (event.bareName === "uptime_seconds" && !event.isGauge) continue;
    if (event.bareName === "build_info" && !event.buildVersion) continue;
    if (!global && (!event.isCounter || !event.componentId || !Object.hasOwn(entry.snapshot!.byComponent, event.componentId))) continue;
    const errorType = event.bareName === "component_errors_total" ? event.errorType ?? "other" : undefined;
    if (errorType !== undefined && !Object.hasOwn(entry.snapshot!.byComponent[event.componentId!]!.errorsByType ?? {}, errorType)) continue;
    const key = JSON.stringify([event.bareName, global ? undefined : event.componentId, errorType]);
    const previous = entry.pending.get(key);
    if (previous && previous.timestampMs >= event.timestampMs) continue;
    // Only accepted identities are buffered: at most 256 components, three
    // ordinary counters and 32 error labels each, plus two global metrics.
    entry.pending.set(key, event);
  }
}

/** Each Worker isolate owns one coordinator. D1 serializes compare-and-swap
 * checkpoints across them; warm ordinary traffic remains in bounded memory. */
export function createDeploymentIngest(options: { ttlMs?: number; checkpointMs?: number; maxEntries?: number } = {}) {
  const ttl = options.ttlMs ?? 600_000, interval = options.checkpointMs ?? 300_000, maximum = options.maxEntries ?? 2_000;
  const cache = new Map<string, Entry>(), locks = new Map<string, Promise<void>>();
  async function row(db: D1Database, id: string): Promise<Row | null> {
    return db.prepare("SELECT heartbeat_token, status, last_seen_at, metrics_snapshot_json FROM deployments WHERE id = ?").bind(id).first<Row>();
  }
  function refresh(entry: Entry, current: Row, now: number): void {
    entry.token = current.heartbeat_token!; entry.loadedAt = now; entry.status = current.status; entry.seenAt = current.last_seen_at; entry.raw = current.metrics_snapshot_json; entry.persisted = decode(entry.raw);
  }
  async function load(db: D1Database, id: string, token: string, now: number): Promise<Entry | Result> {
    let entry = cache.get(id);
    if (entry && now >= entry.loadedAt && now - entry.loadedAt < ttl && equal(entry.token, token)) { entry.accessedAt = now; return entry; }
    const current = await row(db, id);
    if (!current?.heartbeat_token) { cache.delete(id); return "not_found"; }
    if (!equal(current.heartbeat_token, token)) { if (!entry || !equal(entry.token, current.heartbeat_token)) cache.delete(id); return "invalid_token"; }
    if (entry && equal(entry.token, token)) {
      refresh(entry, current, now); entry.accessedAt = now;
      entry.snapshot = entry.pending.size ? applyMetricsToSnapshot(entry.persisted, [...entry.pending.values()]) : entry.persisted;
      return entry;
    }
    entry = { token, loadedAt: now, accessedAt: now, status: current.status, seenAt: current.last_seen_at, raw: current.metrics_snapshot_json, persisted: decode(current.metrics_snapshot_json), snapshot: decode(current.metrics_snapshot_json), pending: new Map() };
    cache.set(id, entry);
    if (cache.size > maximum) {
      for (const [key, value] of cache) if (now - value.accessedAt >= ttl) cache.delete(key);
      if (cache.size > maximum) { const oldest = [...cache].sort((a, b) => a[1].accessedAt - b[1].accessedAt); for (const [key] of oldest.slice(0, cache.size - maximum)) cache.delete(key); }
    }
    return entry;
  }
  async function recover(db: D1Database, id: string, entry: Entry, token: string, now: number): Promise<Result> {
    const current = await row(db, id);
    if (!current?.heartbeat_token) { cache.delete(id); return "not_found"; }
    if (!equal(current.heartbeat_token, token)) { cache.delete(id); return "invalid_token"; }
    refresh(entry, current, now); return "ok";
  }
  async function run(db: D1Database, id: string, token: string, events: ParsedMetric[], now: number): Promise<IngestResult> {
    const entry = await load(db, id, token, now); if (typeof entry === "string") return entry;
    if (events.length) {
      let next = applyMetricsToSnapshot(entry.snapshot, events); next.updatedAt = Math.max(now, entry.persisted?.updatedAt ?? now);
      for (let attempt = 0; attempt < 3; attempt++) {
        entry.snapshot = next;
        const material = urgent(entry.persisted, next);
        if (!material && entry.persisted && now - entry.persisted.updatedAt < interval) { remember(entry, events); break; }
        let result: D1Result;
        try { result = await db.prepare(`UPDATE deployments SET metrics_snapshot_json = ?, last_seen_at = MAX(COALESCE(last_seen_at, ?), ?),
          status = CASE WHEN status IN ('pending', 'crashed') THEN 'running' ELSE status END, updated_at = MAX(updated_at, ?)
          WHERE id = ? AND heartbeat_token = ? AND metrics_snapshot_json IS ?`)
          .bind(JSON.stringify(next), now, now, now, id, token, entry.raw).run(); }
        catch (error) { remember(entry, events); throw error; }
        if ((result.meta.changes ?? 0) > 0) { entry.raw = JSON.stringify(next); entry.persisted = next; entry.seenAt = Math.max(entry.seenAt ?? now, now); if (entry.status === "pending" || entry.status === "crashed") entry.status = "running"; entry.pending.clear(); return "ok"; }
        const recovered = await recover(db, id, entry, token, now); if (recovered !== "ok") return recovered;
        // Reapply the latest buffered samples before this request. Timestamp
        // checks in the public merger reject older/duplicate observations.
        const base = entry.pending.size ? applyMetricsToSnapshot(entry.persisted, [...entry.pending.values()]) : entry.persisted;
        next = applyMetricsToSnapshot(base, events); next.updatedAt = Math.max(now, entry.persisted?.updatedAt ?? now); entry.snapshot = next;
        if (attempt === 2) {
          remember(entry, events);
          // The last read may prove a winner already persisted this sample, or
          // make an ordinary checkpoint unnecessary. Otherwise retain it and
          // ask the sender to retry without turning a normal race into a throw.
          if (!urgent(entry.persisted, next) && entry.persisted && now - entry.persisted.updatedAt < interval) return "ok";
          return "busy";
        }
      }
    }
    const live = entry.status === "pending" || entry.status === "crashed" || entry.seenAt === null || now - entry.seenAt >= interval;
    if (!live) return "ok";
    const result = await db.prepare(`UPDATE deployments SET last_seen_at = MAX(COALESCE(last_seen_at, ?), ?),
      status = CASE WHEN status IN ('pending', 'crashed') THEN 'running' ELSE status END, updated_at = MAX(updated_at, ?)
      WHERE id = ? AND heartbeat_token = ? AND (status IN ('pending', 'crashed') OR last_seen_at IS NULL OR last_seen_at <= ?)`)
      .bind(now, now, now, id, token, now - interval).run();
    if ((result.meta.changes ?? 0) > 0) { entry.seenAt = Math.max(entry.seenAt ?? now, now); if (entry.status === "pending" || entry.status === "crashed") entry.status = "running"; return "ok"; }
    return recover(db, id, entry, token, now);
  }
  async function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); locks.set(id, held);
    await previous;
    try { return await action(); }
    finally { release(); if (locks.get(id) === held) locks.delete(id); }
  }
  return {
    async authenticate(db: D1Database, id: string, token: string, now: number): Promise<Result> {
      return exclusive(id, async () => { const entry = await load(db, id, token, now); return typeof entry === "string" ? entry : "ok"; });
    },
    async ingest(db: D1Database, id: string, token: string, events: ParsedMetric[], now: number): Promise<IngestResult> {
      return exclusive(id, () => run(db, id, token, events, now));
    },
  };
}
