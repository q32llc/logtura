import {
  type DestinationDriver,
  DestinationError,
  type SinkBundle,
} from "@logtura/core";

/**
 * Datadog Metrics — Vector's native `datadog_metrics` sink. Takes
 * internal_metrics events (or anything in the metric schema) and
 * forwards them to Datadog's intake. One-field config: the API key.
 *
 * No OAuth — Datadog's API keys are issued in the dashboard. User
 * pastes one; we env-inject it at deploy time. Same pattern as the
 * Cloudflare connection.
 */
export interface DatadogMetricsConfig {
  apiKey: string;
  /** Datadog site host (datadoghq.com, datadoghq.eu, etc.). Defaults
   *  to US1 since that's the most common. */
  site: string;
}

export const datadogMetricsDriver: DestinationDriver<DatadogMetricsConfig> = {
  id: "datadog_metrics",
  displayName: "Datadog (metrics)",
  description:
    "Forward Vector internal metrics to Datadog. Tracks events processed, errors, sink delivery rates per deployment — the same counters Vector exposes at /metrics, just shipped to your Datadog account.",
  flows: ["metrics"],
  formFields: [
    {
      name: "apiKey",
      label: "Datadog API key",
      type: "password",
      placeholder: "abcdef0123...",
      description:
        "Issued in Datadog → Organization Settings → API Keys. Used only for the metrics intake; no other Datadog scopes needed.",
      required: true,
    },
    {
      name: "site",
      label: "Datadog site",
      type: "text",
      placeholder: "datadoghq.com",
      description:
        "datadoghq.com (US1), us3.datadoghq.com (US3), us5.datadoghq.com (US5), datadoghq.eu (EU), ddog-gov.com, ap1.datadoghq.com.",
      required: false,
    },
  ],

  parseFormData(form) {
    const apiKey = String(form.get("apiKey") ?? "").trim();
    if (!apiKey) {
      throw new DestinationError("Missing Datadog API key", 400);
    }
    const site = String(form.get("site") ?? "").trim() || "datadoghq.com";
    return { config: { apiKey, site } };
  },

  generateSinkBundle({ config, inputs, sinkKey, envVarName }): SinkBundle {
    const yaml = [
      "    type: datadog_metrics",
      `    inputs: [${inputs.map((i) => `"${i}"`).join(", ")}]`,
      `    default_api_key: "\${${envVarName}}"`,
      `    site: "${config.site}"`,
      "    healthcheck:",
      "      enabled: false",
    ].join("\n");
    return { sink: { key: sinkKey, yaml } };
  },

  runtimeEnvVars({ envVarName, displayName }) {
    return [
      {
        name: envVarName,
        description: `Datadog API key for "${displayName}" (metrics intake)`,
        source: "destination",
      },
    ];
  },

  envVarValue(config) {
    return config.apiKey;
  },
};
