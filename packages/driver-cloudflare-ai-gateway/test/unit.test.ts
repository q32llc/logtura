/** Fast unit tests for the cloudflare-ai-gateway driver. */
import { describe, expect, it, vi } from "vitest";
import { cloudflareAiGatewayDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  provider: "cloudflare-ai-gateway",
  displayName: "test",
  externalAccountId: "acct_x",
};

describe("generateSourceBlock", () => {
  it("emits http_client poll with bearer auth + 30s interval", () => {
    const block = cloudflareAiGatewayDriver.generateSourceBlock({
      source: {
        id: "src_g",
        externalId: "my-gateway",
        displayName: "my-gateway",
        sourceKind: "cf_ai_gateway",
        metadata: null,
      },
      connection: dummyConnection,
    });
    expect(block.key).toBe("cf_ai_gateway_my_gateway");
    expect(block.yaml).toContain("type: http_client");
    expect(block.yaml).toContain(
      "/ai-gateway/gateways/my-gateway/logs",
    );
    expect(block.yaml).toContain("interval_secs: 30");
    // http_client expects map<string, array<string>>.
    expect(block.yaml).toContain('authorization: ["Bearer ${CLOUDFLARE_API_TOKEN}"]');
  });
});

describe("generateNormalize", () => {
  it("returns null when no inputs are wired", () => {
    expect(
      cloudflareAiGatewayDriver.generateNormalize!({
        inputKeys: [],
        connection: dummyConnection,
        sources: [],
      }),
    ).toBeNull();
  });

  it("classifies error via !success || status >= 500", () => {
    const norm = cloudflareAiGatewayDriver.generateNormalize!({
      inputKeys: ["cf_ai_gateway_g1"],
      connection: dummyConnection,
      sources: [],
    });
    expect(norm?.key).toBe("cf_ai_gateway_norm");
    const y = norm!.yaml;
    expect(y).toContain("type: remap");
    expect(y).toContain(".error = !success || status >= 500");
    // [provider] prefix so non-rollup monitors still tag the Slack
    // body with the source name.
    expect(y).toContain('"[" + .script + "]');
    // int→string cast must use to_string (string() is fallible).
    expect(y).toContain("to_string(status)");
  });
});

describe("runtimeSpec", () => {
  it("declares CF env vars and no extra docker install", () => {
    const spec = cloudflareAiGatewayDriver.runtimeSpec(dummyConnection);
    const names = spec.envVars.map((e) => e.name);
    expect(names).toContain("CLOUDFLARE_API_TOKEN");
    expect(names).toContain("CLOUDFLARE_ACCOUNT_ID");
    // http_client is in vector itself — no apt install needed.
    expect(spec.dockerfileDeps).toEqual([]);
  });
});

describe("discoverSources", () => {
  it("maps /ai-gateway/gateways response to DiscoveredSource", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            { id: "gw-alpha", collect_logs: true },
            { id: "gw-beta" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const sources = await cloudflareAiGatewayDriver.discoverSources({
      credentials: { apiToken: "cfat_test" },
      accountId: "f0c6ed442ab8c6bf9d102678d9421dd8",
    });
    expect(fetchSpy.mock.calls[0]![0]).toMatch(
      /\/accounts\/f0c6ed442ab8c6bf9d102678d9421dd8\/ai-gateway\/gateways$/,
    );
    expect(sources).toEqual([
      {
        sourceKind: "cf_ai_gateway",
        externalId: "gw-alpha",
        displayName: "gw-alpha",
        metadata: { collect_logs: true },
      },
      {
        sourceKind: "cf_ai_gateway",
        externalId: "gw-beta",
        displayName: "gw-beta",
        metadata: { collect_logs: null },
      },
    ]);
    fetchSpy.mockRestore();
  });
});
