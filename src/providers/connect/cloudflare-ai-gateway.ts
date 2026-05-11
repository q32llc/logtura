/**
 * Connect-UX adapter for the `cloudflare-ai-gateway` OSS driver.
 *
 * AI Gateway:Read isn't documented as a permissionGroupKeys value
 * so the connect URL is the bare custom-token page — users add
 * AI Gateway:Read by hand on Cloudflare's side. Form/parse logic
 * is the same paste-token shape as the worker-tail flow.
 */
import { ProviderError } from "@logtura/core";
import type { CloudflareCredentials } from "@logtura/cloudflare-shared";
import type { ProviderConnectAdapter } from "./types";

const TOKEN_TEMPLATE_URL = "https://dash.cloudflare.com/profile/api-tokens";

export const cloudflareAiGatewayConnect: ProviderConnectAdapter<CloudflareCredentials> = {
  driverId: "cloudflare-ai-gateway",
  connectFlow: {
    kind: "external_token",
    url: TOKEN_TEMPLATE_URL,
    buttonLabel: "Connect Cloudflare (AI Gateway)",
    buttonDescription:
      "Create a custom token with AI Gateway:Read scoped to your account, then paste it below.",
    pasteFieldName: "api_token",
    manualInstructions:
      "At dash.cloudflare.com/profile/api-tokens → Create Custom Token → add AI Gateway:Read for the account that owns your gateway.",
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
