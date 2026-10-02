import { afterEach, expect, it, vi } from "vitest";
import { railwayGraphql, railwayLogsDriver } from "../src/index";

afterEach(() => vi.restoreAllMocks());
const token = "fixture-account-token";
function graphql(responses: Record<string, unknown | Response>) {
  const requests: Array<{ operation: string; variables: Record<string, unknown>; headers: Headers }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    const operation = /query\s+(\w+)/.exec(body.query)?.[1];
    if (!operation || !(operation in responses)) throw new Error(`Unexpected query ${operation}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    requests.push({ operation, variables: body.variables, headers });
    const response = responses[operation];
    return response instanceof Response ? response.clone() : Response.json({ data: response });
  });
  return requests;
}
const scopedProject = { projectToken: { project: { id: "project", name: "Shop" }, environment: { id: "production", name: "Production" } } };
const project = { project: { id: "project", name: "Shop" } };
const environments = { project: { environments: { edges: [
  { node: { id: "production", name: "Production", serviceInstances: { edges: [
    { node: { serviceId: "api", serviceName: "API", latestDeployment: { id: "deploy", status: "SUCCESS" } } },
    { node: { serviceId: "worker" } }, { node: {} }, {},
  ] } } },
  { node: { id: "staging", serviceInstances: { edges: [{ node: { serviceId: "api" } }] } } },
  { node: {} }, {},
] } } };

it("reports permanent and OAuth credential freshness without provider traffic", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Forbidden traffic"));
  expect(await railwayLogsDriver.checkCredentialFreshness!({ apiToken: token })).toEqual({ fresh: true, expiresAt: null });
  expect(await railwayLogsDriver.checkCredentialFreshness!({ apiToken: token, refreshToken: "refresh", expiresAt: 123 })).toEqual({ fresh: true, expiresAt: 123 });
  expect(await railwayLogsDriver.checkCredentialFreshness!({ apiToken: token, refreshToken: "refresh" })).toEqual({ fresh: true, expiresAt: null });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["p_fixture", "project_fixture"])("verifies scoped token %s with its project header", async apiToken => {
  const requests = graphql({ ProjectToken: scopedProject });
  expect(await railwayLogsDriver.verifyCredentials({ apiToken })).toEqual([{ id: "production", name: "Shop · Production" }]);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get("project-access-token")).toBe(apiToken);
  expect(requests[0]!.headers.has("authorization")).toBe(false);
});
it.each([
  [{ projectToken: { project: { id: "project", name: "Shop" } } }, [{ id: "project", name: "Shop" }]],
  [{ projectToken: { project: { id: "project" }, environment: { id: "production", name: "Production" } } }, [{ id: "production", name: "project · Production" }]],
  [{ projectToken: { project: { id: "project" }, environment: { id: "production" } } }, [{ id: "production", name: "project" }]],
] as const)("uses available project/environment names for scoped account display", async (data, expected) => {
  graphql({ ProjectToken: data });
  expect(await railwayLogsDriver.verifyCredentials({ apiToken: "p_fixture" })).toEqual(expected);
});
it("verifies OAuth workspace projects, ignores incomplete entries and avoids the account-only query", async () => {
  const requests = graphql({ ProjectToken: new Response("unsupported", { status: 403 }), ExternalProjects: { externalWorkspaces: [{}, { projects: [{ id: "a", name: "A" }, {}, { id: "b" }] }] } });
  expect(await railwayLogsDriver.verifyCredentials({ apiToken: token })).toEqual([{ id: "a", name: "A" }, { id: "b", name: "b" }]);
  expect(requests.map(r => r.operation)).toEqual(["ProjectToken", "ExternalProjects"]);
  expect(requests.every(r => r.headers.get("authorization") === `Bearer ${token}`)).toBe(true);
});
it("falls back to account projects after unsupported scoped discovery", async () => {
  graphql({ ProjectToken: {}, ExternalProjects: new Response("unsupported", { status: 403 }), Projects: { projects: { edges: [{ node: { id: "a", name: "A" } }, {}, { node: {} }, { node: { id: "b" } }] } } });
  expect(await railwayLogsDriver.verifyCredentials({ apiToken: token })).toEqual([{ id: "a", name: "A" }, { id: "b", name: "b" }]);
});
it.each([{}, { projects: {} }, { projects: { edges: [{ node: {} }] } }])("refuses credentials with no visible project instead of selecting an unrelated scope", async data => {
  graphql({ ProjectToken: {}, ExternalProjects: {}, Projects: data });
  await expect(railwayLogsDriver.verifyCredentials({ apiToken: token })).rejects.toMatchObject({ status: 403, message: "Railway token has no visible projects" });
});
it("discovers the token-scoped environment with complete service identity and nullable deployment metadata", async () => {
  const requests = graphql({ ProjectTokenScope: scopedProject, Project: project, ProjectEnvironments: environments });
  const sources = await railwayLogsDriver.discoverSources({ credentials: { apiToken: "p_fixture" }, accountId: "" });
  expect(sources).toEqual([
    { sourceKind: "railway_service", externalId: "production:api", displayName: "Shop/Production/API", metadata: { project_id: "project", project_name: "Shop", environment_id: "production", environment_name: "Production", service_id: "api", service_name: "API", latest_deployment_id: "deploy", latest_deployment_status: "SUCCESS" } },
    { sourceKind: "railway_service", externalId: "production:worker", displayName: "Shop/Production/worker", metadata: { project_id: "project", project_name: "Shop", environment_id: "production", environment_name: "Production", service_id: "worker", service_name: "worker", latest_deployment_id: null, latest_deployment_status: null } },
  ]);
  expect(requests.map(r => [r.operation, r.variables])).toEqual([["ProjectTokenScope", {}], ["Project", { projectId: "project" }], ["ProjectEnvironments", { projectId: "project" }]]);
});
it.each([
  [{ projectId: "project", environmentId: "staging" }, "wrong:production"],
  [{}, "project:staging"],
  [{ projectId: "project" }, "staging"],
])("respects explicit credentials or the selected account rather than token defaults", async (scope, accountId) => {
  graphql({ ProjectTokenScope: scopedProject, Project: project, ProjectEnvironments: environments });
  expect((await railwayLogsDriver.discoverSources({ credentials: { apiToken: token, ...scope }, accountId })).map(s => [s.externalId, s.displayName])).toEqual([["staging:api", "Shop/staging/api"]]);
});
it("discovers all visible workspace environments when no environment was selected", async () => {
  const requests = graphql({ ProjectTokenScope: {}, ExternalProjects: { externalWorkspaces: [{}, { projects: [{ id: "project" }, {}] }] }, ProjectEnvironments: environments });
  const sources = await railwayLogsDriver.discoverSources({ credentials: { apiToken: token }, accountId: "" });
  expect(sources.map(s => s.externalId)).toEqual(["production:api", "production:worker", "staging:api"]);
  expect(sources[0]?.displayName).toBe("project/Production/API");
  expect(requests.map(r => r.operation)).toEqual(["ProjectTokenScope", "ExternalProjects", "ProjectEnvironments"]);
});
it("falls back to personal project enumeration and excludes incomplete projects", async () => {
  graphql({ ProjectTokenScope: new Response("unsupported", { status: 403 }), ExternalProjects: new Response("unsupported", { status: 403 }), Projects: { projects: { edges: [{}, { node: {} }, { node: { id: "project" } }] } }, ProjectEnvironments: environments });
  expect((await railwayLogsDriver.discoverSources({ credentials: { apiToken: token }, accountId: "" })).map(s => s.externalId)).toEqual(["production:api", "production:worker", "staging:api"]);
});
it.each([{}, { projects: {} }])("returns an empty source catalog for an account with no projects", async data => {
  graphql({ ProjectTokenScope: {}, ExternalProjects: {}, Projects: data });
  expect(await railwayLogsDriver.discoverSources({ credentials: { apiToken: token }, accountId: "" })).toEqual([]);
});
it("refuses an explicitly selected project that no longer exists", async () => {
  graphql({ ProjectTokenScope: {}, Project: {} });
  await expect(railwayLogsDriver.discoverSources({ credentials: { apiToken: token, projectId: "missing" }, accountId: "" })).rejects.toMatchObject({ status: 404 });
});
it.each([{}, { project: {} }, { project: { environments: { edges: [{ node: { id: "production" } }] } } }])("handles empty environment/service catalogs", async data => {
  graphql({ ProjectTokenScope: {}, Project: { project: { id: "project" } }, ProjectEnvironments: data });
  expect(await railwayLogsDriver.discoverSources({ credentials: { apiToken: token, projectId: "project" }, accountId: "" })).toEqual([]);
});
it.each([
  [new Response("upstream unavailable", { status: 503 }), { status: 503, message: "Railway GraphQL failed: 503 upstream unavailable" }],
  [Response.json({ errors: [{ message: "No scope" }, { message: "Expired" }] }), { status: 400, message: "Railway GraphQL errors: No scope; Expired" }],
  [Response.json({}), { status: 502, message: "Railway GraphQL returned no data" }],
] as const)("preserves HTTP, GraphQL and missing-data failures instead of reporting discovery success", async (response, expected) => {
  graphql({ Contract: response });
  await expect(railwayGraphql(token, "query Contract { fixture }", {})).rejects.toMatchObject(expected);
});
it("propagates malformed JSON and network failures", async () => {
  graphql({ Contract: new Response("malformed") });
  await expect(railwayGraphql(token, "query Contract { fixture }", {})).rejects.toBeInstanceOf(SyntaxError);
  vi.restoreAllMocks(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network fixture"));
  await expect(railwayGraphql(token, "query Contract { fixture }", {})).rejects.toThrow("Network fixture");
});

it("discovers all environments for a project token without an environment binding", async () => {
  graphql({ ProjectTokenScope: { projectToken: { project: { id: "project" } } }, Project: project, ProjectEnvironments: environments });
  expect((await railwayLogsDriver.discoverSources({ credentials: { apiToken: "p_fixture" }, accountId: "" })).map(s => s.externalId)).toEqual(["production:api", "production:worker", "staging:api"]);
});
it("retains workspace project names in discovered service labels", async () => {
  graphql({ ProjectTokenScope: {}, ExternalProjects: { externalWorkspaces: [{ projects: [{ id: "project", name: "Shop" }] }] }, ProjectEnvironments: environments });
  expect((await railwayLogsDriver.discoverSources({ credentials: { apiToken: token }, accountId: "" }))[0]?.displayName).toBe("Shop/Production/API");
});
