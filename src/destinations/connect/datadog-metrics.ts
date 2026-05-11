import { DestinationError } from "@logtura/core";
import type { DatadogMetricsConfig } from "@logtura/destination-datadog-metrics";
import type { DestinationConnectAdapter } from "./types";

export const datadogMetricsConnect: DestinationConnectAdapter<DatadogMetricsConfig> = {
  driverId: "datadog_metrics",
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
};
