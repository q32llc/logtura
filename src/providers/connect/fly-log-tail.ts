/**
 * Connect-UX adapter for the `fly-log-tail` OSS driver.
 *
 * Fly doesn't have permissionGroupKeys-style URL params, so the
 * paste URL is the bare dashboard page. The bootstrap-mint path
 * (mint a read-only token from an existing managed-deploy
 * connection via the Fly macaroon attenuation in
 * src/deploy-targets/fly-macaroon.ts) is wired by separate SaaS
 * UI elements, not by this adapter.
 */
import { ProviderError } from "@logtura/core";
import type { FlyCredentials } from "@logtura/driver-fly-log-tail";
import type { ProviderConnectAdapter } from "./types";

export const flyLogTailConnect: ProviderConnectAdapter<FlyCredentials> = {
  driverId: "fly-log-tail",
  connectFlow: {
    kind: "external_token",
    url: "https://fly.io/user/personal_access_tokens",
    buttonLabel: "Open Fly tokens page",
    buttonDescription:
      "Run `fly tokens create readonly -o <your-org>` and paste the resulting `FlyV1 …` token below. (Easier: if you already linked Fly for a managed deploy, use the bootstrap option above — we'll mint a read-only token for you.)",
    pasteFieldName: "api_token",
    manualInstructions:
      "Tokens are also visible at fly.io/user/personal_access_tokens — but the dashboard only mints full-account tokens. For source connections prefer the CLI's `tokens create readonly` so the credential can't write to your account.",
  },
  formFields: [
    {
      name: "api_token",
      label: "Fly API token (FlyV1 …)",
      type: "password",
      placeholder: "FlyV1 fm2_…,fm2_…",
      description:
        "Used to discover apps + tail their logs. Read-only is recommended; `fly tokens create readonly -o <org>` produces one. Revokable from the Fly dashboard.",
      required: true,
    },
    {
      name: "org_slug",
      label: "Fly organization (optional)",
      type: "text",
      placeholder: "personal",
      description:
        "Defaults to your personal org if blank. Used to scope discovery.",
      required: false,
    },
  ],
  parseFormData(form) {
    const apiToken = String(form.get("api_token") ?? "").trim();
    const orgSlug = String(form.get("org_slug") ?? "").trim();
    if (!apiToken) throw new ProviderError("Missing api_token", 400);
    return {
      credentials: { apiToken },
      explicitAccountId: orgSlug || null,
    };
  },
};
