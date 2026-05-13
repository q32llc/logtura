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
      "Paste a Railway token for the project or account you want to tail. OAuth is planned; the tailer only needs a bearer/project token at runtime.",
    pasteFieldName: "api_token",
    manualInstructions:
      "Set the environment id on the connection so Logtura can open the environment-level log stream and demux selected services.",
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
      name: "environment_id",
      label: "Railway environment ID",
      type: "text",
      placeholder: "4411de6d-742f-448c-995d-acd755b695ff",
      description:
        "The environment to stream. Selected services are demuxed from this environment stream.",
      required: true,
    },
    {
      name: "project_id",
      label: "Railway project ID (optional)",
      type: "text",
      placeholder: "ebd34efa-1176-4d94-bbc3-a7f90cfa0045",
      description:
        "Optional for discovery; not needed by the runtime tailer once sources are selected.",
      required: false,
    },
  ],
  parseFormData(form) {
    const apiToken = String(form.get("api_token") ?? "").trim();
    const environmentId = String(form.get("environment_id") ?? "").trim();
    const projectId = String(form.get("project_id") ?? "").trim();
    if (!apiToken) throw new ProviderError("Missing api_token", 400);
    if (!environmentId) throw new ProviderError("Missing environment_id", 400);
    return {
      credentials: {
        apiToken,
        ...(projectId ? { projectId, environmentId } : { environmentId }),
      },
      explicitAccountId: environmentId,
    };
  },
};
