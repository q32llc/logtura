import { describe, expect, it, vi } from "vitest";
import { railwayLogsDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  externalAccountId: "env_test",
  displayName: "test railway",
};

const railwayService = (
  id: string,
  name = id,
  metadata: Record<string, unknown> | null = null,
) => ({
  id: `src_${id}`,
  externalId: id,
  displayName: name,
  sourceKind: "railway_service",
  metadata,
});

describe("railwayLogsDriver", () => {
  it("declares list-only selection", () => {
    expect(railwayLogsDriver.capabilities.selection).toBe("list");
  });

  it("emits one environment-level exec source and normalize transform", () => {
    const pipe = railwayLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          railwayService("svc_a", "api"),
          railwayService("svc_b", "worker"),
        ],
      },
    });
    const sources = pipe.components.filter((c) => c.kind === "source");
    const transforms = pipe.components.filter((c) => c.kind === "transform");
    expect(sources).toHaveLength(1);
    expect(transforms).toHaveLength(4);
    expect(sources[0]!.key).toBe("railway_con_x_env_test_tail");
    expect(sources[0]!.yaml).toContain(
      "exec bun /opt/logtura/assets/railway-logs/logtura-railway-tail.mjs",
    );
    expect(sources[0]!.yaml).toContain("include_stderr: false");
    expect(sources[0]!.yaml).toContain('"id":"svc_a"');
    expect(sources[0]!.yaml).toContain('"id":"svc_b"');
    expect(transforms[0]!.yaml).toContain(".attrs.level");
    expect(transforms[0]!.yaml).toContain(".error_reason");
    expect(transforms.map((c) => c.key)).toContain("railway_con_x_src_svc_a");
    expect(transforms.map((c) => c.key)).toContain("railway_con_x_src_svc_b");
    expect(pipe.outputKey).toBe("railway_con_x_by_service");
    expect(pipe.manifest?.find((m) => m.id === "railway_con_x_src_svc_a")?.links?.parentId).toBe(
      "railway_con_x_env_test_tail",
    );
    expect(pipe.envVars.map((env) => env.name)).toEqual([
      "RAILWAY_API_TOKEN",
    ]);
    expect(pipe.dockerfileDeps[0]?.directive).toBe(
      "COPY --from=oven/bun:1.3.3-debian /usr/local/bin/bun /usr/local/bin/bun",
    );
    expect(pipe.runtimeAssets?.[0]?.path).toBe("logtura-railway-tail.mjs");
    expect(pipe.runtimeAssets?.[0]?.content).toContain("environmentLogs");
    expect(pipe.runtimeAssets?.[0]?.content).toContain("anchorDate");
    expect(pipe.runtimeAssets?.[0]?.content).toContain("afterLimit");
    expect(pipe.runtimeAssets?.[0]?.content).toContain("tags {");
    expect(pipe.runtimeAssets?.[0]?.content).toContain("serviceId");
  });

  it("groups selected services by environment metadata", () => {
    const pipe = railwayLogsDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          railwayService("env_a:svc_a", "project/production/api", {
            environment_id: "env_a",
            service_id: "svc_a",
          }),
          railwayService("env_b:svc_a", "project/staging/api", {
            environment_id: "env_b",
            service_id: "svc_a",
          }),
        ],
      },
    });
    const sources = pipe.components.filter((c) => c.kind === "source");
    expect(sources.map((s) => s.key).sort()).toEqual([
      "railway_con_x_env_a_tail",
      "railway_con_x_env_b_tail",
    ]);
  });

  it("rejects all-selection, unknown source kinds, and unsafe ids", () => {
    expect(() =>
      railwayLogsDriver.generatePipeline({
        connection: dummyConnection,
        selection: { kind: "all" },
      }),
    ).toThrow(/does not support/);
    expect(() =>
      railwayLogsDriver.generatePipeline({
        connection: dummyConnection,
        selection: {
          kind: "list",
          sources: [{ ...railwayService("svc_a"), sourceKind: "not-railway" }],
        },
      }),
    ).toThrow(/Unknown Railway source kind/);
    expect(() =>
      railwayLogsDriver.generatePipeline({
        connection: dummyConnection,
        selection: {
          kind: "list",
          sources: [railwayService("svc_bad;rm")],
        },
      }),
    ).toThrow(/unsafe Railway service id/);
  });

  it("maps project environment service instances to discovered sources", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          data: {
            project: {
              id: "prj_test",
              name: "project",
              environments: {
                edges: [
                  {
                    node: {
                      id: "env_test",
                      name: "production",
                      serviceInstances: {
                        edges: [
                          {
                            node: {
                              serviceId: "svc_a",
                              serviceName: "api",
                              latestDeployment: {
                                id: "dep_a",
                                status: "SUCCESS",
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const sources = await railwayLogsDriver.discoverSources({
      credentials: { apiToken: "tok", projectId: "prj_test" },
      accountId: "",
    });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://backboard.railway.com/graphql/v2",
    );
    expect(sources).toEqual([
      {
        sourceKind: "railway_service",
        externalId: "env_test:svc_a",
        displayName: "project/production/api",
        metadata: {
          project_id: "prj_test",
          project_name: "project",
          environment_id: "env_test",
          environment_name: "production",
          service_id: "svc_a",
          service_name: "api",
          latest_deployment_id: "dep_a",
          latest_deployment_status: "SUCCESS",
        },
      },
    ]);
    fetchSpy.mockRestore();
  });
});
