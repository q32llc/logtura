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
  cfFetch,
  CF_FORM_FIELDS,
  checkCfCredentialFreshness,
  type CloudflareCredentials,
  cfRuntimeSpec,
  parseCfFormData,
  safeKey,
  shellQuoteCfWorkerName,
  verifyCfCredentials,
} from "./cloudflare-shared";
import {
  type ConnectionRef,
  type DiscoveredSource,
  type ProviderDriver,
  ProviderError,
  type SourceBlock,
  type SourceRef,
} from "./types";

interface CfWorkerScript {
  id: string;
  modified_on?: string;
}

const PERMISSION_GROUPS = [
  { key: "workers_scripts", type: "read" },
  { key: "workers_tail", type: "read" },
];

const TOKEN_TEMPLATE_URL = (() => {
  const base = "https://dash.cloudflare.com/profile/api-tokens";
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(PERMISSION_GROUPS),
    accountId: "*",
    zoneId: "all",
    name: "logtura-worker-tail",
  });
  return `${base}?${params.toString()}`;
})();

export const cloudflareWorkerTailDriver: ProviderDriver<CloudflareCredentials> = {
  id: "cloudflare-worker-tail",
  displayName: "Cloudflare worker tail",
  sourceLabel: "Worker",
  connectFlow: {
    kind: "external_token",
    url: TOKEN_TEMPLATE_URL,
    buttonLabel: "Connect Cloudflare (worker tail)",
    buttonDescription:
      "Opens Cloudflare with Workers Scripts:Read + Workers Tail:Read pre-selected. Click Continue → Create Token and paste it below.",
    pasteFieldName: "api_token",
    manualInstructions:
      "Or create one manually at dash.cloudflare.com/profile/api-tokens with Workers Scripts:Read and Workers Tail:Read.",
  },
  formFields: CF_FORM_FIELDS,
  parseFormData: parseCfFormData,
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
      helpUrl: TOKEN_TEMPLATE_URL,
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
    `.error = exc_count > 0 || outcome != "ok"`,
    `.level = if .error { "error" } else { "info" }`,
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
    // parts ends up empty. An empty .message then trips Slack
    // (400 Bad Request on {"text":""}). Synthesize a fallback.
    `if length(parts) == 0 {`,
    `  parts = push(parts, "[" + .script + "] outcome=" + outcome)`,
    `}`,
    `.message = join!(parts, " | ")`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}

export type { SourceRef };
