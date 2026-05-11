/**
 * Connect-UX adapter for the `cloudflare-ai-gateway` OSS driver.
 *
 * Cloudflare's permissionGroupKeys URL params accept `ai_gateway`
 * with `type: read` — same shape as `workers_scripts` for the
 * worker-tail adapter. So the connect URL deep-links into CF's
 * custom-token page with AI Gateway:Read pre-checked; one click +
 * paste, same as the worker-tail flow.
 */
import { ProviderError } from "@logtura/core";
import type { CloudflareCredentials } from "@logtura/cloudflare-shared";
import type { ProviderConnectAdapter } from "./types";

const PERMISSION_GROUPS = [{ key: "ai_gateway", type: "read" }];

const TOKEN_TEMPLATE_URL = (() => {
  const base = "https://dash.cloudflare.com/profile/api-tokens";
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(PERMISSION_GROUPS),
    accountId: "*",
    zoneId: "all",
    name: "logtura-ai-gateway",
  });
  return `${base}?${params.toString()}`;
})();

export const cloudflareAiGatewayConnect: ProviderConnectAdapter<CloudflareCredentials> = {
  driverId: "cloudflare-ai-gateway",
  connectFlow: {
    kind: "external_token",
    url: TOKEN_TEMPLATE_URL,
    buttonLabel: "Connect Cloudflare (AI Gateway)",
    buttonDescription:
      "Opens Cloudflare with AI Gateway:Read pre-selected. Click Continue → Create Token and paste it below.",
    pasteFieldName: "api_token",
    manualInstructions:
      "Or create one manually at dash.cloudflare.com/profile/api-tokens with AI Gateway:Read on the account that owns your gateway.",
  },
  formFields: [
    {
      name: "api_token",
      label: "Paste the token Cloudflare gave you",
      type: "password",
      placeholder: "cfat_...",
      description:
        "After clicking Continue → Create Token in Cloudflare, copy the token and paste it here.",
      required: true,
    },
    {
      name: "account_id",
      label: "Account ID",
      type: "text",
      placeholder: "auto-detect from token if blank",
      description:
        "Leave blank to auto-detect the first account the token can access.",
      required: false,
    },
  ],
  parseFormData(form) {
    const apiToken = String(form.get("api_token") ?? "").trim();
    const accountId = String(form.get("account_id") ?? "").trim();
    if (!apiToken) throw new ProviderError("Missing api_token", 400);
    return {
      credentials: { apiToken },
      explicitAccountId: accountId || null,
    };
  },
};
