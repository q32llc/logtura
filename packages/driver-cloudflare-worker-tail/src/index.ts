/**
 * `cloudflare-worker-tail` source driver.
 *
 * One transport: Cloudflare's Workers Tail API via logtura-cf-tail.
 * The tail API is per-script, but the helper multiplexes all selected
 * scripts inside one process and emits `wrangler tail --format json`-
 * shaped events as newline-delimited JSON for Vector's exec source.
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
  cfFetch,
  checkCfCredentialFreshness,
  type CloudflareCredentials,
  cfRuntimeSpec,
  safeKey,
  verifyCfCredentials,
} from "@logtura/cloudflare-shared";

interface CfWorkerScript {
  id: string;
  modified_on?: string;
}

// This package only carries what the renderer and CLI consume:
// id, discovery, codegen, and runtime spec.

export const cloudflareWorkerTailDriver: ProviderDriver<CloudflareCredentials> = {
  id: "cloudflare-worker-tail",
  displayName: "Cloudflare worker tail",
  sourceLabel: "Worker",
  // Cloudflare tail sessions are still script-scoped, but
  // logtura-cf-tail multiplexes the selected list in one process.
  // Callers wanting "all" still expand the selection at picking time
  // because the API doesn't expose one account-wide stream.
  capabilities: { selection: "list" },
  verifyCredentials: verifyCfCredentials,
  checkCredentialFreshness: checkCfCredentialFreshness,

  async discoverSources({ credentials, accountId }): Promise<DiscoveredSource[]> {
    let workers: CfWorkerScript[];
    try {
      workers = await cfFetch<CfWorkerScript[]>(
        `/accounts/${accountId}/workers/scripts`,
        credentials.apiToken,
      );
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new ProviderError(
          `Could not list Worker scripts: ${err.message}. Check the token has Workers Scripts:Read.`,
          err.status,
        );
      }
      throw err;
    }
    return workers.map((w) => ({
      sourceKind: "cf_worker",
      externalId: w.id,
      displayName: w.id,
      metadata: { modified_on: w.modified_on ?? null },
    }));
  },

  generatePipeline({
    connection,
    selection,
  }: {
    connection: ConnectionRef;
    selection: ProviderSelection;
  }): DriverPipeline {
    if (selection.kind === "all") {
      throw new Error(
        "cloudflare-worker-tail does not support \"all\" selection",
      );
    }
    const sources = selection.sources;
    const components: VectorComponent[] = [];
    const manifest: DriverPipeline["manifest"] = [];
    const connKey = safeKey(connection.id);
    const sourceKey = `cf_worker_${connKey}_tail`;
    if (sources.length > 0) {
      components.push({
        key: sourceKey,
        kind: "source",
        yaml: workerExecSourceYaml(connKey, sources),
      });
      manifest.push({
        id: sourceKey,
        role: "source",
        category: "primary",
        label: "Workers tail",
        detail: `${sources.length} worker${sources.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
    }
    const normalizeKey = `cf_worker_${connKey}_norm`;
    const perWorkerKeys: string[] = [];
    if (sources.length > 0) {
      components.push({
        key: normalizeKey,
        kind: "transform",
        yaml: workerNormalizeYaml([sourceKey]),
      });
      manifest.push({
        id: normalizeKey,
        role: "normalize",
        category: "plumbing",
        label: "Normalize · Worker",
        detail: `${sources.length} source${sources.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
      for (const s of sources) {
        const workerKey = `cf_worker_${connKey}_${safeKey(s.id)}`;
        perWorkerKeys.push(workerKey);
        components.push({
          key: workerKey,
          kind: "transform",
          yaml: workerScriptFilterYaml(normalizeKey, s.externalId),
        });
        manifest.push({
          id: workerKey,
          role: "source",
          category: "primary",
          label: `Worker · ${s.displayName}`,
          detail: s.externalId,
          links: {
            connectionId: connection.id,
            sourceId: s.id,
            parentId: sourceKey,
          },
        });
      }
    }
    const outputKey =
      perWorkerKeys.length > 0
        ? `cf_worker_${connKey}_by_worker`
        : normalizeKey;
    if (perWorkerKeys.length > 0) {
      components.push({
        key: outputKey,
        kind: "transform",
        yaml: passThroughMergeYaml(perWorkerKeys),
      });
      manifest.push({
        id: outputKey,
        role: "normalize",
        category: "plumbing",
        label: "Merge · Workers",
        detail: `${perWorkerKeys.length} worker${perWorkerKeys.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
    }
    const runtime = cfRuntimeSpec({
      // Bare token-page URL. The CLI renders this next to the env var;
      // a pre-scoped token URL belongs outside the driver.
      helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
    });
    runtime.dockerfileDeps = [
      {
        directive:
          "COPY --from=ghcr.io/logtura/logtura-cf-tail:v0.1.2 /logtura-cf-tail /usr/local/bin/logtura-cf-tail",
      },
    ];
    return {
      components,
      outputKey,
      envVars: runtime.envVars,
      dockerfileDeps: runtime.dockerfileDeps,
      manifest,
    };
  },
};

function workerExecSourceYaml(connKey: string, sources: SourceRef[]): string {
  const cfgPath = `/tmp/logtura-cf-tail-${connKey}.toml`;
  const tomlLines = [
    `account_id = "\${CLOUDFLARE_ACCOUNT_ID}"`,
    `api_token = "\${CLOUDFLARE_API_TOKEN}"`,
    `scripts = [${sources.map((s) => JSON.stringify(s.externalId)).join(", ")}]`,
  ];
  const script = [
    `cat > ${cfgPath} <<'EOF'`,
    ...tomlLines,
    `EOF`,
    `exec logtura-cf-tail --config ${cfgPath}`,
  ].join("\n");
  return [
    `    type: exec`,
    `    mode: streaming`,
    `    command:`,
    `      - sh`,
    `      - -c`,
    `      - |`,
    ...script.split("\n").map((l) => `        ${l}`),
    // logtura-cf-tail writes diagnostics to stderr.
    // Vector's exec source feeds stderr through the same JSON decoder
    // as stdout by default, which produces "Failed deserializing
    // frame" floods. Disable stderr capture; the machine's stderr is
    // still visible via Fly logs at a higher level.
    `    include_stderr: false`,
    `    decoding:`,
    `      codec: json`,
    `    framing:`,
    `      method: newline_delimited`,
  ].join("\n");
}

/** Flattens a `wrangler tail --format json` event into the uniform
 *  pipeline shape (.message, .level, .error, .script, .timestamp)
 *  plus canonical error fields (.error_reason, .exceptions).
 *  CF tail event shape: outcome, scriptName, exceptions[],
 *  logs[{message[], level}], event, eventTimestamp. */
function workerNormalizeYaml(inputKeys: string[]): string {
  const vrl = [
    `.script = string(.scriptName) ?? "worker"`,
    `.timestamp = .eventTimestamp`,
    `exc_count = length(array(.exceptions) ?? [])`,
    `outcome = string(.outcome) ?? "ok"`,
    // Scan the worker's own console.* calls. CF tail emits each
    // log with its level — "log" | "info" | "warn" | "error" |
    // "debug". An explicit console.error() should flag the event
    // even when the request itself succeeded; console.warn()
    // should bubble to .level=warn.
    `has_error_log = false`,
    `has_warn_log = false`,
    `for_each(array(.logs) ?? []) -> |_, log| {`,
    `  lvl = string(log.level) ?? ""`,
    `  if lvl == "error" { has_error_log = true }`,
    `  if lvl == "warn" { has_warn_log = true }`,
    `}`,
    // Outcome-based classifier: only flag outcomes that mean the
    // WORKER actually failed. Client disconnects ("canceled",
    // "responseStreamDisconnected") and "unknown" stay at .warn.
    `worker_failed = outcome == "exception" || outcome == "exceededCpu" || outcome == "exceededMemory" || outcome == "scriptNotFound" || outcome == "daemonDown"`,
    `client_aborted = outcome == "canceled" || outcome == "responseStreamDisconnected"`,
    `.error = exc_count > 0 || worker_failed || has_error_log`,
    `.level = if .error { "error" } else if has_warn_log || client_aborted || outcome == "unknown" { "warn" } else { "info" }`,
    `if worker_failed {`,
    `  .error_reason = outcome`,
    `} else {`,
    `  del(.error_reason)`,
    `}`,
    `normalized_exceptions = []`,
    `parts = []`,
    `error_parts = []`,
    `warn_parts = []`,
    `for_each(array(.logs) ?? []) -> |_, log| {`,
    `  lvl = string(log.level) ?? ""`,
    `  for_each(array(log.message) ?? []) -> |_, m| {`,
    `    s = if is_string(m) { string!(m) } else { encode_json(m) }`,
    `    parts = push(parts, s)`,
    `    if lvl == "error" { error_parts = push(error_parts, s) }`,
    `    if lvl == "warn" { warn_parts = push(warn_parts, s) }`,
    `  }`,
    `}`,
    `for_each(array(.exceptions) ?? []) -> |_, ex| {`,
    `  name = string(ex.name) ?? "Error"`,
    `  msg = string(ex.message) ?? ""`,
    `  stack = string(ex.stack) ?? ""`,
    `  normalized = { "name": name, "message": msg, "stack": stack }`,
    `  normalized_exceptions = push(normalized_exceptions, normalized)`,
    `  rendered = if stack != "" { name + ": " + msg + "\\n" + stack } else { name + ": " + msg }`,
    `  parts = push(parts, rendered)`,
    `}`,
    `if length(normalized_exceptions) > 0 {`,
    `  .exceptions = normalized_exceptions`,
    `} else {`,
    `  del(.exceptions)`,
    `}`,
    // When the worker actually failed (exceededMemory, exceededCpu,
    // exception with no JS-level exception body, scriptNotFound,
    // daemonDown), prefix the rendered body with outcome=<reason>.
    // Without this, a request that logged anything before CF killed
    // it shows only the surviving info logs in Slack, masking the
    // real cause. Also covers the empty-parts case (CF killed before
    // anything logged) so the body is never bare. Slack returns 400
    // on {"text":""} so the body has to be non-empty.
    `body = if length(parts) == 0 { "outcome=" + outcome } else if worker_failed { "outcome=" + outcome + " | " + join!(parts, " | ") } else if length(error_parts) > 0 { join!(error_parts, " | ") } else if length(warn_parts) > 0 { join!(warn_parts, " | ") } else { join!(parts, " | ") }`,
    // Prefix with [script] so monitors WITHOUT a rollup step still
    // deliver tagged messages to Slack. Without this, a console.log
    // of a structured object lands in Slack as a bare JSON fragment
    // with no source identifier. Rollup-fmt's outer prefix is
    // intentionally separate (it labels the rollup summary, not
    // each sample); the mild redundancy in samples is acceptable.
    `.message = "[" + .script + "] " + body`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}

function workerScriptFilterYaml(inputKey: string, scriptName: string): string {
  return [
    "    type: filter",
    `    inputs: ["${inputKey}"]`,
    "    condition: |-",
    `      (string(.script) ?? "") == ${JSON.stringify(scriptName)}`,
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

export type { SourceRef };
