import { describe, expect, it, vi } from "vitest";
import { vercelLogsDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  externalAccountId: "team_x",
  displayName: "test vercel",
};

const vercelProject = (id: string, name = id) => ({
  id: `src_${id}`,
  externalId: id,
  displayName: name,
  sourceKind: "vercel_project",
  metadata: null,
});

describe("vercelLogsDriver", () => {
  it("declares list-only selection", () => {
    expect(vercelLogsDriver.capabilities.selection).toBe("list");
  });

  it("emits one REST runtime-log exec source and per-project transforms", () => {
    const pipe = vercelLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          vercelProject("prj_test", "Test"),
          vercelProject("prj_other", "Other"),
        ],
      },
    });
    const sources = pipe.components.filter((c) => c.kind === "source");
    const transforms = pipe.components.filter((c) => c.kind === "transform");
    expect(sources).toHaveLength(1);
    expect(transforms).toHaveLength(4);
    expect(sources[0]!.key).toBe("vercel_con_x_tail");
    expect(sources[0]!.yaml).toContain(
      "exec bun /opt/logtura/assets/vercel-logs/logtura-vercel-tail.mjs",
    );
    expect(sources[0]!.yaml).toContain("include_stderr: false");
    expect(sources[0]!.yaml).toContain('"id":"prj_test"');
    expect(sources[0]!.yaml).toContain('"id":"prj_other"');
    expect(sources[0]!.yaml).not.toContain("/v6/deployments");
    expect(transforms[0]!.yaml).toContain(".error_reason");
    expect(transforms[0]!.yaml).toContain(".exceptions");
    expect(transforms.map((c) => c.key)).toContain("vercel_con_x_src_prj_test");
    expect(transforms.map((c) => c.key)).toContain("vercel_con_x_src_prj_other");
    expect(pipe.outputKey).toBe("vercel_con_x_by_project");
    expect(pipe.manifest?.find((m) => m.id === "vercel_con_x_src_prj_test")?.links?.parentId).toBe(
      "vercel_con_x_tail",
    );
    expect(pipe.envVars.map((env) => env.name)).toEqual([
      "VERCEL_API_TOKEN",
      "VERCEL_TEAM_ID",
    ]);
    expect(pipe.dockerfileDeps[0]?.directive).toBe(
      "COPY --from=oven/bun:1.3.3-debian /usr/local/bin/bun /usr/local/bin/bun",
    );
    expect(pipe.runtimeAssets?.[0]?.path).toBe("logtura-vercel-tail.mjs");
    expect(pipe.runtimeAssets?.[0]?.content).toContain("async function tailProject");
    expect(pipe.runtimeAssets?.[0]?.content).toContain("/v6/deployments");
    expect(pipe.runtimeAssets?.[0]?.content).toContain("/runtime-logs");
    expect(pipe.runtimeAssets?.[0]?.content).toContain(
      "await Promise.all(projects.map",
    );
    expect(pipe.runtimeAssets?.[0]?.content).toContain(
      "const HELPER_ERROR_COOLDOWN_MS = 5 * 60 * 1000",
    );
    expect(pipe.runtimeAssets?.[0]?.content).toContain(
      "helperErrorSuppressed",
    );
  });

  it("rejects all-selection and unsafe project ids", () => {
    expect(() =>
      vercelLogsDriver.generatePipeline({
        connection: dummyConnection,
        selection: { kind: "all" },
      }),
    ).toThrow(/does not support/);
    expect(() =>
      vercelLogsDriver.generatePipeline({
        connection: dummyConnection,
        selection: {
          kind: "list",
          sources: [vercelProject("prj_bad;rm")],
        },
      }),
    ).toThrow(/unsafe Vercel project id/);
  });

  it("allows personal-account tokens without a team id", () => {
    const pipe = vercelLogsDriver.generatePipeline({
      connection: { ...dummyConnection, externalAccountId: null },
      selection: { kind: "list", sources: [vercelProject("prj_test")] },
    });
    expect(pipe.components[0]?.yaml).toContain(
      "exec bun /opt/logtura/assets/vercel-logs/logtura-vercel-tail.mjs ''",
    );
    expect(String(pipe.runtimeAssets?.[0]?.content)).toContain(
      "if (teamId) url.searchParams.set(\"teamId\", teamId)",
    );
    expect(pipe.envVars.map((env) => env.name)).toEqual(["VERCEL_API_TOKEN"]);
  });

  it("maps Vercel projects to discovered sources", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          projects: [
            {
              id: "prj_a",
              name: "alpha",
              framework: "nextjs",
              updatedAt: 123,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const sources = await vercelLogsDriver.discoverSources({
      credentials: { apiToken: "tok" },
      accountId: "team_x",
    });
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/v9\/projects/);
    expect(sources).toEqual([
      {
        sourceKind: "vercel_project",
        externalId: "prj_a",
        displayName: "alpha",
        metadata: { framework: "nextjs", updated_at: 123 },
      },
    ]);
    fetchSpy.mockRestore();
  });
});
