import { ProviderError } from "@logtura/core";
import type { VercelCredentials } from "@logtura/driver-vercel-logs";
import type { ProviderConnectAdapter } from "./types";

export const vercelLogsConnect: ProviderConnectAdapter<VercelCredentials> = {
  driverId: "vercel-logs",
  connectFlow: {
    kind: "external_token",
    url: "https://vercel.com/account/settings/tokens",
    buttonLabel: "Open Vercel tokens page",
    buttonDescription:
      "Create a Vercel Access Token and paste it below. For team-owned projects, include the Team ID so discovery can list the right projects.",
    pasteFieldName: "api_token",
    manualInstructions:
      "Vercel's public REST API uses Access Tokens. Marketplace-style OAuth requires a Vercel Integration setup; until that is configured, token paste is the reliable Hobby-compatible path.",
  },
  formFields: [
    {
      name: "api_token",
      label: "Vercel Access Token",
      type: "password",
      placeholder: "vcp_...",
      description:
        "Used to discover projects and stream Runtime Logs via Vercel's REST API. Use a token scoped to the account/team you want to forward.",
      required: true,
    },
    {
      name: "team_id",
      label: "Vercel Team ID",
      type: "text",
      placeholder: "team_... (blank for personal account)",
      description:
        "Required for team-owned projects. Leave blank only for personal-account projects.",
      required: false,
    },
  ],
  parseFormData(form) {
    const apiToken = String(form.get("api_token") ?? "").trim();
    const teamId = String(form.get("team_id") ?? "").trim();
    if (!apiToken) throw new ProviderError("Missing api_token", 400);
    return {
      credentials: { apiToken },
      explicitAccountId: teamId || null,
    };
  },
};
