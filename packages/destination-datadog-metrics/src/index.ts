import { type DestinationDriver, type SinkBundle } from "@logtura/core";

/**
 * Datadog Metrics — Vector's native `datadog_metrics` sink. Takes
 * internal_metrics events (or anything in the metric schema) and
 * forwards them to Datadog's intake.
 */
export interface DatadogMetricsConfig {
  apiKey: string;
  /** Datadog site hostname (datadoghq.com, datadoghq.eu, etc.). Defaults
   *  to US1 since that's the most common. */
  site: string;
}

export const datadogMetricsDriver: DestinationDriver<DatadogMetricsConfig> = {
  id: "datadog_metrics",
  displayName: "Datadog (metrics)",
  description:
    "Forward Vector internal metrics to Datadog. Tracks events processed, errors, sink delivery rates per deployment — the same counters Vector exposes at /metrics, just shipped to your Datadog account.",
  flows: ["metrics"],

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
