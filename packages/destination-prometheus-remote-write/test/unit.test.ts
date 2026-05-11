import { describe, expect, it } from "vitest";
import { prometheusRemoteWriteDriver } from "../src/index";

describe("parseFormData", () => {
  it("accepts endpoint without a bearer", () => {
    const f = new FormData();
    f.set("endpoint", "https://prom.example.com/api/v1/write");
    expect(prometheusRemoteWriteDriver.parseFormData(f).config).toEqual({
      endpoint: "https://prom.example.com/api/v1/write",
      bearerToken: null,
    });
  });

  it("accepts endpoint + bearer", () => {
    const f = new FormData();
    f.set("endpoint", "https://prom.example.com/api/v1/write");
    f.set("bearerToken", "tok_abc");
    expect(
      prometheusRemoteWriteDriver.parseFormData(f).config.bearerToken,
    ).toBe("tok_abc");
  });

  it("rejects non-https endpoints", () => {
    const f = new FormData();
    f.set("endpoint", "http://prom/api/v1/write");
    expect(() => prometheusRemoteWriteDriver.parseFormData(f)).toThrow(
      /must start with https/,
    );
  });
});

describe("generateSinkBundle", () => {
  it("emits an unauthenticated prometheus_remote_write sink", () => {
    const bundle = prometheusRemoteWriteDriver.generateSinkBundle({
      config: { endpoint: "ignored", bearerToken: null },
      inputs: ["metrics_in"],
      sinkKey: "sink_pr",
      envVarName: "PROM_URL_dst_z",
    });
    const y = bundle.sink.yaml;
    expect(y).toContain("type: prometheus_remote_write");
    expect(y).toContain('endpoint: "${PROM_URL_dst_z}"');
    expect(y).not.toContain("auth:");
  });

  it("adds bearer auth + token env when a token is configured", () => {
    const bundle = prometheusRemoteWriteDriver.generateSinkBundle({
      config: { endpoint: "ignored", bearerToken: "tok_abc" },
      inputs: ["metrics_in"],
      sinkKey: "sink_pr",
      envVarName: "PROM_URL_dst_z",
    });
    const y = bundle.sink.yaml;
    expect(y).toContain("auth:");
    expect(y).toContain("strategy: bearer");
    expect(y).toContain('token: "${PROM_URL_dst_z_TOKEN}"');
  });
});

describe("runtimeEnvVars + envVarValue", () => {
  it("declares both URL and TOKEN envs when token is set", () => {
    const env = prometheusRemoteWriteDriver.runtimeEnvVars({
      config: { endpoint: "https://e", bearerToken: "tok" },
      envVarName: "PROM_URL_dst_z",
      displayName: "prod",
    });
    expect(env.map((e) => e.name)).toEqual([
      "PROM_URL_dst_z",
      "PROM_URL_dst_z_TOKEN",
    ]);
  });

  it("envVarValue routes URL vs TOKEN by suffix", () => {
    const config = { endpoint: "https://e", bearerToken: "tok" };
    expect(prometheusRemoteWriteDriver.envVarValue(config, "PROM_URL_dst_z")).toBe("https://e");
    expect(
      prometheusRemoteWriteDriver.envVarValue(config, "PROM_URL_dst_z_TOKEN"),
    ).toBe("tok");
  });
});
