import { describe, expect, it } from "vitest";
import { datadogMetricsDriver } from "../src/index";

// parseFormData moved to the SaaS-side connect adapter.

describe("generateSinkBundle", () => {
  it("emits datadog_metrics with site + api key env-injection", () => {
    const bundle = datadogMetricsDriver.generateSinkBundle({
      config: { apiKey: "ignored", site: "ap1.datadoghq.com" },
      inputs: ["metrics_in"],
      sinkKey: "sink_dd",
      envVarName: "DATADOG_API_KEY_dst_z",
    });
    const y = bundle.sink.yaml;
    expect(y).toContain("type: datadog_metrics");
    expect(y).toContain('inputs: ["metrics_in"]');
    expect(y).toContain('default_api_key: "${DATADOG_API_KEY_dst_z}"');
    expect(y).toContain('site: "ap1.datadoghq.com"');
  });
});

describe("flows", () => {
  it("declares metrics flow only", () => {
    expect(datadogMetricsDriver.flows).toEqual(["metrics"]);
  });
});
