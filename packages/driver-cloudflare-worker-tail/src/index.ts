/**
 * `cloudflare-worker-tail` source driver.
 *
 * One transport: `wrangler tail <script> --format json` over an
 * `exec` source. This is the actual mechanism — naming it after
 * the transport (not "Cloudflare") makes it obvious what we do
 * and doesn't overclaim other Cloudflare surfaces (Pages, R2,
 * Analytics Engine, …) we don't yet ship.
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
  cfFetch,
  checkCfCredentialFreshness,
  type CloudflareCredentials,
  cfRuntimeSpec,
  safeKey,
  shellQuoteCfWorkerName,
  verifyCfCredentials,
} from "@logtura/cloudflare-shared";

interface CfWorkerScript {
  id: string;
  modified_on?: string;
}

// Token-page URL with permissionGroupKeys pre-checked, the OAuth
// button labels, and the FormData parser all live in the SaaS-side
// connect adapter (src/providers/connect/cloudflare-worker-tail.ts).
// This package only carries what the renderer + a self-hoster CLI
// would consume: id, discovery, codegen, runtime spec.

export const cloudflareWorkerTailDriver: ProviderDriver<CloudflareCredentials> = {
  id: "cloudflare-worker-tail",
  displayName: "Cloudflare worker tail",
  sourceLabel: "Worker",
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

  generateSourceBlock({ source }): SourceBlock {
    const key = `cf_worker_${safeKey(source.externalId)}`;
    const yaml = [
      `    type: exec`,
      // wrangler picks up CLOUDFLARE_ACCOUNT_ID from env;
      // `--account-id` is rejected by recent versions.
      //
      // wrangler tail --format json emits PRETTY-printed multi-line
      // JSON. Vector's exec + codec:json + default newline_delimited
      // framing tries one line at a time → flood of parse errors.
      // jq -c --unbuffered collapses each value to a single line.
      `    command: ["sh", "-c", "wrangler tail ${shellQuoteCfWorkerName(source.externalId)} --format json | jq -c --unbuffered ."]`,
      `    mode: streaming`,
      `    decoding:`,
      `      codec: json`,
    ].join("\n");
    return { key, yaml };
  },

  generateNormalize({ inputKeys }) {
    if (inputKeys.length === 0) return null;
    return { key: "cf_worker_norm", yaml: workerNormalizeYaml(inputKeys) };
  },

  runtimeSpec(_connection: ConnectionRef) {
    return cfRuntimeSpec({
      // Bare token-page URL; the connect-time pre-checked scopes URL
      // lives in the host's connect adapter. helpUrl is rendered next
      // to the env var on a deploy's "missing creds" view, where we
      // can't assume the user wants the worker-tail scope set.
      helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
      extraDockerInstall:
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y --no-install-recommends nodejs && npm install -g wrangler@latest",
    });
  },
};

/** Flattens a `wrangler tail --format json` event into the uniform
 *  pipeline shape (.message, .level, .error, .script, .timestamp).
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
    `parts = []`,
    `for_each(array(.logs) ?? []) -> |_, log| {`,
    `  for_each(array(log.message) ?? []) -> |_, m| {`,
    `    s = if is_string(m) { string!(m) } else { encode_json(m) }`,
    `    parts = push(parts, s)`,
    `  }`,
    `}`,
    `for_each(array(.exceptions) ?? []) -> |_, ex| {`,
    `  name = string(ex.name) ?? "Error"`,
    `  msg = string(ex.message) ?? ""`,
    `  parts = push(parts, name + ": " + msg)`,
    `}`,
    // Some CF events trip .error via outcome alone (canceled,
    // exceededCpu, scriptNotFound) without logs/exceptions —
    // parts ends up empty. Synthesize a body so .message is never
    // bare. Slack returns 400 on {"text":""} so we also need it
    // non-empty even after the prefix.
    `body = if length(parts) == 0 { "outcome=" + outcome } else { join!(parts, " | ") }`,
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

export type { SourceRef };
