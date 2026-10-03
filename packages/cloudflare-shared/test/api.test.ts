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
  it.each([401,403])("verifies account-owned tokens after user endpoint HTTP %i",async status=>{
    const account={id:'a'.repeat(32),name:'Owned account'};
    const fetch=vi.fn().mockResolvedValueOnce(response(null,status)).mockResolvedValueOnce(response([account])).mockResolvedValueOnce(response({status:'active'}));vi.stubGlobal('fetch',fetch);
    await expect(verifyCfCredentials({apiToken:'account-token'})).resolves.toEqual([account]);
    expect(fetch.mock.calls.map(([url])=>url)).toEqual([`${CF_BASE}/user/tokens/verify`,`${CF_BASE}/accounts?per_page=50`,`${CF_BASE}/accounts/${account.id}/tokens/verify`]);
    expect(fetch.mock.calls[0]![1].signal).toBe(fetch.mock.calls[2]![1].signal);
    expect(fetch.mock.calls[2]![1]).toMatchObject({redirect:'manual',headers:{authorization:'Bearer account-token'}});
  });
  it('skips inaccessible accounts and returns only the verified owner',async()=>{
    const accounts=[{id:'a'.repeat(32),name:'Foreign'},{id:'b'.repeat(32),name:'Owner'}];
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response(null,401)).mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(null,403)).mockResolvedValueOnce(response({status:'active'})));
    await expect(verifyCfCredentials({apiToken:'token'})).resolves.toEqual([accounts[1]]);
  });
  it.each([[],[{id:'a'.repeat(32),name:'Denied'}]].map(accounts=>({accounts})))('rejects account tokens without a verified owner %j',async ({accounts})=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response(null,401)).mockResolvedValueOnce(response(accounts)).mockResolvedValue(response(null,401)));
    await expect(verifyCfCredentials({apiToken:'token'})).rejects.toThrow('could not be verified');
  });
  it.each([null,Array(51).fill({id:'a'.repeat(32),name:'Owner'}),[{id:'bad',name:'Owner'}],[{id:'a'.repeat(32),name:123}]].map(accounts=>({accounts})))('rejects malformed or excessive fallback account inventory %j',async ({accounts})=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response(null,401)).mockResolvedValueOnce(response(accounts)));
    await expect(verifyCfCredentials({apiToken:'token'})).rejects.toMatchObject({status:502});
  });
  it.each([429,503])('does not turn account-verifier HTTP %i into an ownership probe retry',async status=>{
    const fetch=vi.fn().mockResolvedValueOnce(response(null,401)).mockResolvedValueOnce(response([{id:'a'.repeat(32),name:'Owner'}])).mockResolvedValueOnce(response(null,status));vi.stubGlobal('fetch',fetch);
    await expect(verifyCfCredentials({apiToken:'token'})).rejects.toMatchObject({status});expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([429,503])('does not probe accounts after user-verifier HTTP %i',async status=>{
    const fetch=vi.fn().mockResolvedValue(response(null,status));vi.stubGlobal('fetch',fetch);
    await expect(verifyCfCredentials({apiToken:'token'})).rejects.toMatchObject({status});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves network failures at the account verifier',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response(null,401)).mockResolvedValueOnce(response([{id:'a'.repeat(32),name:'Owner'}])).mockRejectedValueOnce(new Error('offline')));
    await expect(verifyCfCredentials({apiToken:'token'})).rejects.toThrow('offline');
  });
  it.each(['disabled','expired'])('rejects inactive %s tokens during connection verification',async status=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({status})));
    await expect(verifyCfCredentials({apiToken:'token'})).rejects.toMatchObject({status:401,message:`Token status: ${status}`});
  });
  it('preserves account-token expiry in freshness results',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response(null,401)).mockResolvedValueOnce(response([{id:'a'.repeat(32),name:'Owner'}])).mockResolvedValueOnce(response({status:'active',expires_on:'2026-10-01T12:00:00Z'})));
    await expect(checkCfCredentialFreshness({apiToken:'token'})).resolves.toEqual({fresh:false,reason:'expiring within 24 hours',expiresAt:Date.parse('2026-10-01T12:00:00Z')});
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
