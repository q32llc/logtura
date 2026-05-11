/**
 * Connect-UX adapter for the `cloudflare-worker-tail` OSS driver.
 *
 * Carries the things only the SaaS UI cares about: which paste
 * field the OAuth-flavored CF token page sends back into, the
 * pre-checked permission-group URL template, the human button
 * copy. The driver itself in @logtura/driver-cloudflare-worker-tail
 * is unaware any of this exists.
 */
import { ProviderError } from "@logtura/core";
import type {
  CloudflareCredentials,
} from "@logtura/cloudflare-shared";
import type { ProviderConnectAdapter } from "./types";

const PERMISSION_GROUPS = [
  { key: "workers_scripts", type: "read" },
  { key: "workers_tail", type: "read" },
];

/** Cloudflare's token page supports pre-checking permission groups
 *  by URL parameter — we URL-encode the array so users land on the
 *  dashboard with the right scopes already selected, one click from
 *  "Continue → Create Token". Pure URL string assembly; lives
 *  alongside the SaaS UI because that's the only consumer. */
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

export const cloudflareWorkerTailConnect: ProviderConnectAdapter<CloudflareCredentials> = {
  driverId: "cloudflare-worker-tail",
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
