import { type DestinationDriver, type SinkBundle } from "@logtura/core";

export interface WebhookConfig {
  url: string;
}

export const webhookDriver: DestinationDriver<WebhookConfig> = {
  id: "webhook",
  displayName: "HTTPS webhook",
  description:
    "Send each matched log line as JSON to any HTTPS endpoint. Works with Discord, custom services, n8n, Better Stack's HTTP source, anything that accepts a POST.",
  flows: ["logs"],

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
