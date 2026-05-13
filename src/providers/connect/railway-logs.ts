import { ProviderError } from "@logtura/core";
import type { RailwayCredentials } from "@logtura/driver-railway-logs";
import type { ProviderConnectAdapter } from "./types";

export const railwayLogsConnect: ProviderConnectAdapter<RailwayCredentials> = {
  driverId: "railway-logs",
  connectFlow: {
    kind: "external_token",
    url: "https://railway.com/account/tokens",
    buttonLabel: "Open Railway tokens page",
    buttonDescription:
      "Paste a Railway token. Logtura will discover visible projects, environments, and services so you can pick sources later.",
    pasteFieldName: "api_token",
    manualInstructions:
      "Use an account token for broad discovery, or a project token if you only want one Railway project exposed.",
  },
  formFields: [
    {
      name: "api_token",
      label: "Railway token",
      type: "password",
      placeholder: "Railway API or project token",
      description:
        "Used to subscribe to Railway environment logs. Project-scoped tokens are preferred when available.",
      required: true,
    },
    {
      name: "project_id",
      label: "Limit to project ID (optional)",
      type: "text",
      placeholder: "ebd34efa-1176-4d94-bbc3-a7f90cfa0045",
      description:
        "Optional discovery filter. Leave blank to discover all Railway projects visible to this token.",
      required: false,
    },
  ],
  parseFormData(form) {
    const apiToken = String(form.get("api_token") ?? "").trim();
    const projectId = String(form.get("project_id") ?? "").trim();
    if (!apiToken) throw new ProviderError("Missing api_token", 400);
    return {
      credentials: {
        apiToken,
        ...(projectId ? { projectId } : {}),
      },
      explicitAccountId: null,
    };
  },
};
