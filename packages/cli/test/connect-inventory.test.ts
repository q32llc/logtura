import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateBundle } from "@logtura/core";
import { main } from "../src/main";
import { loadConfigFile, readConfigDoc } from "../src/config";

const roots: string[] = [];
beforeEach(() => {
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "FLY_API_TOKEN", "RAILWAY_API_TOKEN", "VERCEL_API_TOKEN", "SUPABASE_PAT", "SUPABASE_PROJECT_REF", "LOGT_SERVICE_URL", "LOGT_SERVICE_TOKEN", "LOGT_CONFIG"]) vi.stubEnv(key, undefined);
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(doc: Record<string, unknown> = {}) { const root = mkdtempSync(join(tmpdir(), "logt-connect-inventory-")); roots.push(root); const path = join(root, "logt.yaml"); writeFileSync(path, JSON.stringify(doc)); return { path, root }; }
async function connect(path: string, provider: string, extra: string[] = []) { expect(await main(["-c", path, "connect", provider, "--name", "site", "--token", "fixture-secret", "--quiet", ...extra])).toBe(0); }
function privateFiles(root: string, path: string) { expect(readFileSync(path, "utf8")).not.toContain("fixture-secret"); expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600); expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain("fixture-secret"); }
function railway(projectToken = false) {
  const queries: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://backboard.railway.com/graphql/v2"); expect(new Headers(init?.headers).get(projectToken ? "project-access-token" : "authorization")).toBe(projectToken ? "p_fixture-secret" : "Bearer fixture-secret");
    const { query, variables } = JSON.parse(String(init?.body)), operation = /query\s+(\w+)/.exec(query)![1]!;
    queries.push({ operation, variables });
    if (operation === "ProjectToken" || operation === "ProjectTokenScope") return Response.json({ data: projectToken ? { projectToken: { project: { id: "project", name: "Shop" }, environment: { id: "production", name: "Production" } } } : {} });
    if (operation === "ExternalProjects") return Response.json({ data: { externalWorkspaces: [{ projects: [{ id: "project", name: "Shop" }] }] } });
    if (operation === "Project") { expect(variables).toEqual({ projectId: "project" }); return Response.json({ data: { project: { id: "project", name: "Shop" } } }); }
    if (operation === "ProjectEnvironments") { expect(variables).toEqual({ projectId: "project" }); return Response.json({ data: { project: { environments: { edges: ["production", "staging"].map(id => ({ node: { id, name: id, serviceInstances: { edges: [{ node: { serviceId: "api", serviceName: "API" } }] } } })) } } } }); }
    throw new Error(`Unexpected provider operation ${operation}`);
  });
  return queries;
}
it("connects Railway account inventory with usable project/environment identity and stable reconnect blocks", async () => {
  const { path, root } = project(); railway(); await connect(path, "railway"); await connect(path, "railway");
  const doc = readConfigDoc(path); expect(Object.keys(doc.sources as object)).toHaveLength(1);
  const parsed = loadConfigFile(path), connection = parsed.input.connections[0]!;
  expect(connection.connection.externalAccountId).toBe("project:");
  expect(connection.selectedSources.map(source => [source.externalId, source.metadata?.environment_id])).toEqual([["production:api", "production"], ["staging:api", "staging"]]);
  const yaml = generateBundle(parsed.input).vectorYaml; expect(yaml).toContain('== "production"'); expect(yaml).toContain('== "staging"'); privateFiles(root, path);
});
it("connects a Railway project-token environment without confusing its environment ID for a project ID", async () => {
  const { path } = project(); railway(true); await connect(path, "railway", ["--token", "p_fixture-secret"]);
  const connection = loadConfigFile(path).input.connections[0]!;
  expect(connection.connection.externalAccountId).toBe("project:production"); expect(connection.selectedSources.map(source => source.externalId)).toEqual(["production:api"]);
});
it("connects an explicitly selected Railway environment with the same public discovery driver", async () => {
  const { path } = project(); railway(); await connect(path, "railway", ["--account-id", "project:staging"]);
  expect(loadConfigFile(path).input.connections[0]!.selectedSources.map(source => source.externalId)).toEqual(["staging:api"]);
});
function vercel() {
  const requests: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input)); requests.push(url); expect(url.origin).toBe("https://api.vercel.com"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-secret");
    if (url.pathname === "/v2/user") return Response.json({ user: { uid: "user-id", username: "User" } });
    if (url.pathname === "/v9/projects") return Response.json({ projects: [{ id: "project", name: "Site" }] });
    throw new Error(`Unexpected provider URL ${url}`);
  });
  return requests;
}
it("connects Vercel personal inventory without a team ID and generates a standalone bundle", async () => {
  const { path, root } = project(); const requests = vercel(); await connect(path, "vercel");
  expect(requests.find(url => url.pathname === "/v9/projects")?.searchParams.has("teamId")).toBe(false);
  const parsed = loadConfigFile(path); expect(parsed.input.connections[0]!.connection.externalAccountId).toBeNull(); expect(parsed.input.connections[0]!.selectedSources.map(source => source.externalId)).toEqual(["project"]);
  expect(generateBundle(parsed.input).vectorYaml).toContain('"id":"project"'); privateFiles(root, path);
});
it("reconnects a Vercel team as personal scope without preserving obsolete account aliases or duplicating routes", async () => {
  const { path } = project(); const requests = vercel(); await connect(path, "vercel", ["--account-id", "team-id"]);
  expect(requests.find(url => url.pathname === "/v9/projects")?.searchParams.get("teamId")).toBe("team-id");
  const doc = readConfigDoc(path); const provider = (doc.providers as Record<string, Record<string, unknown>>).site!; provider.accountId = "obsolete-team"; provider.external_account_id = "obsolete-team"; writeFileSync(path, JSON.stringify(doc));
  await connect(path, "vercel"); expect(loadConfigFile(path).input.connections[0]!.connection.externalAccountId).toBeNull(); expect(Object.keys(readConfigDoc(path).sources as object)).toHaveLength(1);
});
it("connects Supabase functions with their runtime function IDs and exactly one gateway selection", async () => {
  const { path, root } = project();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe("https://api.supabase.com"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-secret");
    if (url.pathname === "/v1/projects") return Response.json([{ id: "project-id", ref: "project-ref", name: "Shop" }]);
    if (url.pathname === "/v1/projects/project-ref/functions") return Response.json([{ id: "function-id", slug: "api", name: "API" }]);
    throw new Error(`Unexpected provider URL ${url}`);
  });
  await connect(path, "supabase"); await connect(path, "supabase");
  const parsed = loadConfigFile(path), selected = parsed.input.connections[0]!.selectedSources;
  expect(selected).toHaveLength(2); expect(selected.find(source => source.externalId === "api")?.metadata?.function_id).toBe("function-id"); expect(selected.filter(source => source.externalId === "_gateway_")).toHaveLength(1);
  expect(Object.keys(readConfigDoc(path).sources as object)).toHaveLength(1); expect(generateBundle(parsed.input).vectorYaml).toContain("function-id"); privateFiles(root, path);
});
it("refuses portable graph setup without rewriting its identities or secret files", async () => {
  const { path, root } = project({ kind: "logtura.deployment", schema_version: 1, connections: [], monitors: [], runtimeEnv: null });
  const before = readFileSync(path, "utf8"), fetch = vi.spyOn(globalThis, "fetch"); expect(await main(["-c", path, "connect", "vercel", "--token", "fixture-secret", "--quiet"])).toBe(1); expect(fetch).not.toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(before);
  expect(() => readFileSync(join(root, ".env"))).toThrow();
});

it("preserves existing selections on a failed reconnect discovery instead of treating failure as an empty catalog", async () => {
  const { path } = project(); let discoveryFailed = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(String(input)); expect(url.origin).toBe("https://api.supabase.com");
    if (url.pathname === "/v1/projects") return Response.json([{ id: "project-id", ref: "project-ref", name: "Shop" }]);
    if (url.pathname === "/v1/projects/project-ref/functions") return discoveryFailed ? Response.json({ message: "Temporary provider outage" }, { status: 503 }) : Response.json([{ id: "function-id", slug: "api" }]);
    throw new Error(`Unexpected provider URL ${url}`);
  });
  await connect(path, "supabase"); const before = readConfigDoc(path).sources;
  discoveryFailed = true; await connect(path, "supabase"); expect(readConfigDoc(path).sources).toEqual(before); expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Temporary provider outage"));
});
it("reattaches a sole-provider Cloudflare source block without renaming it or adding a duplicate on reconnect", async () => {
  const { path, root } = project({ sources: { existing: { source: "cloudflare-worker-tail", scripts: ["old"], custom: "preserved" } } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe("https://api.cloudflare.com"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-secret");
    if (url.pathname === "/client/v4/user/tokens/verify") return Response.json({ success: true, result: { status: "active" } });
    if (url.pathname === "/client/v4/accounts") return Response.json({ success: true, result: [{ id: "account", name: "Account" }] });
    if (url.pathname === "/client/v4/accounts/account/workers/scripts") return Response.json({ success: true, result: [{ id: "api" }] });
    if (url.pathname === "/client/v4/accounts/account/ai-gateway/gateways") return Response.json({ success: true, result: [{ id: "gateway", name: "Gateway" }] });
    throw new Error(`Unexpected provider URL ${url}`);
  });
  await connect(path, "cloudflare", ["--all"]); await connect(path, "cloudflare");
  const sources = readConfigDoc(path).sources as Record<string, Record<string, unknown>>;
  expect(sources.existing).toEqual({ source: "cloudflare-worker-tail", scripts: ["api"], custom: "preserved", provider: "site" }); expect(Object.keys(sources)).toHaveLength(2);
  expect(loadConfigFile(path).input.connections.map(c => c.connection.provider).sort()).toEqual(["cloudflare-ai-gateway", "cloudflare-worker-tail"]); privateFiles(root, path);
});
it("does not write config or credentials when provider verification is rejected", async () => {
  const { path, root } = project(); const before = readFileSync(path, "utf8");
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    expect(String(input)).toBe("https://api.vercel.com/v2/user"); return new Response("Unauthorized fixture", { status: 401 });
  });
  expect(await main(["-c", path, "connect", "vercel", "--name", "site", "--token", "fixture-secret", "--quiet"])).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(before); expect(() => readFileSync(join(root, ".env"))).toThrow();
});
it("keeps a Vercel selection on denied project discovery while accepting its verified credentials", async () => {
  const { path } = project({ providers: { site: { provider: "vercel", credentials: { api_token: "env:VERCEL_API_TOKEN" } } }, sources: { selected: { source: "vercel-logs", provider: "site", projects: ["existing-project"] } } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(String(input)); expect(url.origin).toBe("https://api.vercel.com");
    if (url.pathname === "/v2/user") return Response.json({ user: { uid: "user", name: "User" } });
    if (url.pathname === "/v9/projects") return new Response("Projects unavailable fixture", { status: 403 });
    throw new Error(`Unexpected provider URL ${url}`);
  });
  await connect(path, "vercel"); expect(loadConfigFile(path).input.connections[0]!.selectedSources.map(source => source.externalId)).toEqual(["existing-project"]); expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Vercel request failed: 403")); expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("Projects unavailable fixture");
});
