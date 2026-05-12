import { describe, expect, it, vi } from "vitest";
import { supabaseEdgeLogsDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  externalAccountId: "edzvfyvdtvwrnaoyupqq",
  displayName: "test",
};

const fnSource = (id: string, slug: string, uuid: string) => ({
  id,
  externalId: slug,
  displayName: slug,
  sourceKind: "supabase_edge_fn",
  metadata: { function_id: uuid },
});

// parseFormData + connectFlow + formFields live in the SaaS-side
// connect adapter (src/providers/connect/supabase-edge-logs.ts).

describe("capabilities", () => {
  it("declares both selection modes (one poll handles list or all)", () => {
    expect(supabaseEdgeLogsDriver.capabilities.selection).toBe("both");
  });
});

describe("generatePipeline", () => {
  it("emits one http_client per connection regardless of selection size", () => {
    const a = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
        ],
      },
    });
    const b = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
          fnSource(
            "src_b",
            "agent-thread",
            "0ab47137-d31d-45b6-a31a-bf3c90b85d9a",
          ),
        ],
      },
    });
    const aSources = a.components.filter((c) => c.kind === "source");
    const bSources = b.components.filter((c) => c.kind === "source");
    expect(aSources).toHaveLength(1);
    expect(bSources).toHaveLength(1);
    expect(aSources[0]!.key).toBe("supabase_edge_con_x_fn");
    expect(bSources[0]!.key).toBe(aSources[0]!.key);
  });

  it("different connections get distinct keys", () => {
    const a = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
        ],
      },
    });
    const b = supabaseEdgeLogsDriver.generatePipeline({
      connection: { ...dummyConnection, id: "con_y" },
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
        ],
      },
    });
    const aKey = a.components.find((c) => c.kind === "source")!.key;
    const bKey = b.components.find((c) => c.kind === "source")!.key;
    expect(aKey).not.toBe(bKey);
  });

  it("source yaml polls the analytics endpoint with bearer auth", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
        ],
      },
    });
    const src = pipe.components.find((c) => c.kind === "source")!;
    expect(src.yaml).toContain("type: http_client");
    expect(src.yaml).toContain("interval_secs: 30");
    expect(src.yaml).toContain('authorization: ["Bearer ${SUPABASE_PAT}"]');
    expect(src.yaml).toContain(
      "/v1/projects/${SUPABASE_PROJECT_REF}/analytics/endpoints/logs.all",
    );
  });

  it("SQL doesn't filter by function_id (consolidated routing in normalize)", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
        ],
      },
    });
    const src = pipe.components.find((c) => c.kind === "source")!;
    expect(src.yaml).not.toContain(
      encodeURIComponent("'6eda78cc-fc80-40f0-bd85-05ab0388842c'"),
    );
    expect(src.yaml).not.toContain(encodeURIComponent("function_id ="));
  });

  it("rejects sources missing function_id in metadata", () => {
    expect(() =>
      supabaseEdgeLogsDriver.generatePipeline({
        connection: dummyConnection,
        selection: {
          kind: "list",
          sources: [
            { ...fnSource("src_a", "agent-chat", ""), metadata: null },
          ],
        },
      }),
    ).toThrow(/missing metadata.function_id/);
  });

  it("list mode normalize emits slug-map + drop-on-miss", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
          fnSource(
            "src_b",
            "agent-thread",
            "0ab47137-d31d-45b6-a31a-bf3c90b85d9a",
          ),
        ],
      },
    });
    const norm = pipe.components.find((c) => c.kind === "transform")!;
    const y = norm.yaml;
    expect(y).toContain("type: remap");
    expect(y).toContain("records = array(.result)");
    expect(y).toContain('"6eda78cc-fc80-40f0-bd85-05ab0388842c"');
    expect(y).toContain('script = "agent-chat"');
    expect(y).toContain('"0ab47137-d31d-45b6-a31a-bf3c90b85d9a"');
    expect(y).toContain('script = "agent-thread"');
    // List mode drops events for unselected functions.
    expect(y).toContain("# script ==");
    // Level inference is text-based now (function_edge_logs has no
    // HTTP status_code in metadata).
    expect(y).toContain('match(body, r\'(?i)\\b(error|exception');
    expect(y).toContain("ts_us / 1000");
    expect(y).toContain(". = out");
    expect(y).toContain('"[" + script + "] " + body');
  });

  it("all mode normalize tags unknown function_ids with the UUID instead of dropping", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: { kind: "all" },
    });
    const norm = pipe.components.find((c) => c.kind === "transform")!;
    const y = norm.yaml;
    expect(y).not.toContain('script = "agent-chat"');
    expect(y).toContain('if script == "" { script = fn_id }');
  });

  it("declares SUPABASE_PAT + SUPABASE_PROJECT_REF, no docker deps", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
        ],
      },
    });
    expect(pipe.envVars.map((e) => e.name)).toEqual([
      "SUPABASE_PAT",
      "SUPABASE_PROJECT_REF",
    ]);
    expect(pipe.dockerfileDeps).toEqual([]);
  });

  it("switches to exec/logtura-http-client when credentialKind is refreshable", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: { ...dummyConnection, credentialKind: "refreshable" },
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
        ],
      },
    });
    const source = pipe.components.find((c) => c.kind === "source")!;
    expect(source.yaml).toContain("type: exec");
    expect(source.yaml).toContain("logtura-http-client");
    expect(source.yaml).toContain('strategy = "bearer_refresh"');
    expect(source.yaml).toContain("${LOGTURA_TAIL_TOKEN_URL}");
    expect(source.yaml).toContain("${LOGTURA_TAIL_TOKEN}");
    expect(source.yaml).not.toContain("SUPABASE_PAT");

    const names = pipe.envVars.map((v) => v.name);
    expect(names).toContain("LOGTURA_TAIL_TOKEN");
    expect(names).toContain("LOGTURA_TAIL_TOKEN_URL");
    expect(names).toContain("SUPABASE_PROJECT_REF");
    expect(names).not.toContain("SUPABASE_PAT");

    // dockerfileDeps pulls the binary from the published image via
    // COPY --from, pinned to a specific tag.
    expect(pipe.dockerfileDeps[0]?.directive).toMatch(
      /^COPY --from=ghcr\.io\/logtura\/logtura-http-client:v\d+\.\d+\.\d+ /,
    );
    expect(pipe.dockerfileDeps[0]?.directive).toContain(
      "/usr/local/bin/logtura-http-client",
    );
  });

  it("stays on http_client when credentialKind is static or unset", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
        ],
      },
    });
    const source = pipe.components.find((c) => c.kind === "source")!;
    expect(source.yaml).toContain("type: http_client");
    expect(source.yaml).toContain("${SUPABASE_PAT}");
    expect(source.yaml).not.toContain("logtura-http-client");
  });
});

describe("discoverSources", () => {
  it("maps /v1/projects/<ref>/functions to DiscoveredSource", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "6eda78cc-fc80-40f0-bd85-05ab0388842c",
            slug: "agent-chat",
            name: "agent-chat",
            status: "ACTIVE",
            version: 16,
          },
          {
            id: "0ab47137-d31d-45b6-a31a-bf3c90b85d9a",
            slug: "agent-thread",
            name: "agent-thread",
            status: "ACTIVE",
            version: 5,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const sources = await supabaseEdgeLogsDriver.discoverSources({
      credentials: { pat: "sbp_test" },
      accountId: "edzvfyvdtvwrnaoyupqq",
    });
    expect(fetchSpy.mock.calls[0]![0]).toMatch(
      /\/v1\/projects\/edzvfyvdtvwrnaoyupqq\/functions$/,
    );
    // 2 functions + 1 synthetic gateway pseudo-source.
    expect(sources).toHaveLength(3);
    expect(sources[0]).toEqual({
      sourceKind: "supabase_edge_fn",
      externalId: "agent-chat",
      displayName: "agent-chat",
      metadata: {
        function_id: "6eda78cc-fc80-40f0-bd85-05ab0388842c",
        status: "ACTIVE",
        version: 16,
      },
    });
    const gateway = sources.find((s) => s.sourceKind === "supabase_gateway");
    expect(gateway).toBeDefined();
    expect(gateway!.externalId).toBe("_gateway_");
    expect(gateway!.displayName).toContain("HTTP gateway");
    fetchSpy.mockRestore();
  });

  it("gateway source can be picked alongside functions", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          fnSource("src_a", "agent-chat", "6eda78cc-fc80-40f0-bd85-05ab0388842c"),
          {
            id: "src_gw",
            externalId: "_gateway_",
            displayName: "Project HTTP gateway",
            sourceKind: "supabase_gateway",
            metadata: null,
          },
        ],
      },
    });
    const sources = pipe.components.filter((c) => c.kind === "source");
    expect(sources).toHaveLength(2);
    const keys = sources.map((s) => s.key);
    expect(keys).toContain("supabase_edge_con_x_fn");
    expect(keys).toContain("supabase_edge_con_x_gw");
    const gwSrc = sources.find((s) => s.key.endsWith("_gw"))!;
    // Gateway SQL hits edge_logs, not function_edge_logs.
    expect(decodeURIComponent(gwSrc.yaml)).toContain("FROM edge_logs");
    // Converging transform fans both normalizes into outputKey.
    expect(pipe.outputKey).toBe("supabase_edge_con_x_norm");
    expect(pipe.components.some((c) => c.key === pipe.outputKey)).toBe(true);
  });

  it("gateway-only selection uses status-code level inference", () => {
    const pipe = supabaseEdgeLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          {
            id: "src_gw",
            externalId: "_gateway_",
            displayName: "Project HTTP gateway",
            sourceKind: "supabase_gateway",
            metadata: null,
          },
        ],
      },
    });
    const sources = pipe.components.filter((c) => c.kind === "source");
    expect(sources).toHaveLength(1);
    expect(sources[0]!.key).toBe("supabase_edge_con_x_gw");
    const norm = pipe.components.find((c) => c.kind === "transform")!;
    expect(norm.yaml).toContain("status >= 400");
    expect(norm.yaml).toContain("status >= 500");
    expect(norm.yaml).toContain('"source_kind": "gateway"');
    // No converger when only one channel — outputKey points right
    // at the single normalize.
    expect(pipe.outputKey).toBe(norm.key);
  });
});
