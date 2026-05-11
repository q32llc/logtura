import { describe, expect, it, vi } from "vitest";
import { supabaseEdgeLogsDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  provider: "supabase-edge-logs",
  displayName: "test",
  externalAccountId: "edzvfyvdtvwrnaoyupqq",
};

const dummySource = {
  id: "src_a",
  externalId: "agent-chat",
  displayName: "agent-chat",
  sourceKind: "supabase_edge_fn",
  metadata: { function_id: "6eda78cc-fc80-40f0-bd85-05ab0388842c" },
};

// parseFormData + connectFlow + formFields moved to the SaaS-side
// connect adapter (src/providers/connect/supabase-edge-logs.ts);
// see test/workerd/connect-adapters.test.ts for those tests.

describe("generateSourceBlock", () => {
  it("keys on connection.id (not source) so the renderer dedupes N → 1", () => {
    // Regression-pin: the original shape was one http_client per
    // function; Supabase's analytics endpoint started 429-ing at 6
    // functions × 30s polls. Now every selected function in the
    // same connection returns the same block key, and the renderer
    // emits ONE source per connection.
    const a = supabaseEdgeLogsDriver.generateSourceBlock({
      source: dummySource,
      connection: dummyConnection,
    });
    const b = supabaseEdgeLogsDriver.generateSourceBlock({
      source: {
        ...dummySource,
        externalId: "agent-thread",
        metadata: { function_id: "0ab47137-d31d-45b6-a31a-bf3c90b85d9a" },
      },
      connection: dummyConnection,
    });
    expect(a.key).toBe("supabase_edge_con_x");
    expect(b.key).toBe(a.key);
    expect(b.yaml).toBe(a.yaml);
  });

  it("different connections get distinct keys", () => {
    const a = supabaseEdgeLogsDriver.generateSourceBlock({
      source: dummySource,
      connection: dummyConnection,
    });
    const b = supabaseEdgeLogsDriver.generateSourceBlock({
      source: dummySource,
      connection: { ...dummyConnection, id: "con_y" },
    });
    expect(a.key).not.toBe(b.key);
  });

  it("emits http_client poll against the analytics endpoint", () => {
    const block = supabaseEdgeLogsDriver.generateSourceBlock({
      source: dummySource,
      connection: dummyConnection,
    });
    expect(block.yaml).toContain("type: http_client");
    expect(block.yaml).toContain("interval_secs: 30");
    expect(block.yaml).toContain(
      'authorization: ["Bearer ${SUPABASE_PAT}"]',
    );
    expect(block.yaml).toContain(
      "/v1/projects/${SUPABASE_PROJECT_REF}/analytics/endpoints/logs.all",
    );
  });

  it("SQL no longer filters by function_id — per-function routing is in normalize", () => {
    // The consolidated source can't see all selected sources at
    // codegen time, so we drop the per-function WHERE clause and
    // let normalize filter via its UUID→slug map.
    const block = supabaseEdgeLogsDriver.generateSourceBlock({
      source: dummySource,
      connection: dummyConnection,
    });
    expect(block.yaml).not.toContain(
      encodeURIComponent("'6eda78cc-fc80-40f0-bd85-05ab0388842c'"),
    );
    expect(block.yaml).not.toContain(encodeURIComponent("function_id ="));
  });

  it("rejects sources missing function_id in metadata", () => {
    expect(() =>
      supabaseEdgeLogsDriver.generateSourceBlock({
        source: { ...dummySource, metadata: null },
        connection: dummyConnection,
      }),
    ).toThrow(/missing metadata.function_id/);
  });
});

describe("generateNormalize", () => {
  it("returns null when no inputs are wired", () => {
    expect(
      supabaseEdgeLogsDriver.generateNormalize!({
        inputKeys: [],
        connection: dummyConnection,
        sources: [],
      }),
    ).toBeNull();
  });

  it("emits unwrap + slug-map filter + per-record processing + fan-out", () => {
    const norm = supabaseEdgeLogsDriver.generateNormalize!({
      inputKeys: ["supabase_edge_con_x"],
      connection: dummyConnection,
      sources: [
        dummySource,
        {
          id: "src_b",
          externalId: "agent-thread",
          displayName: "agent-thread",
          sourceKind: "supabase_edge_fn",
          metadata: { function_id: "0ab47137-d31d-45b6-a31a-bf3c90b85d9a" },
        },
      ],
    });
    expect(norm?.key).toBe("supabase_edge_norm");
    const y = norm!.yaml;
    expect(y).toContain("type: remap");
    // Unwrap the Logflare envelope.
    expect(y).toContain("records = array(.result.result) ?? []");
    // Function-id → slug map (one entry per discovered source).
    expect(y).toContain('"6eda78cc-fc80-40f0-bd85-05ab0388842c"');
    expect(y).toContain('script = "agent-chat"');
    expect(y).toContain('"0ab47137-d31d-45b6-a31a-bf3c90b85d9a"');
    expect(y).toContain('script = "agent-thread"');
    // Default `script = ""` + the drop branch — the SQL pulls every
    // project event; normalize is responsible for skipping records
    // whose function_id isn't in the selected-source map.
    expect(y).toContain('script = ""');
    expect(y).toContain('if script == "" {');
    // Status-code derived level.
    expect(y).toContain("status >= 500");
    expect(y).toContain("status >= 400");
    // Microsecond → millisecond.
    expect(y).toContain("ts_us / 1000");
    // Fan-out at the end.
    expect(y).toContain(". = out");
    // [script] prefix so non-rollup monitors still ship tagged
    // bodies (same pattern as the other drivers).
    expect(y).toContain('"[" + script + "] " + body');
  });

  it("only emits slug entries for sources that carry a function_id", () => {
    const norm = supabaseEdgeLogsDriver.generateNormalize!({
      inputKeys: ["supabase_edge_con_x"],
      connection: dummyConnection,
      sources: [
        // No function_id — should be skipped in the lookup, not crash.
        { ...dummySource, metadata: null },
        // Valid one.
        {
          ...dummySource,
          externalId: "agent-two",
          metadata: { function_id: "0ab47137-d31d-45b6-a31a-bf3c90b85d9a" },
        },
      ],
    });
    expect(norm!.yaml).toContain("agent-two");
    expect(norm!.yaml).not.toContain('"agent-chat"');
  });
});

describe("runtimeSpec", () => {
  it("declares SUPABASE_PAT + SUPABASE_PROJECT_REF, no docker deps", () => {
    const spec = supabaseEdgeLogsDriver.runtimeSpec(dummyConnection);
    expect(spec.envVars.map((e) => e.name)).toEqual([
      "SUPABASE_PAT",
      "SUPABASE_PROJECT_REF",
    ]);
    expect(spec.dockerfileDeps).toEqual([]);
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
    expect(sources).toHaveLength(2);
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
    fetchSpy.mockRestore();
  });
});
