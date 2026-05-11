/**
 * `cloudflare-ai-gateway` source driver.
 *
 * One transport: HTTP poll against
 *   GET /client/v4/accounts/<id>/ai-gateway/gateways/<gw>/logs
 * via Vector's `http_client` source. Distinct enough from worker
 * tail to be its own driver — different event shape, different
 * auth scope ("AI Gateway:Read"), different latency profile
 * (polling rather than streaming).
 */
import {
  cfFetch,
  checkCfCredentialFreshness,
  type CloudflareCredentials,
  cfRuntimeSpec,
  safeKey,
  verifyCfCredentials,
} from "@logtura/cloudflare-shared";
import {
  type ConnectionRef,
  type DiscoveredSource,
  type ProviderDriver,
  ProviderError,
  type SourceBlock,
} from "@logtura/core";

interface CfAiGateway {
  id: string;
  collect_logs?: boolean;
}

export const cloudflareAiGatewayDriver: ProviderDriver<CloudflareCredentials> = {
  id: "cloudflare-ai-gateway",
  displayName: "Cloudflare AI Gateway",
  sourceLabel: "AI Gateway",
  verifyCredentials: verifyCfCredentials,
  checkCredentialFreshness: checkCfCredentialFreshness,

  async discoverSources({ credentials, accountId }): Promise<DiscoveredSource[]> {
    let gateways: CfAiGateway[];
    try {
      gateways = await cfFetch<CfAiGateway[]>(
        `/accounts/${accountId}/ai-gateway/gateways`,
        credentials.apiToken,
      );
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new ProviderError(
          `Could not list AI Gateways: ${err.message}. Check the token has AI Gateway:Read.`,
          err.status,
        );
      }
      throw err;
    }
    return gateways.map((g) => ({
      sourceKind: "cf_ai_gateway",
      externalId: g.id,
      displayName: g.id,
      metadata: { collect_logs: g.collect_logs ?? null },
    }));
  },

  generateSourceBlock({ source }): SourceBlock {
    const key = `cf_ai_gateway_${safeKey(source.externalId)}`;
    const yaml = [
      `    type: http_client`,
      `    endpoint: "https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways/${source.externalId}/logs"`,
      `    method: GET`,
      `    interval_secs: 30`,
      `    headers:`,
      // http_client headers want map<string, array<string>>.
      `      authorization: ["Bearer \${CLOUDFLARE_API_TOKEN}"]`,
      `    decoding:`,
      `      codec: json`,
    ].join("\n");
    return { key, yaml };
  },

  generateNormalize({ inputKeys }) {
    if (inputKeys.length === 0) return null;
    return {
      key: "cf_ai_gateway_norm",
      yaml: aiGatewayNormalizeYaml(inputKeys),
    };
  },

  runtimeSpec(_connection: ConnectionRef) {
    // No extra Docker install for AI Gateway — http_client is in
    // Vector itself.
    return cfRuntimeSpec({
      helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
    });
  },
};

/** AI Gateway log entry shape: {id, success, status_code,
 *  request_*, model, provider, response_status_code, ...}. Map to
 *  the uniform pipeline shape. */
function aiGatewayNormalizeYaml(inputKeys: string[]): string {
  const vrl = [
    `.script = string(.provider) ?? "ai-gateway"`,
    `.timestamp = .created_at`,
    `success = bool(.success) ?? true`,
    `status = int(.status_code) ?? 200`,
    `.error = !success || status >= 500`,
    `.level = if .error { "error" } else { "info" }`,
    `model = string(.model) ?? "?"`,
    // Prefix with [.script] (the provider name in our scheme) so
    // monitors without a rollup step still deliver tagged Slack
    // messages — bare "ai_gateway openai status=200" lines have
    // no anchor for the user.
    `.message = "[" + .script + "] ai_gateway " + model + " status=" + to_string(status)`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}
