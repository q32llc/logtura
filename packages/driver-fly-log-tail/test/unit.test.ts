/** Fast unit tests for the fly-log-tail driver. */
import { describe, expect, it, vi } from "vitest";
import { flyAuthHeader, flyLogTailDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  provider: "fly-log-tail",
  displayName: "test fly",
  externalAccountId: "personal",
};

describe("flyAuthHeader", () => {
  it("prefixes FlyV1 for macaroon tokens", () => {
    expect(flyAuthHeader("fm2_abc,fm2_def")).toBe("FlyV1 fm2_abc,fm2_def");
    expect(flyAuthHeader("fm1r_legacy")).toBe("FlyV1 fm1r_legacy");
  });

  it("prefixes Bearer for bare-bearer tokens", () => {
    expect(flyAuthHeader("plain-bearer-token")).toBe("Bearer plain-bearer-token");
  });
});

// parseFormData + connectFlow + formFields moved to the SaaS-side
// connect adapter (src/providers/connect/fly-log-tail.ts); see
// test/workerd/connect-adapters.test.ts for those tests.

describe("generateSourceBlock", () => {
  it("emits exec with stdbuf + jq pipeline + $$app escape", () => {
    const block = flyLogTailDriver.generateSourceBlock({
      source: {
        id: "src_a",
        externalId: "my-app",
        displayName: "my-app",
        sourceKind: "fly_app",
        metadata: null,
      },
      connection: dummyConnection,
    });
    expect(block.key).toBe("fly_app_my_app");
    expect(block.yaml).toContain("type: exec");
    expect(block.yaml).toContain("stdbuf -oL flyctl logs --json -a my-app");
    // --arg app + $$app escape (Vector pre-pass collapses $$ → $).
    expect(block.yaml).toContain("--arg app my-app");
    expect(block.yaml).toContain("$$app");
  });

  it("refuses shell-suspicious app names", () => {
    expect(() =>
      flyLogTailDriver.generateSourceBlock({
        source: {
          id: "src_a",
          externalId: "evil; rm -rf /",
          displayName: "evil",
          sourceKind: "fly_app",
          metadata: null,
        },
        connection: dummyConnection,
      }),
    ).toThrow(/unsafe fly app name/);
  });

  it("rejects unknown source kinds", () => {
    expect(() =>
      flyLogTailDriver.generateSourceBlock({
        source: {
          id: "src_a",
          externalId: "ok",
          displayName: "ok",
          sourceKind: "not-a-fly-app",
          metadata: null,
        },
        connection: dummyConnection,
      }),
    ).toThrow(/Unknown fly source kind/);
  });
});

describe("generateNormalize", () => {
  it("returns null when no inputs are wired", () => {
    expect(
      flyLogTailDriver.generateNormalize!({
        inputKeys: [],
        connection: dummyConnection,
        sources: [],
      }),
    ).toBeNull();
  });

  it("emits per-event level extraction across log libs", () => {
    const norm = flyLogTailDriver.generateNormalize!({
      inputKeys: ["fly_app_a"],
      connection: dummyConnection,
      sources: [],
    });
    expect(norm?.key).toBe("fly_app_norm");
    const y = norm!.yaml;
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
});

describe("runtimeSpec", () => {
  it("declares FLY_API_TOKEN env var and a flyctl docker dep", () => {
    const spec = flyLogTailDriver.runtimeSpec(dummyConnection);
    const names = spec.envVars.map((e) => e.name);
    expect(names).toEqual(["FLY_API_TOKEN"]);
    expect(spec.dockerfileDeps[0]?.install).toContain("fly.io/install.sh");
  });
});

describe("discoverSources", () => {
  it("maps /v1/apps?org_slug=… response to DiscoveredSource", async () => {
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
