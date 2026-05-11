import {
  type DestinationDriver,
  DestinationError,
  type SinkBundle,
} from "@logtura/core";

export interface WebhookConfig {
  url: string;
}

export const webhookDriver: DestinationDriver<WebhookConfig> = {
  id: "webhook",
  displayName: "HTTPS webhook",
  description:
    "Send each matched log line as JSON to any HTTPS endpoint. Works with Discord, custom services, n8n, Better Stack's HTTP source, anything that accepts a POST.",
  flows: ["logs"],
  formFields: [
    {
      name: "url",
      label: "Webhook URL",
      type: "text",
      placeholder: "https://hooks.example.com/...",
      description:
        "logtura POSTs JSON-encoded log lines here. Use HTTPS only.",
      required: true,
    },
  ],

  parseFormData(form) {
    const url = String(form.get("url") ?? "").trim();
    if (!url) throw new DestinationError("Missing webhook URL", 400);
    if (!/^https:\/\//.test(url)) {
      throw new DestinationError("URL must start with https://", 400);
    }
    return { config: { url } };
  },

  generateSinkBundle({ inputs, sinkKey, envVarName }): SinkBundle {
    const yaml = [
      "    type: http",
      `    inputs: [${inputs.map((i) => `"${i}"`).join(", ")}]`,
      `    uri: "\${${envVarName}}"`,
      "    method: post",
      "    encoding:",
      "      codec: json",
      "    request:",
      "      headers:",
      "        content-type: application/json",
      "    batch:",
      "      max_events: 50",
      "      timeout_secs: 5",
      "    healthcheck:",
      "      enabled: false",
    ].join("\n");
    return { sink: { key: sinkKey, yaml } };
  },

  runtimeEnvVars({ envVarName, displayName }) {
    return [
      {
        name: envVarName,
        description: `Webhook URL for "${displayName}" destination`,
        source: "destination",
      },
    ];
  },

  envVarValue(config) {
    return config.url;
  },
};
