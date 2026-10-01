import { afterEach, expect, it, vi } from "vitest";
import { sbFetch, listSupabaseProjects, verifySupabaseCredentials, sbRuntimeSpec, safeKey, SB_BASE } from "../src/index";
afterEach(() => vi.unstubAllGlobals());
it("returns project refs as accounts and authenticates Management API requests", async () => {
  const projects = [{ id: "internal-id", ref: "project-ref", name: "Fixture" }];
  const fetch = vi.fn().mockImplementation(async () => Response.json(projects)); vi.stubGlobal("fetch", fetch);
  await expect(listSupabaseProjects("token")).resolves.toEqual(projects);
  await expect(verifySupabaseCredentials({ pat: "token" })).resolves.toEqual([{ id: "project-ref", name: "Fixture" }]);
  expect(fetch.mock.calls[0]).toMatchObject([`${SB_BASE}/v1/projects`, { headers: { authorization: "Bearer token", accept: "application/json" } }]);
});
it("rejects credentials with no accessible projects", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
  await expect(verifySupabaseCredentials({ pat: "token" })).rejects.toMatchObject({ status: 403, message: "Supabase PAT has no visible projects" });
});
it.each([
  [{ message: "denied" }, "denied"], [{ error: "bad token" }, "bad token"], [{}, "HTTP 403"],
])("surfaces provider error response %j", async (body, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status: 403 })));
  await expect(sbFetch("/fixture", "token")).rejects.toMatchObject({ status: 403, message });
});
it("bounds non-JSON errors and handles empty errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("x".repeat(250), { status: 503 })).mockResolvedValueOnce(new Response("", { status: 500 })));
  await expect(sbFetch("/fixture", "token")).rejects.toThrow("x".repeat(200));
  await expect(sbFetch("/fixture", "token")).rejects.toThrow("HTTP 500");
});
it("passes method and headers through without replacing bearer authorization", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true })); vi.stubGlobal("fetch", fetch);
  await expect(sbFetch("/fixture", "token", { method: "POST", body: "{}", headers: { "x-fixture": "yes" } })).resolves.toEqual({ ok: true });
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "{}", headers: { authorization: "Bearer token", "x-fixture": "yes" } });
});
it("declares standalone runtime credentials and optional extra variables", () => {
  const base = sbRuntimeSpec({ helpUrl: "https://example.test/help" });
  expect(base.envVars.map((v) => v.name)).toEqual(["SUPABASE_PAT", "SUPABASE_PROJECT_REF"]);
  expect(base.dockerfileDeps).toEqual([]);
  expect(sbRuntimeSpec({ helpUrl: "help", extraEnvVars: [{ name: "EXTRA", description: "fixture", source: "credential" }] }).envVars.map((v) => v.name)).toEqual(["SUPABASE_PAT", "SUPABASE_PROJECT_REF", "EXTRA"]);
  expect(safeKey("project/a.b-c")).toBe("project_a_b_c");
});
