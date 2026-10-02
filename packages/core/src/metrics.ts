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
type MetricField = "received" | "sent" | "errors" | "discarded";

export interface ComponentMetrics {
  kind: ComponentKind | "unknown";
  /** Vector component type, e.g. "exec", "filter", "http". */
  type: string;
  /** Latest absolute counter values, since current process start. */
  received?: number;
  sent?: number;
  errors?: number;
  discarded?: number;
  /** Latest sample timestamp per counter field. Vector sends several
   *  counters for the same component in one batch; a single
   *  component-level lastSeen cannot safely back every rate. */
  sampleAtByField?: Partial<Record<MetricField, number>>;
  /** Per-error_type breakdown of the errors counter. Vector emits
   *  `component_errors_total` with an `error_type` label
   *  (request_failed, encoding_failed, event_send_failed, etc.).
   *  Keeping the split here lets the UI say "0.2/min request_failed"
   *  instead of an opaque "0.2/min errors" — without it, diagnosing
   *  a sink error requires exec'ing into the running container and
   *  reading prometheus directly. Bounded by Vector's enumeration
   *  of error types (~10), times components that actually error
   *  (a few). Small. */
  errorsByType?: Record<string, number>;
  errorsAtByType?: Record<string, number>;
  /** Previous sample, kept so we can derive per-interval rates
   *  without a time series. Overwritten on each post. */
  prev?: {
    received?: number;
    sent?: number;
    errors?: number;
    discarded?: number;
    sampleAt: number;
    sampleAtByField?: Partial<Record<MetricField, number>>;
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
  uptimeSampleAt?: number;
  buildSampleAt?: number;
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
  counter?: { value?: unknown };
  gauge?: { value?: unknown };
}

export interface ParsedMetric {
  bareName: string;
  componentId?: string;
  componentKind?: ComponentKind;
  componentType?: string;
  /** error_type label, when the metric carries one
   *  (component_errors_total does). */
  errorType?: string;
  buildVersion?: string;
  timestampMs: number;
  value: number;
  isCounter: boolean;
  isGauge: boolean;
}

export function emptySnapshot(): MetricsSnapshot {
  return {
    byComponent: Object.create(null) as Record<string, ComponentMetrics>,
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
export function parseMetricsBody(text: string, options: {strict?: boolean} = {}): ParsedMetric[] {
  if (!text) return [];
  const trimmed = text.trim();
  let raws: unknown[];
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); }
    catch { parsed = trimmed.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)); }
    raws = Array.isArray(parsed) ? parsed : [parsed];
  } catch { if(options.strict)throw new Error("Invalid metrics JSON or NDJSON");return []; }

  const out: ParsedMetric[] = [];
  for (const item of raws) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as RawMetricEvent;
    const name = stripNamespace(raw.name, raw.namespace);
    if (!name) continue;
    const tags = raw.tags && typeof raw.tags === "object" && !Array.isArray(raw.tags) ? raw.tags : {};
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
    const errorType =
      typeof tags.error_type === "string" ? tags.error_type : undefined;
    const timestampMs = parseTimestampMs(raw.timestamp);
    if ((raw.counter !== undefined && (!raw.counter || typeof raw.counter !== "object" || Array.isArray(raw.counter) || raw.counter.value === undefined)) || (raw.gauge !== undefined && (!raw.gauge || typeof raw.gauge !== "object" || Array.isArray(raw.gauge) || raw.gauge.value === undefined))) continue;
    const isCounter = raw.counter !== undefined;
    const isGauge = raw.gauge !== undefined;
    if (isCounter && isGauge) continue;
    const rawValue = isCounter ? raw.counter!.value : isGauge ? raw.gauge!.value : 0;
    if ((typeof rawValue !== "number" && typeof rawValue !== "string") || (typeof rawValue === "string" && !rawValue.trim())) continue;
    const value = Number(rawValue);
    const buildVersion =
      name === BUILD_INFO && typeof tags.version === "string"
        ? tags.version
        : undefined;
    if (!Number.isFinite(value) || value < 0) continue;
    out.push({
      bareName: name,
      componentId,
      componentKind,
      componentType,
      errorType,
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
  if (typeof t === "number" && Number.isFinite(t) && t >= 0) return t > 1e12 ? t : t * 1000;
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
  // Legacy snapshots lacked per-field stamps. Capture their last observation
  // before this batch updates another field's component-level lastSeen.
  for (const component of Object.values(snap.byComponent)) {
    for (const field of Object.values(TRACKED_COUNTERS)) if(component[field] !== undefined && component.sampleAtByField?.[field] === undefined) stampField(component, field, component.lastSeen);
  }

  // 1. Derive process_start_at from uptime_seconds (most recent
  //    sample wins). Detect restart up front so the per-component
  //    merge below uses the right baseline.
  const uptimeSample = mostRecent(
    events.filter((e) => e.bareName === UPTIME_GAUGE && e.isGauge),
  );
  let derivedStart: number | null = null;
  if (uptimeSample && (snap.uptimeSampleAt === undefined || uptimeSample.timestampMs > snap.uptimeSampleAt)) {
    snap.uptimeSampleAt = uptimeSample.timestampMs;
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
      c.errorsByType = undefined;
      c.errorsAtByType = undefined;
      c.prev = undefined;
      c.sampleAtByField = undefined;
      // Keep kind/type/lastSeen — they describe the component
      // identity, not a particular run.
    }
  }
  // Keep the boot identity stable within tolerated sample skew. Otherwise the
  // service would treat millisecond uptime jitter as an urgent checkpoint.
  if (derivedStart !== null && (snap.processStartAt === null || isRestart)) snap.processStartAt = derivedStart;

  // 2. Pick up Vector build version when offered.
  const build = mostRecent(events.filter((e) => e.buildVersion));
  if (build?.buildVersion && (snap.buildSampleAt === undefined || build.timestampMs > snap.buildSampleAt)) {snap.vectorVersion = build.buildVersion;snap.buildSampleAt = build.timestampMs;}

  // 3. Merge the tracked counters per (component_id, metric).
  //    For each component, the LATEST sample for a given metric is
  //    what we keep. Previous samples get pushed into `prev` so the
  //    UI can derive a rate.
  //
  //    `errors` is special: Vector emits ONE counter per
  //    (component_id, error_type) pair. We track each error_type
  //    in errorsByType, then derive comp.errors as the sum so the
  //    component-level total is correct AND the type breakdown
  //    survives. Other metrics (received/sent/discarded) collapse
  //    to a single counter per component.
  for (const event of events) {
    if (!event.isCounter || !Number.isFinite(event.value) || event.value < 0 || !Number.isFinite(event.timestampMs)) continue;
    const field = Object.hasOwn(TRACKED_COUNTERS, event.bareName) ?
      TRACKED_COUNTERS[event.bareName as keyof typeof TRACKED_COUNTERS] : undefined;
    if (!field) continue;
    const componentId = event.componentId;
    if (!componentId) continue;
    if (
      !Object.hasOwn(snap.byComponent, componentId) &&
      Object.keys(snap.byComponent).length >= MAX_COMPONENTS
    ) {
      continue; // hit the per-deployment cap; drop quietly
    }
    let comp = Object.hasOwn(snap.byComponent, componentId) ? snap.byComponent[componentId] : undefined;
    if (!comp) {
      comp = {
        kind: event.componentKind ?? "unknown",
        type: event.componentType ?? "unknown",
        lastSeen: event.timestampMs,
      };
      Object.defineProperty(snap.byComponent, componentId, {value: comp, writable: true, enumerable: true, configurable: true});
    }
    const priorTimestamp = comp.sampleAtByField?.[field];
    if ((snap.processStartAt !== null && event.timestampMs < snap.processStartAt) || (field !== "errors" && priorTimestamp !== undefined && event.timestampMs <= priorTimestamp)) continue;

    if (field === "errors") {
      if (!comp.errorsByType) comp.errorsByType = Object.create(null) as Record<string, number>;
      const errType = event.errorType ?? "other";
      const oldError = Object.hasOwn(comp.errorsByType, errType) ? comp.errorsByType[errType] : undefined;
      if (oldError === undefined && Object.keys(comp.errorsByType).length >= 32) continue;
      const errorAt = comp.errorsAtByType?.[errType] ?? (oldError === undefined ? undefined : priorTimestamp);
      if (errorAt !== undefined && event.timestampMs <= errorAt) continue;
      if (event.componentKind) comp.kind = event.componentKind;
      if (event.componentType) comp.type = event.componentType;
      if (!comp.errorsAtByType) comp.errorsAtByType = Object.create(null) as Record<string, number>;
      Object.defineProperty(comp.errorsAtByType, errType, {value: event.timestampMs, writable: true, enumerable: true, configurable: true});
      const prevSum = comp.errors ?? 0;
      const reset = oldError !== undefined && event.value < oldError;
      if (reset) {snap.lifetimeOffset.errors += oldError;if(comp.prev)delete comp.prev.errors;}
      Object.defineProperty(comp.errorsByType, errType, {value: event.value, writable: true, enumerable: true, configurable: true});
      const newSum = Object.values(comp.errorsByType).reduce(
        (a, b) => a + b,
        0,
      );
      // Stash prev for rate calc, when we had a prior sample.
      if (!reset && prevSum > 0 && newSum >= prevSum && priorTimestamp !== event.timestampMs) {
        stashPrev(comp, "errors", prevSum);
      }
      snap.totals.errors += newSum - prevSum;
      comp.errors = newSum;
      stampField(comp, "errors", Math.max(event.timestampMs, priorTimestamp ?? event.timestampMs));
      if (event.timestampMs > comp.lastSeen) comp.lastSeen = event.timestampMs;
      continue;
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
      if (comp.prev) {delete comp.prev[field];if(comp.prev.sampleAtByField)delete comp.prev.sampleAtByField[field];}
    }
    if (oldValue !== undefined && event.value >= oldValue) {
      // Stash the previous (value, timestamp) for rate derivation.
      stashPrev(comp, field, oldValue);
    }
    // Update the totals incrementally so we don't have to iterate
    // every component each post.
    snap.totals[field] += event.value - (oldValue ?? 0);
    comp[field] = event.value;
    stampField(comp, field, event.timestampMs);
    if (event.timestampMs > comp.lastSeen) comp.lastSeen = event.timestampMs;
  }

  snap.updatedAt = Date.now();
  return snap;
}

function stashPrev(
  comp: ComponentMetrics,
  field: MetricField,
  value: number,
) {
  const sampleAt = comp.sampleAtByField?.[field] ?? comp.lastSeen;
  comp.prev = {
    ...(comp.prev ?? {}),
    [field]: value,
    sampleAt,
    sampleAtByField: {
      ...(comp.prev?.sampleAtByField ?? {}),
      [field]: sampleAt,
    },
  };
}

function stampField(
  comp: ComponentMetrics,
  field: MetricField,
  timestampMs: number,
) {
  comp.sampleAtByField = {
    ...(comp.sampleAtByField ?? {}),
    [field]: timestampMs,
  };
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
      Object.entries(s.byComponent).map(([k, v]) => [
        k,
        {
          ...v,
          sampleAtByField: v.sampleAtByField
            ? { ...v.sampleAtByField }
            : undefined,
          prev: v.prev
            ? {
                ...v.prev,
                sampleAtByField: v.prev.sampleAtByField
                  ? { ...v.prev.sampleAtByField }
                  : undefined,
              }
            : undefined,
          errorsByType: v.errorsByType ? { ...v.errorsByType } : undefined,
          errorsAtByType: v.errorsAtByType ? { ...v.errorsAtByType } : undefined,
        },
      ]),
    ),
    totals: { ...s.totals },
    lifetimeOffset: { ...s.lifetimeOffset },
    processStartAt: s.processStartAt,
    uptimeSampleAt: s.uptimeSampleAt,
    buildSampleAt: s.buildSampleAt,
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
  const prevSampleAt = comp.prev.sampleAtByField?.[field] ?? comp.prev.sampleAt;
  const curSampleAt = comp.sampleAtByField?.[field] ?? comp.lastSeen;
  const dt = curSampleAt - prevSampleAt;
  if (dt <= 0) return null;
  const dv = cur - prev;
  if (dv < 0) return 0; // restart edge case
  return (dv * 60_000) / dt;
}
