/** Fast unit tests for the cloudflare-ai-gateway driver. */
import { describe, expect, it, vi } from "vitest";
import { cloudflareAiGatewayDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  externalAccountId: "acct_x",
  displayName: "test",
};

const gwSource = (id: string, name: string) => ({
  id,
  externalId: name,
  displayName: name,
  sourceKind: "cf_ai_gateway",
  metadata: null,
});

describe("capabilities", () => {
  it("declares list-only selection (per-gateway endpoints)", () => {
    expect(cloudflareAiGatewayDriver.capabilities.selection).toBe("list");
  });
});

describe("generatePipeline", () => {
  it("rejects all-selection", () => {
    expect(() =>
      cloudflareAiGatewayDriver.generatePipeline({
        connection: dummyConnection,
        selection: { kind: "all" },
      }),
    ).toThrow(/does not support "all"/);
  });

  it("emits one http_client per gateway + a normalize transform", () => {
    const pipe = cloudflareAiGatewayDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [gwSource("src_g", "my-gateway")],
      },
    });
    const sources = pipe.components.filter((c) => c.kind === "source");
    const transforms = pipe.components.filter((c) => c.kind === "transform");
    expect(sources).toHaveLength(1);
    expect(transforms).toHaveLength(1);
    expect(pipe.outputKey).toBe(transforms[0]!.key);
    expect(sources[0]!.key).toBe("cf_ai_gateway_con_x_my_gateway");
    const y = sources[0]!.yaml;
    expect(y).toContain("type: http_client");
    expect(y).toContain("/ai-gateway/gateways/my-gateway/logs");
    expect(y).toContain("interval_secs: 30");
    // http_client expects map<string, array<string>>.
    expect(y).toContain('authorization: ["Bearer ${CLOUDFLARE_API_TOKEN}"]');
  });

  it("normalize classifies error via !success || status >= 500", () => {
    const pipe = cloudflareAiGatewayDriver.generatePipeline({
      connection: dummyConnection,
      selection: { kind: "list", sources: [gwSource("src_g", "my-gateway")] },
    });
    const norm = pipe.components.find((c) => c.kind === "transform")!;
    const y = norm.yaml;
    expect(y).toContain("type: remap");
    expect(y).toContain(".error = !success || status >= 500");
    expect(y).toContain('"[" + .script + "]');
    // int -> string cast must use to_string (string() is fallible).
    expect(y).toContain("to_string(status)");
  });

  it("declares CF env vars and no extra docker install", () => {
    const pipe = cloudflareAiGatewayDriver.generatePipeline({
      connection: dummyConnection,
      selection: { kind: "list", sources: [gwSource("src_g", "my-gateway")] },
    });
    const names = pipe.envVars.map((e) => e.name);
    expect(names).toContain("CLOUDFLARE_API_TOKEN");
    expect(names).toContain("CLOUDFLARE_ACCOUNT_ID");
    // http_client is in vector itself, no apt install needed.
    expect(pipe.dockerfileDeps).toEqual([]);
  });

  it("manifest echoes Source.id for host UI linking", () => {
    const pipe = cloudflareAiGatewayDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [gwSource("src_chosen", "my-gateway")],
      },
    });
    const sourceEntry = (pipe.manifest ?? []).find(
      (m) => m.role === "source",
    );
    expect(sourceEntry?.links?.sourceId).toBe("src_chosen");
    expect(sourceEntry?.links?.connectionId).toBe("con_x");
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
