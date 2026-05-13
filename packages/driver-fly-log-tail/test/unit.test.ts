/** Fast unit tests for the fly-log-tail driver. */
import { describe, expect, it, vi } from "vitest";
import { flyAuthHeader, flyLogTailDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  externalAccountId: "personal",
  displayName: "test fly",
};

const flyAppSource = (id: string, name: string) => ({
  id,
  externalId: name,
  displayName: name,
  sourceKind: "fly_app" as const,
  metadata: null,
});

describe("flyAuthHeader", () => {
  it("prefixes FlyV1 for macaroon tokens", () => {
    expect(flyAuthHeader("fm2_abc,fm2_def")).toBe("FlyV1 fm2_abc,fm2_def");
    expect(flyAuthHeader("fm1r_legacy")).toBe("FlyV1 fm1r_legacy");
  });

  it("prefixes Bearer for bare-bearer tokens", () => {
    expect(flyAuthHeader("plain-bearer-token")).toBe(
      "Bearer plain-bearer-token",
    );
  });
});

// parseFormData + connectFlow + formFields are intentionally outside
// the driver; the CLI passes explicit credentials.

describe("capabilities", () => {
  it("declares list-only selection (per-app flyctl)", () => {
    expect(flyLogTailDriver.capabilities.selection).toBe("list");
  });
});

describe("generatePipeline", () => {
  it("rejects all-selection (per-app driver)", () => {
    expect(() =>
      flyLogTailDriver.generatePipeline({
        connection: dummyConnection,
        selection: { kind: "all" },
      }),
    ).toThrow(/does not support "all"/);
  });

  it("emits one exec source per app + a normalize transform", () => {
    const pipe = flyLogTailDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [flyAppSource("src_a", "my-app"), flyAppSource("src_b", "other-app")],
      },
    });
    const sources = pipe.components.filter((c) => c.kind === "source");
    const transforms = pipe.components.filter((c) => c.kind === "transform");
    expect(sources).toHaveLength(2);
    expect(transforms).toHaveLength(1);
    expect(pipe.outputKey).toBe(transforms[0]!.key);
    // Per-app source keys are connection-scoped so two fly
    // connections with same-named apps don't collide.
    expect(sources[0]!.key).toBe("fly_con_x_my_app");
    expect(sources[1]!.key).toBe("fly_con_x_other_app");
    // First source's YAML carries the exec stdbuf + jq pipeline
    // + $$app escape (Vector pre-pass collapses $$ to $).
    expect(sources[0]!.yaml).toContain("type: exec");
    expect(sources[0]!.yaml).toContain(
      "stdbuf -oL flyctl logs --json -a my-app",
    );
    expect(sources[0]!.yaml).toContain("--arg app my-app");
    expect(sources[0]!.yaml).toContain("$$app");
  });

  it("refuses shell-suspicious app names", () => {
    expect(() =>
      flyLogTailDriver.generatePipeline({
        connection: dummyConnection,
        selection: {
          kind: "list",
          sources: [flyAppSource("src_a", "evil; rm -rf /")],
        },
      }),
    ).toThrow(/unsafe fly app name/);
  });

  it("rejects unknown source kinds", () => {
    expect(() =>
      flyLogTailDriver.generatePipeline({
        connection: dummyConnection,
        selection: {
          kind: "list",
          sources: [{ ...flyAppSource("src_a", "ok"), sourceKind: "not-fly" }],
        },
      }),
    ).toThrow(/Unknown fly source kind/);
  });

  it("normalize remap parses structured log levels across libs", () => {
    const pipe = flyLogTailDriver.generatePipeline({
      connection: dummyConnection,
      selection: { kind: "list", sources: [flyAppSource("src_a", "my-app")] },
    });
    const norm = pipe.components.find((c) => c.kind === "transform")!;
    const y = norm.yaml;
    expect(y).toContain("type: remap");
    // Tries pino/winston/zap (`level`), GCP (`severity`), legacy
    // Go (`lvl`) before falling back to Fly's stream.
    expect(y).toContain("parsed.level");
    expect(y).toContain("parsed.severity");
    expect(y).toContain("parsed.lvl");
    // Numeric pino scheme.
    expect(y).toContain("n >= 30");
    // [app] prefix at the source side so non-rollup monitors tag too.
    expect(y).toContain('"[" + .script + "] "');
  });

  it("declares FLY_API_TOKEN env var and a flyctl docker dep", () => {
    const pipe = flyLogTailDriver.generatePipeline({
      connection: dummyConnection,
      selection: { kind: "list", sources: [flyAppSource("src_a", "my-app")] },
    });
    expect(pipe.envVars.map((e) => e.name)).toEqual(["FLY_API_TOKEN"]);
    expect(pipe.dockerfileDeps[0]?.install).toContain("fly.io/install.sh");
  });

  it("manifest echoes Source.id for component linking", () => {
    const pipe = flyLogTailDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [flyAppSource("src_chosen", "my-app")],
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
  it("maps /v1/apps?org_slug=... response to DiscoveredSource", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          apps: [
            { name: "alpha", machine_count: 3 },
            { name: "beta" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const sources = await flyLogTailDriver.discoverSources({
      credentials: { apiToken: "fm2_test" },
      accountId: "my-org",
    });
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://api.machines.dev/v1/apps?org_slug=my-org",
    );
    expect(sources).toEqual([
      {
        sourceKind: "fly_app",
        externalId: "alpha",
        displayName: "alpha",
        metadata: { machine_count: 3 },
      },
      {
        sourceKind: "fly_app",
        externalId: "beta",
        displayName: "beta",
        metadata: { machine_count: null },
      },
    ]);
    fetchSpy.mockRestore();
  });
});
