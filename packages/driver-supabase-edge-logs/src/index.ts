/**
 * `supabase-edge-logs` source driver.
 *
 * Two log surfaces per Supabase project, each its own optional
 * source on the connection:
 *
 *   - `function_edge_logs` — runtime logs of Edge Function
 *     invocations (console.log/error, execution_time_ms,
 *     function_id). Discovered as one source per function slug.
 *   - `edge_logs` — HTTP gateway access logs for the whole project
 *     (REST, Auth, Storage, function HTTP envelopes; method,
 *     status_code, path). Discovered as one synthetic "Project HTTP
 *     gateway" source.
 *
 * Users pick a mix of function sources and/or the gateway source.
 * The driver emits up to two http_client/exec chains per connection;
 * when both are picked a converging transform fans them into a
 * single output key for downstream tag_conn / monitors.
 *
 * Auth: PAT path emits Vector `http_client` directly. Refreshable
 * credentials emit an `exec` source running `logtura-http-client`
 * for fresh access tokens. Same auth-path branching applies to both
 * surfaces.
 *
 * Response envelope on real Supabase analytics is single-nest
 * `{ result: [...], error: null }` (verified live 2026-05-12 — the
 * docs/older clients suggested double-nest, which is wrong).
 */
import {
  type ConnectionRef,
  type DiscoveredSource,
  type DriverPipeline,
  type ProviderDriver,
  ProviderError,
  type ProviderSelection,
  type SourceRef,
  type VectorComponent,
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

/** Synthetic externalId used for the project-wide HTTP gateway
 *  pseudo-source. Distinct from any function slug. */
const GATEWAY_EXTERNAL_ID = "_gateway_";

/** SourceKind tags on discovered rows. The picker UI doesn't care
 *  about these strings, but generatePipeline routes on them. */
const KIND_FN = "supabase_edge_fn";
const KIND_GW = "supabase_gateway";

/** Function-runtime log SQL — what function_edge_logs.metadata
 *  actually exposes (verified live; HTTP method/status are NOT
 *  here, those live on edge_logs). */
function buildFunctionLogsSql(): string {
  return [
    "SELECT id, function_edge_logs.timestamp AS timestamp, event_message,",
    "  m.function_id AS function_id, m.deployment_id AS deployment_id,",
    "  m.execution_time_ms AS execution_time_ms",
    "FROM function_edge_logs",
    "CROSS JOIN UNNEST(metadata) AS m",
    "WHERE timestamp > timestamp_sub(current_timestamp(), interval 90 second)",
    "ORDER BY timestamp DESC",
    "LIMIT 100",
  ].join(" ");
}

/** Gateway HTTP-access-log SQL. edge_logs.metadata is an array; the
 *  request and response sub-structs are also arrays. Triple CROSS
 *  JOIN UNNEST lifts everything to scalars. Verified live against
 *  the deployed analytics endpoint 2026-05-12. */
function buildGatewayLogsSql(): string {
  return [
    "SELECT id, edge_logs.timestamp AS timestamp, event_message,",
    "  request.method AS method, request.path AS path,",
    "  response.status_code AS status_code",
    "FROM edge_logs",
    "CROSS JOIN UNNEST(metadata) AS m",
    "CROSS JOIN UNNEST(m.request) AS request",
    "CROSS JOIN UNNEST(m.response) AS response",
    "WHERE timestamp > timestamp_sub(current_timestamp(), interval 90 second)",
    "ORDER BY timestamp DESC",
    "LIMIT 100",
  ].join(" ");
}

export const supabaseEdgeLogsDriver: ProviderDriver<SupabaseCredentials> = {
  id: "supabase-edge-logs",
  displayName: "Supabase Edge Functions",
  sourceLabel: "Function",
  capabilities: { selection: "both" },
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
    const fnSources: DiscoveredSource[] = fns.map((f) => ({
      sourceKind: KIND_FN,
      externalId: f.slug,
      displayName: f.name ?? f.slug,
      metadata: {
        function_id: f.id,
        status: f.status ?? null,
        version: f.version ?? null,
      },
    }));
    const gatewaySource: DiscoveredSource = {
      sourceKind: KIND_GW,
      externalId: GATEWAY_EXTERNAL_ID,
      displayName: "Project HTTP gateway",
      metadata: {
        description:
          "All inbound HTTP to the project (REST, Auth, Storage, function invocations). Status-code-driven level inference.",
      },
    };
    return [...fnSources, gatewaySource];
  },

  generatePipeline({
    connection,
    selection,
  }: {
    connection: ConnectionRef;
    selection: ProviderSelection;
  }): DriverPipeline {
    const connKey = safeKey(connection.id);
    const isRefreshable = connection.credentialKind === "refreshable";

    // Partition the picked sources by kind. "all" expands to "every
    // function + the gateway" — the user said monitor everything.
    const allKindsSelected = selection.kind === "all";
    const listSources =
      selection.kind === "list" ? selection.sources : [];
    const fnSources: SourceRef[] = allKindsSelected
      ? []
      : listSources.filter((s) => s.sourceKind === KIND_FN);
    const gwSources: SourceRef[] = allKindsSelected
      ? []
      : listSources.filter((s) => s.sourceKind === KIND_GW);
    const wantFunctions = allKindsSelected || fnSources.length > 0;
    const wantGateway = allKindsSelected || gwSources.length > 0;

    // Heartbeat-only deployments hand us an empty selection. Emit
    // the function channel structurally — its normalize drops every
    // event when the slug map is empty (list mode + zero slugs),
    // so the bundle stays valid and contributes nothing downstream.
    const emitEmptyFunctionsStub =
      !wantFunctions && !wantGateway && selection.kind === "list";
    if (selection.kind === "list") {
      for (const s of fnSources) {
        if (!s.metadata?.function_id) {
          throw new Error(
            `supabase-edge-logs source ${s.externalId} is missing metadata.function_id. Re-run discovery for this connection.`,
          );
        }
      }
    }

    const components: VectorComponent[] = [];
    const manifest: NonNullable<DriverPipeline["manifest"]> = [];
    const innerOutputKeys: string[] = [];

    if (wantFunctions || emitEmptyFunctionsStub) {
      const fnKey = `supabase_edge_${connKey}_fn`;
      const fnNormKey = `${fnKey}_norm`;
      const fnSql = buildFunctionLogsSql();
      const fnUrl = `https://api.supabase.com/v1/projects/\${SUPABASE_PROJECT_REF}/analytics/endpoints/logs.all?sql=${encodeURIComponent(fnSql)}`;
      components.push({
        key: fnKey,
        kind: "source",
        yaml: isRefreshable
          ? execSidecarYaml(`${connKey}_fn`, fnUrl)
          : httpClientYaml(fnUrl),
      });
      components.push({
        key: fnNormKey,
        kind: "transform",
        yaml: functionNormalizeYaml(
          [fnKey],
          fnSources,
          allKindsSelected ? "all" : "list",
        ),
      });
      manifest.push({
        id: fnKey,
        role: "source",
        category: "primary",
        label: allKindsSelected
          ? "Edge Functions (all)"
          : `Edge Functions (${fnSources.length})`,
        links: { connectionId: connection.id },
      });
      manifest.push({
        id: fnNormKey,
        role: "normalize",
        category: "plumbing",
        label: "Normalize · Edge Function runtime",
        links: { connectionId: connection.id },
      });
      const perFunctionKeys: string[] = [];
      if (!allKindsSelected) {
        for (const s of fnSources) {
          const sourceKey = `supabase_edge_${connKey}_${safeKey(s.id)}`;
          perFunctionKeys.push(sourceKey);
          components.push({
            key: sourceKey,
            kind: "transform",
            yaml: sourceScriptFilterYaml(fnNormKey, s.externalId, "function"),
          });
          manifest.push({
            id: sourceKey,
            role: "source",
            category: "primary",
            label: `Edge Function · ${s.displayName}`,
            detail: s.externalId,
            links: {
              connectionId: connection.id,
              sourceId: s.id,
              parentId: fnKey,
            },
          });
        }
      }
      if (perFunctionKeys.length > 0) {
        const fnByFunctionKey = `${fnKey}_by_function`;
        components.push({
          key: fnByFunctionKey,
          kind: "transform",
          yaml: passThroughMergeYaml(perFunctionKeys),
        });
        manifest.push({
          id: fnByFunctionKey,
          role: "normalize",
          category: "plumbing",
          label: "Merge · Edge Functions",
          detail: `${perFunctionKeys.length} function${perFunctionKeys.length === 1 ? "" : "s"}`,
          links: { connectionId: connection.id },
        });
        innerOutputKeys.push(fnByFunctionKey);
      } else {
        innerOutputKeys.push(fnNormKey);
      }
    }

    if (wantGateway) {
      const gwKey = `supabase_edge_${connKey}_gw`;
      const gwNormKey = `${gwKey}_norm`;
      const gwSql = buildGatewayLogsSql();
      const gwUrl = `https://api.supabase.com/v1/projects/\${SUPABASE_PROJECT_REF}/analytics/endpoints/logs.all?sql=${encodeURIComponent(gwSql)}`;
      components.push({
        key: gwKey,
        kind: "source",
        yaml: isRefreshable
          ? execSidecarYaml(`${connKey}_gw`, gwUrl)
          : httpClientYaml(gwUrl),
      });
      components.push({
        key: gwNormKey,
        kind: "transform",
        yaml: gatewayNormalizeYaml([gwKey]),
      });
      innerOutputKeys.push(gwNormKey);
      manifest.push({
        id: gwKey,
        role: "source",
        category: "primary",
        label: "Supabase HTTP gateway",
        links: { connectionId: connection.id },
      });
      manifest.push({
        id: gwNormKey,
        role: "normalize",
        category: "plumbing",
        label: "Normalize · HTTP gateway",
        links: { connectionId: connection.id },
      });
    }

    // outputKey: when only one channel is picked, point downstream
    // directly at that channel's normalize. When both, emit a
    // trivial converging transform so downstream tag_conn only
    // reads one key.
    let outputKey: string;
    if (innerOutputKeys.length === 1) {
      outputKey = innerOutputKeys[0]!;
    } else {
      outputKey = `supabase_edge_${connKey}_norm`;
      components.push({
        key: outputKey,
        kind: "transform",
        yaml: [
          `    type: remap`,
          `    inputs: [${innerOutputKeys.map((k) => `"${k}"`).join(", ")}]`,
          `    source: |-`,
          `      . = .`,
        ].join("\n"),
      });
      manifest.push({
        id: outputKey,
        role: "normalize",
        category: "plumbing",
        label: "Merge · Supabase channels",
        links: { connectionId: connection.id },
      });
    }

    const runtime = sbRuntimeSpec({
      helpUrl: "https://supabase.com/dashboard/account/tokens",
    });
    if (isRefreshable) {
      runtime.envVars = [
        {
          name: "LOGTURA_TAIL_TOKEN",
          description:
            "Connection-scoped JWT the sidecar binary uses to request fresh Supabase access tokens.",
          source: "credential",
          credentialPath: "tailToken",
        },
        {
          name: "LOGTURA_TAIL_TOKEN_URL",
          description:
            "URL the sidecar binary POSTs to for fresh Supabase access tokens.",
          source: "credential",
          credentialPath: "tailTokenUrl",
        },
        ...runtime.envVars.filter((v) => v.name === "SUPABASE_PROJECT_REF"),
      ];
      runtime.dockerfileDeps = [
        {
          directive:
            "COPY --from=ghcr.io/logtura/logtura-http-client:v0.1.2 /logtura-http-client /usr/local/bin/logtura-http-client",
        },
      ];
    }

    return {
      components,
      outputKey,
      envVars: runtime.envVars,
      dockerfileDeps: runtime.dockerfileDeps,
      manifest,
    };
  },
};

/** PAT path: Vector polls Supabase directly via http_client.
 *  `${SUPABASE_PAT}` resolves at startup from the deployment env. */
function httpClientYaml(url: string): string {
  return [
    `    type: http_client`,
    `    endpoint: ${JSON.stringify(url)}`,
    `    method: GET`,
    `    interval_secs: 30`,
    `    headers:`,
    `      authorization: ["Bearer \${SUPABASE_PAT}"]`,
    `    decoding:`,
    `      codec: json`,
  ].join("\n");
}

/** Refreshable path: exec-source sidecar holds the connection-scoped
 *  JWT and exchanges it for a fresh Supabase access token before
 *  each poll. `tag` is a short suffix that makes the temp config
 *  path unique per channel (fn vs gw) so two sidecars on the same
 *  forwarder don't clobber each other. */
function execSidecarYaml(tag: string, endpoint: string): string {
  // Vector applies env-var interpolation to vector.yaml *before* the
  // heredoc runs — so any `$xxx` literal in the embedded TOML gets
  // grabbed by Vector's interpolator and fails ("missing env var
  // name=.access_token"). Escape `$` → `$$` so Vector emits the
  // literal `$` into the file; the binary then parses normal TOML
  // with JSONPath strings.
  const tomlLines = [
    `endpoint = ${JSON.stringify(endpoint)}`,
    `scrape_interval_secs = 30`,
    ``,
    `[auth]`,
    `strategy = "bearer_refresh"`,
    `token_url = "\${LOGTURA_TAIL_TOKEN_URL}"`,
    `token_method = "POST"`,
    `access_token_json_path = "$$.access_token"`,
    `expires_in_json_path = "$$.expires_in"`,
    ``,
    `[auth.token_headers]`,
    `authorization = "Bearer \${LOGTURA_TAIL_TOKEN}"`,
    ``,
    `[rows]`,
    `json_path = "$$.result"`,
  ];
  const cfgPath = `/tmp/logtura-supabase-${tag}.toml`;
  const script = [
    `cat > ${cfgPath} <<'EOF'`,
    ...tomlLines,
    `EOF`,
    `exec logtura-http-client --config ${cfgPath}`,
  ].join("\n");
  return [
    `    type: exec`,
    `    mode: streaming`,
    `    command:`,
    `      - sh`,
    `      - -c`,
    `      - |`,
    ...script.split("\n").map((l) => `        ${l}`),
    // logtura-http-client writes tracing logs to stderr. Vector's
    // exec source decodes stderr through the same JSON pipeline as
    // stdout by default — those plain-text log lines fail to parse
    // and flood Vector's logs with "Failed deserializing frame".
    // Drop stderr from the source's event stream; Fly logs at the
    // machine level still captures it for debug visibility.
    `    include_stderr: false`,
    `    decoding:`,
    `      codec: json`,
    `    framing:`,
    `      method: newline_delimited`,
  ].join("\n");
}

/** function_edge_logs normalize. Maps function_id (UUID) to slug,
 *  drops events for unselected functions in list mode, infers level
 *  from event_message text (no status_code on this table). */
function functionNormalizeYaml(
  inputKeys: string[],
  sources: SourceRef[],
  selectionKind: "list" | "all",
): string {
  const idToSlug: Array<{ fnId: string; slug: string }> = [];
  for (const s of sources) {
    const fnId = String(s.metadata?.function_id ?? "");
    if (fnId) idToSlug.push({ fnId, slug: s.externalId });
  }
  const slugLookup = idToSlug.map(
    ({ fnId, slug }) =>
      `  if fn_id == ${JSON.stringify(fnId)} { script = ${JSON.stringify(slug)} }`,
  );
  const slugMissLine =
    selectionKind === "all"
      ? `  if script == "" { script = fn_id }`
      : `  # script == "" means this event is for an unselected function; drop`;

  const vrl = [
    `records = array(.result) ?? array(.) ?? []`,
    `out = []`,
    `for_each(records) -> |_i, rec| {`,
    `  fn_id = string(rec.function_id) ?? ""`,
    `  script = ""`,
    ...slugLookup,
    slugMissLine,
    `  if script != "" {`,
    `    level = "info"`,
    `    body = string(rec.event_message) ?? ""`,
    `    if match(body, r'(?i)\\b(warn|warning|deprecated)\\b') { level = "warn" }`,
    `    if match(body, r'(?i)\\b(error|exception|traceback|panic|failed)\\b') { level = "error" }`,
    `    err = level == "error"`,
    `    if body == "" { body = "supabase-edge " + script }`,
    `    ts_us = int(rec.timestamp) ?? 0`,
    `    out = push(out, {`,
    `      "script": script,`,
    `      "source_kind": "function",`,
    `      "level": level,`,
    `      "error": err,`,
    `      "message": "[" + script + "] " + body,`,
    `      "timestamp": ts_us / 1000,`,
    `      "execution_time_ms": int(rec.execution_time_ms) ?? 0,`,
    `      "deployment_id": string(rec.deployment_id) ?? "",`,
    `      "id": string(rec.id) ?? "",`,
    `      "function_id": fn_id,`,
    `    })`,
    `  }`,
    `}`,
    `. = out`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}

/** edge_logs gateway normalize. Real HTTP status_code drives level
 *  inference (5xx → error, 4xx → warn). `.script` is set to the
 *  HTTP path's leading segment ("rest", "auth", "storage",
 *  "functions") so monitors can route by surface. */
function gatewayNormalizeYaml(inputKeys: string[]): string {
  const vrl = [
    `records = array(.result) ?? array(.) ?? []`,
    `out = []`,
    `for_each(records) -> |_i, rec| {`,
    `  status = int(rec.status_code) ?? 0`,
    `  method = string(rec.method) ?? ""`,
    `  path = string(rec.path) ?? ""`,
    // Pull the surface ("rest" / "auth" / "storage" / "functions"
    // / "realtime") off the path's first segment for routing.
    `  parts = split(path, "/")`,
    `  surface = ""`,
    `  if length(parts) > 1 { surface = string(parts[1]) ?? "" }`,
    `  if surface == "" { surface = "unknown" }`,
    `  level = "info"`,
    `  if status >= 400 { level = "warn" }`,
    `  if status >= 500 { level = "error" }`,
    `  err = status >= 500`,
    `  body = string(rec.event_message) ?? ""`,
    `  if body == "" { body = method + " " + to_string(status) + " " + path }`,
    `  ts_us = int(rec.timestamp) ?? 0`,
    `  out = push(out, {`,
    `    "script": surface,`,
    `    "source_kind": "gateway",`,
    `    "level": level,`,
    `    "error": err,`,
    `    "message": "[" + surface + "] " + body,`,
    `    "timestamp": ts_us / 1000,`,
    `    "status_code": status,`,
    `    "method": method,`,
    `    "path": path,`,
    `    "id": string(rec.id) ?? "",`,
    `  })`,
    `}`,
    `. = out`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}

function sourceScriptFilterYaml(
  inputKey: string,
  scriptName: string,
  sourceKind: "function" | "gateway",
): string {
  return [
    "    type: filter",
    `    inputs: ["${inputKey}"]`,
    "    condition: |-",
    `      (string(.script) ?? "") == ${JSON.stringify(scriptName)} && (string(.source_kind) ?? "") == ${JSON.stringify(sourceKind)}`,
  ].join("\n");
}

function passThroughMergeYaml(inputKeys: string[]): string {
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    "      . = .",
  ].join("\n");
}
