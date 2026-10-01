import { afterEach, describe, expect, it, vi } from "vitest";
import { cfFetch, verifyCfCredentials, checkCfCredentialFreshness, cfRuntimeSpec, safeKey, shellQuoteCfWorkerName, CF_BASE } from "../src/index";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const response = (result: unknown, status = 200) => Response.json({ success: status === 200, result }, { status });
describe("Cloudflare credential contract", () => {
  it("verifies the token and returns accounts with bearer authentication", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ status: "active" })).mockResolvedValueOnce(response([{ id: "account", name: "Fixture" }]));
    vi.stubGlobal("fetch", fetch);
    await expect(verifyCfCredentials({ apiToken: "fixture-token" })).resolves.toEqual([{ id: "account", name: "Fixture" }]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${CF_BASE}/user/tokens/verify`, `${CF_BASE}/accounts?per_page=50`]);
    expect(fetch.mock.calls[0]![1].headers.authorization).toBe("Bearer fixture-token");
  });
  it("preserves request options and caller headers", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ id: "result" })); vi.stubGlobal("fetch", fetch);
    await expect(cfFetch("/fixture", "token", { method: "POST", body: "{}", headers: { "x-fixture": "yes" } })).resolves.toEqual({ id: "result" });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "{}", headers: { authorization: "Bearer token", "x-fixture": "yes", "content-type": "application/json" } });
  });
  it.each([401, 403, 429, 503])("surfaces HTTP %i with provider error details", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: false, errors: [{ message: "first" }, { message: "second" }] }, { status })));
    await expect(cfFetch("/fixture", "token")).rejects.toMatchObject({ message: "first; second", status });
  });
  it("rejects API-level failures even on HTTP 200 and handles absent error messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ success: false, errors: [{ message: "denied" }] })).mockResolvedValueOnce(Response.json({ success: false }, { status: 500 })));
    await expect(cfFetch("/fixture", "token")).rejects.toThrow("denied");
    await expect(cfFetch("/fixture", "token")).rejects.toThrow("HTTP 500");
  });
  it.each([
    [{ status: "active" }, { fresh: true, expiresAt: null }],
    [{ status: "disabled" }, { fresh: false, reason: "status: disabled", expiresAt: null }],
    [{ status: "active", expires_on: "2026-10-04T00:00:00Z" }, { fresh: true, expiresAt: Date.parse("2026-10-04T00:00:00Z") }],
    [{ status: "active", expires_on: "2026-10-01T12:00:00Z" }, { fresh: false, reason: "expiring within 24 hours", expiresAt: Date.parse("2026-10-01T12:00:00Z") }],
    [{ status: "active", expires_on: "2026-09-30T00:00:00Z" }, { fresh: false, reason: "expired", expiresAt: Date.parse("2026-09-30T00:00:00Z") }],
    [{ status: "active", expires_on: "1970-01-01T00:00:00Z" }, { fresh: false, reason: "expired", expiresAt: 0 }],
    [{ status: "active", expires_on: "invalid" }, { fresh: true, expiresAt: null }],
  ])("checks token status and expiry %j", async (info, expected) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(info)));
    await expect(checkCfCredentialFreshness({ apiToken: "token" })).resolves.toEqual(expected);
  });
  it.each([new Error("offline"), "offline"])("returns a stale result for verification failures", async (error) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    const result = await checkCfCredentialFreshness({ apiToken: "token" });
    expect(result).toEqual({ fresh: false, expiresAt: null, reason: error instanceof Error ? "verify failed: offline" : "verify failed" });
  });
  it("keeps runtime requirements portable and adds requested installation dependencies", () => {
    const base = cfRuntimeSpec({ helpUrl: "https://example.test/help" });
    expect(base.envVars.map((v) => v.name)).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
    expect(base.envVars[0]).toMatchObject({ credentialPath: "apiToken", helpUrl: "https://example.test/help" });
    expect(base.dockerfileDeps).toEqual([]);
    expect(cfRuntimeSpec({ helpUrl: "help", extraDockerInstall: "fixture install" }).dockerfileDeps[0]).toMatchObject({ install: "fixture install", aptPackages: ["curl", "ca-certificates", "gnupg", "jq"] });
  });
  it("sanitizes component keys and rejects shell-interpolated worker names", () => {
    expect(safeKey("worker.prod/a-b")).toBe("worker_prod_a_b");
    expect(shellQuoteCfWorkerName("worker-name_2")).toBe("worker-name_2");
    for (const value of ["bad name", "$(command)", "bad\nname", "'quoted'"]) expect(() => shellQuoteCfWorkerName(value)).toThrow(/suspicious/);
  });
});
