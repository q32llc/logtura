/**
 * Parse + maintain a fixed-memory snapshot of Vector internal metrics
 * for a single deployment.
 *
 * Wire shape from Vector's internal_metrics → http sink (codec: json):
 * a JSON array of MetricEvent objects per POST. Each carries the
 * absolute counter value at sample time. Vector batches up to N
 * events per request (we set max_events:100 in the generator).
 *
 * What we keep:
 *   - latest counter value per (component_id, metric)
 *   - previous value + sample timestamp so we can derive a rate
 *   - process_start_at derived from vector_uptime_seconds, used to
 *     detect Vector restarts (when this jumps forward, counters
 *     reset to 0 — we roll the pre-restart totals into
 *     lifetime_offset so the UI's "events forwarded since start"
 *     doesn't go backwards)
 *   - pre-rolled totals across all components, so the UI doesn't
 *     iterate the per-component map on every render
 *
 * What we DON'T keep:
 *   - any kind of time series. The snapshot is overwrite-only. Its
 *     size is bounded by the number of components in the user's
 *     Vector config (~10–60), not by event volume or time.
 *
 * The MAX size also caps regardless of any input — if a malicious
 * or bizarre payload showed up with thousands of distinct
 * component_ids, we'd refuse to grow the snapshot past
 * MAX_COMPONENTS rather than blow up a D1 row.
 */

/** Names we actually care about (Vector's `vector_` namespace
 *  stripped). Anything outside this list is ignored. Keeps the
 *  snapshot focused on operational health, not every gauge Vector
 *  exposes. */
const TRACKED_COUNTERS = {
  component_received_events_total: "received",
  component_sent_events_total: "sent",
  component_errors_total: "errors",
  component_discarded_events_total: "discarded",
} as const;

const UPTIME_GAUGE = "uptime_seconds";
const BUILD_INFO = "build_info";

/** Hard cap on per-deployment component count. If the user's config
 *  blows past this, we drop new components rather than grow the
 *  snapshot unboundedly. 256 leaves plenty of room (a 24-worker
 *  deploy lands ~30 components). */
const MAX_COMPONENTS = 256;

export type ComponentKind = "source" | "transform" | "sink";

export interface ComponentMetrics {
  kind: ComponentKind | "unknown";
  /** Vector component type, e.g. "exec", "filter", "http". */
  type: string;
  /** Latest absolute counter values, since current process start. */
  received?: number;
  sent?: number;
  errors?: number;
  discarded?: number;
  /** Previous sample, kept so we can derive per-interval rates
   *  without a time series. Overwritten on each post. */
  prev?: {
    received?: number;
    sent?: number;
    errors?: number;
    discarded?: number;
    sampleAt: number;
  };
  /** Most recent observation time for this component, ms epoch. */
  lastSeen: number;
}

export interface MetricsSnapshot {
  byComponent: Record<string, ComponentMetrics>;
  /** Pre-rolled totals (since current process start, before adding
   *  lifetime_offset). The UI displays totals.* + lifetimeOffset.*
   *  for "since the deployment first started." */
  totals: {
    received: number;
    sent: number;
    errors: number;
    discarded: number;
  };
  /** Accumulated counter values from previous Vector processes.
   *  Bumped whenever a restart is detected. Lets "lifetime totals"
   *  in the UI survive process restarts (machine reboots, OOM, etc.) */
  lifetimeOffset: {
    received: number;
    sent: number;
    errors: number;
    discarded: number;
  };
  /** Inferred Vector process boot time. Stable while Vector keeps
   *  running; jumps forward on restart. We use this to gate the
   *  "treat counters as fresh / accumulate to lifetime" decision. */
  processStartAt: number | null;
  /** ms epoch we last successfully parsed a metrics POST. */
  updatedAt: number;
  /** Vector version + build info, from the build_info gauge's tags. */
  vectorVersion?: string;
}

interface RawMetricEvent {
  name?: string;
  namespace?: string;
  tags?: Record<string, string>;
  timestamp?: string | number;
  counter?: { value?: number };
  gauge?: { value?: number };
}

interface ParsedMetric {
  bareName: string;
  componentId?: string;
  componentKind?: ComponentKind;
  componentType?: string;
  buildVersion?: string;
  timestampMs: number;
  value: number;
  isCounter: boolean;
  isGauge: boolean;
}

export function emptySnapshot(): MetricsSnapshot {
  return {
    byComponent: {},
    totals: { received: 0, sent: 0, errors: 0, discarded: 0 },
    lifetimeOffset: { received: 0, sent: 0, errors: 0, discarded: 0 },
    processStartAt: null,
    updatedAt: 0,
  };
}

/** Parse a request body that may be a JSON array, a single JSON
 *  object, or NDJSON (one JSON event per line). Vector's http sink
 *  with codec:json sends an array per batch, but the consumer
 *  shouldn't care — be liberal. */
export function parseMetricsBody(text: string): ParsedMetric[] {
  if (!text) return [];
  const trimmed = text.trim();
  let raws: RawMetricEvent[];
  try {
    if (trimmed.startsWith("[")) {
      raws = JSON.parse(trimmed) as RawMetricEvent[];
    } else if (trimmed.startsWith("{")) {
      raws = [JSON.parse(trimmed) as RawMetricEvent];
    } else {
      // NDJSON fallback.
      raws = trimmed
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as RawMetricEvent);
    }
  } catch {
    return [];
  }

  const out: ParsedMetric[] = [];
  for (const raw of raws) {
    if (!raw || typeof raw !== "object") continue;
    const name = stripNamespace(raw.name, raw.namespace);
    if (!name) continue;
    const tags = raw.tags ?? {};
    const componentId = typeof tags.component_id === "string" ? tags.component_id : undefined;
    const componentKindRaw = tags.component_kind;
    const componentKind =
      componentKindRaw === "source" ||
      componentKindRaw === "transform" ||
      componentKindRaw === "sink"
        ? componentKindRaw
        : undefined;
    const componentType =
      typeof tags.component_type === "string" ? tags.component_type : undefined;
    const timestampMs = parseTimestampMs(raw.timestamp);
    const isCounter = raw.counter !== undefined;
    const isGauge = raw.gauge !== undefined;
    const value = isCounter
      ? Number(raw.counter?.value ?? 0)
      : isGauge
        ? Number(raw.gauge?.value ?? 0)
        : 0;
    const buildVersion =
      name === BUILD_INFO && typeof tags.version === "string"
        ? tags.version
        : undefined;
    out.push({
      bareName: name,
      componentId,
      componentKind,
      componentType,
      buildVersion,
      timestampMs,
      value,
      isCounter,
      isGauge,
    });
  }
  return out;
}

function stripNamespace(name: unknown, namespace: unknown): string | null {
  if (typeof name !== "string" || !name) return null;
  if (typeof namespace === "string" && namespace) {
    const pfx = `${namespace}_`;
    if (name.startsWith(pfx)) return name.slice(pfx.length);
  }
  // Vector also sometimes pre-namespaces in the wire name itself.
  if (name.startsWith("vector_")) return name.slice("vector_".length);
  return name;
}

function parseTimestampMs(t: unknown): number {
  if (typeof t === "number") return t > 1e12 ? t : t * 1000;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

/**
 * Merge a fresh batch of parsed metrics into the existing snapshot.
 * Pure function — caller writes the result back to D1.
 *
 * Restart detection: if the derived process_start_at jumps forward
 * (new boot), we add the current totals to lifetime_offset and reset
 * per-component prev-sample state. After that, the merge continues
 * with the new sample as if from a fresh process.
 */
export function applyMetricsToSnapshot(
  prev: MetricsSnapshot | null,
  events: ParsedMetric[],
): MetricsSnapshot {
  const snap: MetricsSnapshot = prev ? cloneSnapshot(prev) : emptySnapshot();
  if (events.length === 0) return snap;

  // 1. Derive process_start_at from uptime_seconds (most recent
  //    sample wins). Detect restart up front so the per-component
  //    merge below uses the right baseline.
  const uptimeSample = mostRecent(
    events.filter((e) => e.bareName === UPTIME_GAUGE && e.isGauge),
  );
  let derivedStart: number | null = null;
  if (uptimeSample) {
    derivedStart = uptimeSample.timestampMs - uptimeSample.value * 1000;
  }
  const isRestart =
    derivedStart !== null &&
    snap.processStartAt !== null &&
    derivedStart - snap.processStartAt > 30_000; // tolerate sample skew
  if (isRestart) {
    // Roll current totals into the lifetime accumulator and reset
    // the per-component state so the new process starts from zero.
    snap.lifetimeOffset.received += snap.totals.received;
    snap.lifetimeOffset.sent += snap.totals.sent;
    snap.lifetimeOffset.errors += snap.totals.errors;
    snap.lifetimeOffset.discarded += snap.totals.discarded;
    snap.totals = { received: 0, sent: 0, errors: 0, discarded: 0 };
    for (const id of Object.keys(snap.byComponent)) {
      const c = snap.byComponent[id]!;
      c.received = undefined;
      c.sent = undefined;
      c.errors = undefined;
      c.discarded = undefined;
      c.prev = undefined;
      // Keep kind/type/lastSeen — they describe the component
      // identity, not a particular run.
    }
  }
  if (derivedStart !== null) snap.processStartAt = derivedStart;

  // 2. Pick up Vector build version when offered.
  const build = mostRecent(events.filter((e) => e.buildVersion));
  if (build?.buildVersion) snap.vectorVersion = build.buildVersion;

  // 3. Merge the tracked counters per (component_id, metric).
  //    For each component, the LATEST sample for a given metric is
  //    what we keep. Previous samples get pushed into `prev` so the
  //    UI can derive a rate.
  for (const event of events) {
    if (!event.isCounter) continue;
    const field =
      TRACKED_COUNTERS[event.bareName as keyof typeof TRACKED_COUNTERS];
    if (!field) continue;
    const componentId = event.componentId;
    if (!componentId) continue;
    if (
      !snap.byComponent[componentId] &&
      Object.keys(snap.byComponent).length >= MAX_COMPONENTS
    ) {
      continue; // hit the per-deployment cap; drop quietly
    }
    let comp = snap.byComponent[componentId];
    if (!comp) {
      comp = {
        kind: event.componentKind ?? "unknown",
        type: event.componentType ?? "unknown",
        lastSeen: event.timestampMs,
      };
      snap.byComponent[componentId] = comp;
    }
    if (event.componentKind) comp.kind = event.componentKind;
    if (event.componentType) comp.type = event.componentType;

    const oldValue = comp[field];
    if (oldValue !== undefined && event.value < oldValue) {
      // Counter went down without us detecting a restart — Vector
      // probably rolled over a sub-process. Treat as a partial
      // reset for THIS component: add the old value to lifetime,
      // start fresh.
      snap.lifetimeOffset[field] += oldValue;
      snap.totals[field] -= oldValue;
      comp.prev = undefined;
    }
    if (oldValue !== undefined && event.value >= oldValue) {
      // Stash the previous (value, timestamp) for rate derivation.
      comp.prev = {
        ...(comp.prev ?? {}),
        [field]: oldValue,
        sampleAt: comp.lastSeen,
      };
    }
    // Update the totals incrementally so we don't have to iterate
    // every component each post.
    snap.totals[field] += event.value - (oldValue ?? 0);
    comp[field] = event.value;
    if (event.timestampMs > comp.lastSeen) comp.lastSeen = event.timestampMs;
  }

  snap.updatedAt = Date.now();
  return snap;
}

function mostRecent<T extends { timestampMs: number }>(
  items: T[],
): T | undefined {
  let best: T | undefined;
  for (const it of items) {
    if (!best || it.timestampMs > best.timestampMs) best = it;
  }
  return best;
}

function cloneSnapshot(s: MetricsSnapshot): MetricsSnapshot {
  return {
    byComponent: Object.fromEntries(
      Object.entries(s.byComponent).map(([k, v]) => [k, { ...v, prev: v.prev ? { ...v.prev } : undefined }]),
    ),
    totals: { ...s.totals },
    lifetimeOffset: { ...s.lifetimeOffset },
    processStartAt: s.processStartAt,
    updatedAt: s.updatedAt,
    vectorVersion: s.vectorVersion,
  };
}

/** Convenience: per-component rate (events / minute) since the
 *  prev sample for the field. Returns null if we don't have a prev
 *  sample yet (first observation, or just after a restart). */
export function rateFor(
  comp: ComponentMetrics,
  field: "received" | "sent" | "errors" | "discarded",
): number | null {
  const cur = comp[field];
  const prev = comp.prev?.[field];
  if (cur === undefined || prev === undefined || !comp.prev) return null;
  const dt = comp.lastSeen - comp.prev.sampleAt;
  if (dt <= 0) return null;
  const dv = cur - prev;
  if (dv < 0) return 0; // restart edge case
  return (dv * 60_000) / dt;
}
