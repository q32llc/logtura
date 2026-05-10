import type { DestinationDriver, SinkBundle } from "./types";
import { DestinationError } from "./types";

/**
 * Prometheus remote-write — Vector's native sink for any Prometheus-
 * compatible TSDB: Mimir, VictoriaMetrics, Thanos, Cortex, self-hosted
 * Prometheus with the remote_write receiver enabled, Grafana Cloud,
 * etc. Two-field config: the endpoint URL and an optional bearer token.
 */
export interface PrometheusRemoteWriteConfig {
  endpoint: string;
  /** Optional bearer token; pasted into env so the user can rotate
   *  without touching the deploy spec. */
  bearerToken: string | null;
}

export const prometheusRemoteWriteDriver: DestinationDriver<PrometheusRemoteWriteConfig> =
  {
    id: "prometheus_remote_write",
    displayName: "Prometheus remote-write",
    description:
      "Push Vector internal metrics to any Prometheus-compatible TSDB (Mimir, VictoriaMetrics, Thanos, Grafana Cloud, self-hosted Prom with remote_write enabled).",
    flows: ["metrics"],
    formFields: [
      {
        name: "endpoint",
        label: "Remote-write endpoint",
        type: "text",
        placeholder: "https://prometheus.example.com/api/v1/write",
        description:
          "Full URL to the receiver's remote-write endpoint. HTTPS only.",
        required: true,
      },
      {
        name: "bearerToken",
        label: "Bearer token (optional)",
        type: "password",
        placeholder: "(leave empty if the endpoint is open)",
        description:
          "If the receiver requires authentication, paste the bearer token. Grafana Cloud's remote_write needs this; self-hosted Prom often doesn't.",
        required: false,
      },
    ],

    parseFormData(form) {
      const endpoint = String(form.get("endpoint") ?? "").trim();
      if (!endpoint) {
        throw new DestinationError("Missing remote-write endpoint", 400);
      }
      if (!/^https:\/\//.test(endpoint)) {
        throw new DestinationError("Endpoint must start with https://", 400);
      }
      const bearerToken =
        String(form.get("bearerToken") ?? "").trim() || null;
      return { config: { endpoint, bearerToken } };
    },

    generateSinkBundle({ config, inputs, sinkKey, envVarName }): SinkBundle {
      const tokenEnv = `${envVarName}_TOKEN`;
      const lines = [
        "    type: prometheus_remote_write",
        `    inputs: [${inputs.map((i) => `"${i}"`).join(", ")}]`,
        `    endpoint: "\${${envVarName}}"`,
        "    healthcheck:",
        "      enabled: false",
      ];
      if (config.bearerToken !== null) {
        lines.push("    auth:");
        lines.push("      strategy: bearer");
        lines.push(`      token: "\${${tokenEnv}}"`);
      }
      return { sink: { key: sinkKey, yaml: lines.join("\n") } };
    },

    runtimeEnvVars({ config, envVarName, displayName }) {
      const out = [
        {
          name: envVarName,
          description: `Prometheus remote-write endpoint for "${displayName}"`,
          source: "destination" as const,
        },
      ];
      if (config.bearerToken !== null) {
        out.push({
          name: `${envVarName}_TOKEN`,
          description: `Bearer token for "${displayName}" remote-write`,
          source: "destination" as const,
        });
      }
      return out;
    },

    envVarValue(config, envVarName) {
      // envVarName here is whichever one the bundle asked us about —
      // the URL or the token. The bundle generator iterates our
      // declared env vars and calls this for each.
      if (envVarName.endsWith("_TOKEN")) return config.bearerToken ?? "";
      return config.endpoint;
    },
  };
