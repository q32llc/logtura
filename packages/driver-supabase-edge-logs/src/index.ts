/**
 * `supabase-edge-logs` source driver.
 *
 * One transport: HTTP poll against the Management API's analytics
 * endpoint
 *   GET /v1/projects/<ref>/analytics/endpoints/logs.all?sql=<…>
 * via Vector's `http_client` source. This is what the Supabase
 * dashboard's Logs tab uses under the hood — a SQL query against
 * the Logflare-backed `function_edge_logs` table.
 *
 * **One poll per CONNECTION, not per function.** The analytics
 * endpoint has an aggressive rate limit (we got HTTP 429s with 6
 * functions × 30s = 12 polls/min). The driver emits one Vector
 * `http_client` keyed on the connection id; the SQL pulls every
 * edge-function event for the project; the normalize remap routes
 * by function_id, dropping events whose function_id isn't in the
 * selected-source set. Renderer dedupes blocks that share a key
 * so N selected functions emit ONE source block in the YAML.
 *
 * Response shape: `{ result: { result: [<records>], error: null } }`.
 * The driver's normalize remap unwraps the array, fans events out
 * (set `. = array(.result.result)`), and per-record:
 *   - maps `function_id` (UUID) → `script` (human slug) via a
 *     codegen-time dict built from `sources`; events whose
 *     function_id isn't in the dict are dropped
 *   - derives `.level` from `.status_code` (5xx → error, 4xx →
 *     warn, else info)
 *   - converts `.timestamp` from microseconds to milliseconds
 *   - prefixes `.message` with `[<slug>]` so non-rollup monitors
 *     still ship tagged events
 */
import {
  type ConnectionRef,
  type DiscoveredSource,
  type ProviderDriver,
  ProviderError,
  type SourceBlock,
  type SourceRef,
} from "@logtura/core";
import {
  safeKey,
  sbFetch,
  sbRuntimeSpec,
  type SupabaseCredentials,
  verifySupabaseCredentials,
} from "@logtura/supabase-shared";

interface SbEdgeFunction {
  id: string;
  slug: string;
  name?: string;
  status?: string;
  version?: number;
}

/** SQL query template fired against `function_edge_logs`. Pulls
 *  every edge function event for the project; per-function routing
 *  happens downstream in the normalize remap, where we already
 *  have a codegen-time UUID→slug map and can simply drop events
 *  whose function_id isn't in the selected-source set.
 *
 *  Why pull-all-and-filter instead of `WHERE function_id IN (…)`:
 *  the IN clause would still require one source-per-connection (we
 *  can't see all selected sources at `generateSourceBlock` time),
 *  and the bandwidth cost for "pull events for unselected
 *  functions" is trivial — the LIMIT 100 cap is the constraint,
 *  not per-function filtering. Keeping the SQL static also means
 *  the URL is identical for every poll, which is the only way
 *  Vector deduplicates source components by URL+headers.
 *
 *  90-second lookback is 3x the default poll interval — generous
 *  overlap so a late event doesn't slip between polls; downstream
 *  `dedup` (by .id) drops the duplicates a wide window produces. */
function buildLogsSql(): string {
  return [
    "SELECT id, function_edge_logs.timestamp AS timestamp, event_message,",
    "  m.function_id AS function_id, m.deployment_id AS deployment_id,",
    "  m.method AS method, m.status_code AS status_code,",
    "  m.execution_time_ms AS execution_time_ms",
    "FROM function_edge_logs",
    "CROSS JOIN UNNEST(metadata) AS m",
    "WHERE timestamp > timestamp_sub(current_timestamp(), interval 90 second)",
    "ORDER BY timestamp DESC",
    "LIMIT 100",
  ].join(" ");
}

export const supabaseEdgeLogsDriver: ProviderDriver<SupabaseCredentials> = {
  id: "supabase-edge-logs",
  displayName: "Supabase Edge Functions",
  sourceLabel: "Function",
  verifyCredentials: verifySupabaseCredentials,

  async discoverSources({ credentials, accountId }): Promise<DiscoveredSource[]> {
    let fns: SbEdgeFunction[];
    try {
      fns = await sbFetch<SbEdgeFunction[]>(
        `/v1/projects/${accountId}/functions`,
        credentials.pat,
      );
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new ProviderError(
          `Could not list edge functions: ${err.message}. Check the PAT can access project ${accountId}.`,
          err.status,
        );
      }
      throw err;
    }
    return fns.map((f) => ({
      sourceKind: "supabase_edge_fn",
      externalId: f.slug,
      displayName: f.name ?? f.slug,
      // function_id (the UUID) is what edge-function log records
      // carry. We stash it here so generateNormalize can emit a
      // function_id → slug map without re-hitting the API.
      metadata: {
        function_id: f.id,
        status: f.status ?? null,
        version: f.version ?? null,
      },
    }));
  },

  generateSourceBlock({ source, connection }): SourceBlock {
    // Key on connection (not source). Every selected function in the
    // same connection returns this identical block; the renderer
    // dedupes by key and emits one Vector source per connection.
    const key = `supabase_edge_${safeKey(connection.id)}`;
    if (!source.metadata?.function_id) {
      throw new Error(
        `supabase-edge-logs source ${source.externalId} is missing metadata.function_id — re-run discovery for this connection.`,
      );
    }
    const sql = buildLogsSql();
    const url =
      `https://api.supabase.com/v1/projects/\${SUPABASE_PROJECT_REF}/analytics/endpoints/logs.all?sql=${encodeURIComponent(sql)}`;
    const yaml = [
      `    type: http_client`,
      `    endpoint: ${JSON.stringify(url)}`,
      `    method: GET`,
      // 30s poll matches the SQL's 90s lookback (3x overlap). One
      // poll per connection regardless of selected-source count, so
      // the analytics endpoint's rate limit stays unstressed.
      `    interval_secs: 30`,
      `    headers:`,
      // http_client headers want map<string, array<string>>.
      `      authorization: ["Bearer \${SUPABASE_PAT}"]`,
      `    decoding:`,
      `      codec: json`,
    ].join("\n");
    return { key, yaml };
  },

  generateNormalize({ inputKeys, sources }) {
    if (inputKeys.length === 0) return null;
    return {
      key: "supabase_edge_norm",
      yaml: edgeNormalizeYaml(inputKeys, sources),
    };
  },

  runtimeSpec(_connection: ConnectionRef) {
    return sbRuntimeSpec({
      helpUrl: "https://supabase.com/dashboard/account/tokens",
    });
  },
};

/** Build the normalize remap. Logflare's response is wrapped
 *  (`{ result: { result: [...] } }`), so we extract the array,
 *  process each record in VRL (mapping function_id → slug from
 *  the codegen-time dict, dropping records whose function_id isn't
 *  in the selected set), and set `. = <processed array>` so Vector
 *  fans the batch out into one event per record. */
function edgeNormalizeYaml(
  inputKeys: string[],
  sources: SourceRef[],
): string {
  // Map of function_id (UUID) → slug. Each source's metadata
  // carries the function_id we recorded at discovery time. Events
  // whose function_id isn't in this map represent functions the
  // user didn't select; the remap drops them.
  const idToSlug: Array<{ fnId: string; slug: string }> = [];
  for (const s of sources) {
    const fnId = String(s.metadata?.function_id ?? "");
    if (fnId) idToSlug.push({ fnId, slug: s.externalId });
  }

  const slugLookup = idToSlug
    .map(
      ({ fnId, slug }) =>
        `    if fn_id == ${JSON.stringify(fnId)} { script = ${JSON.stringify(slug)} }`,
    )
    .join("\n");

  const vrl = [
    // Wrapped shape: { result: { result: [...] } }. The outer
    // `result` is the Management API envelope; the inner `result`
    // is the Logflare query result. Defaults to [] if either layer
    // is missing — keeps a transient API hiccup from failing the
    // whole transform.
    `records = array(.result.result) ?? []`,
    `out = []`,
    `for_each(records) -> |_i, rec| {`,
    `  fn_id = string(rec.function_id) ?? ""`,
    `  script = ""`,
    ...slugLookup.split("\n"),
    // If function_id wasn't in our slug map, the user didn't select
    // this function for collection. Drop the event by skipping the
    // push. (Continue keeps for_each iterating.)
    `  if script == "" {`,
    `    log("supabase-edge: dropping unselected function_id=" + fn_id, level: "debug")`,
    `  } else {`,
    `    status = int(rec.status_code) ?? 200`,
    // Status-code based level — Supabase Edge logs don't carry a
    // semantic level on the invocation summary, so the HTTP
    // response is the strongest signal we have.
    `    level = "info"`,
    `    if status >= 400 { level = "warn" }`,
    `    if status >= 500 { level = "error" }`,
    `    err = status >= 500`,
    `    body = string(rec.event_message) ?? ""`,
    `    if body == "" { body = "supabase-edge status=" + to_string(status) }`,
    // Microsecond → millisecond conversion. Vector accepts integer
    // epoch in either; downstream sinks formatting timestamps want
    // a consistent unit. Other drivers leave .timestamp as-is from
    // upstream; we normalize here because the upstream is unusual
    // (microseconds), and a 1000x-off timestamp would confuse any
    // human looking at the Slack body.
    `    ts_us = int(rec.timestamp) ?? 0`,
    `    out = push(out, {`,
    `      "script": script,`,
    `      "level": level,`,
    `      "error": err,`,
    `      "message": "[" + script + "] " + body,`,
    `      "timestamp": ts_us / 1000,`,
    `      "status_code": status,`,
    `      "method": string(rec.method) ?? "",`,
    `      "execution_time_ms": int(rec.execution_time_ms) ?? 0,`,
    `      "id": string(rec.id) ?? "",`,
    `      "function_id": fn_id,`,
    `    })`,
    `  }`,
    `}`,
    // Setting `.` to an array fans out — Vector emits one event
    // per element. The downstream tag_conn + monitors then see
    // properly per-event normalized records.
    `. = out`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}
