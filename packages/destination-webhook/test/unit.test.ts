import { describe, expect, it } from "vitest";
import { webhookDriver } from "../src/index";

// parseFormData moved to the SaaS-side connect adapter.

describe("generateSinkBundle", () => {
  it("emits http sink fed directly from upstream inputs", () => {
    const bundle = webhookDriver.generateSinkBundle({
      config: { url: "ignored" },
      inputs: ["mon_x_0"],
      sinkKey: "sink_snk_y",
      envVarName: "WEBHOOK_URL_dst_z",
    });
    expect(bundle.preSinkTransforms).toBeUndefined();
    const y = bundle.sink.yaml;
    expect(y).toContain("type: http");
    expect(y).toContain('inputs: ["mon_x_0"]');
    expect(y).toContain('uri: "${WEBHOOK_URL_dst_z}"');
    // Generic webhook can batch up to 50 events per body.
    expect(y).toContain("max_events: 50");
  });
});

describe("envVarValue", () => {
  it("returns the configured URL", () => {
    expect(webhookDriver.envVarValue({ url: "https://ex.com/h" }, "ignored")).toBe(
      "https://ex.com/h",
    );
  });
});
