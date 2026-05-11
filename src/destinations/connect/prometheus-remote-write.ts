import { DestinationError } from "@logtura/core";
import type { PrometheusRemoteWriteConfig } from "@logtura/destination-prometheus-remote-write";
import type { DestinationConnectAdapter } from "./types";

export const prometheusRemoteWriteConnect: DestinationConnectAdapter<PrometheusRemoteWriteConfig> =
  {
    driverId: "prometheus_remote_write",
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
  };
