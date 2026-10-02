import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as cp from "node:child_process";
import * as cf from "@logtura/cloudflare-shared";
import { cloudflareWorkerTailDriver } from "@logtura/driver-cloudflare-worker-tail";
import { cloudflareAiGatewayDriver } from "@logtura/driver-cloudflare-ai-gateway";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { railwayLogsDriver } from "@logtura/driver-railway-logs";
import { vercelLogsDriver } from "@logtura/driver-vercel-logs";
import { supabaseEdgeLogsDriver } from "@logtura/driver-supabase-edge-logs";
import * as prompt from "../src/prompt";
import { getProviderConnector, type ConnectOptions } from "../src/provider-connectors";
vi.mock("node:child_process", { spy: true });
vi.mock("@logtura/cloudflare-shared", { spy: true });
vi.mock("../src/prompt", () => ({ ask: vi.fn(), askSecret: vi.fn(), confirm: vi.fn(), openBrowser: vi.fn() }));
beforeEach(() => {
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "FLY_API_TOKEN", "FLY_ORG", "RAILWAY_API_TOKEN", "VERCEL_API_TOKEN", "SUPABASE_PAT"]) vi.stubEnv(key, undefined);
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(prompt.ask).mockResolvedValue(""); vi.mocked(prompt.askSecret).mockResolvedValue(""); vi.mocked(prompt.confirm).mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });
const item = { externalId: "api", displayName: "API", sourceKind: "cf_worker", metadata: null };
function cloudflare() {
  const verify = vi.mocked(cf.verifyCfCredentials).mockResolvedValue([{ id: "account", name: "Cloudflare account" }]);
  const workers = vi.spyOn(cloudflareWorkerTailDriver, "discoverSources").mockResolvedValue([item]);
  const gateways = vi.spyOn(cloudflareAiGatewayDriver, "discoverSources").mockResolvedValue([]);
  return { verify, workers, gateways };
}
const connect = (provider: string, options: ConnectOptions = {}, values: Record<string, string> = {}) => getProviderConnector(provider)!.connect({ name: "local", options, env: { values: new Map(Object.entries(values)) } });
it("returns no connector for an unknown provider", () => expect(getProviderConnector("unknown")).toBeNull());
it("verifies and discovers Cloudflare locally without browser or prompt in quiet mode", async () => {
  const mocks = cloudflare();
  expect(await connect("cloudflare", { token: "explicit", quiet: true })).toMatchObject({ provider: "cloudflare", providerName: "local", displayName: "Cloudflare account", accountId: "account", envValues: { CLOUDFLARE_API_TOKEN: "explicit", CLOUDFLARE_ACCOUNT_ID: "account" }, sources: [{ source: "cloudflare-worker-tail", items: [item] }, { source: "cloudflare-ai-gateway", items: [] }] });
  expect(mocks.verify).toHaveBeenCalledWith({ apiToken: "explicit" }); expect(mocks.workers).toHaveBeenCalledWith({ credentials: { apiToken: "explicit" }, accountId: "account" });
  expect(prompt.askSecret).not.toHaveBeenCalled(); expect(prompt.openBrowser).not.toHaveBeenCalled();
});
it("keeps a declined replacement token and permits a forced quiet replacement", async () => {
  const mocks = cloudflare(); vi.mocked(prompt.confirm).mockResolvedValueOnce(false);
  expect((await connect("cloudflare", { token: "replacement" }, { CLOUDFLARE_API_TOKEN: "existing" })).envValues.CLOUDFLARE_API_TOKEN).toBe("existing");
  await expect(connect("cloudflare", { token: "replacement", quiet: true }, { CLOUDFLARE_API_TOKEN: "existing" })).rejects.toThrow("pass --force");
  expect(mocks.verify).toHaveBeenCalledTimes(1);
  expect((await connect("cloudflare", { token: "replacement", quiet: true, force: true }, { CLOUDFLARE_API_TOKEN: "existing" })).envValues.CLOUDFLARE_API_TOKEN).toBe("replacement");
});
it("accepts a confirmed replacement and reuses local credentials with their selected account", async () => {
  cloudflare();
  expect((await connect("cloudflare", { token: "replacement" }, { CLOUDFLARE_API_TOKEN: "existing" })).envValues.CLOUDFLARE_API_TOKEN).toBe("replacement");
  expect((await connect("cloudflare", { quiet: true }, { CLOUDFLARE_API_TOKEN: "existing", CLOUDFLARE_ACCOUNT_ID: "local-account" })).accountId).toBe("local-account");
  expect((await connect("cloudflare", {}, { CLOUDFLARE_API_TOKEN: "existing" })).envValues.CLOUDFLARE_API_TOKEN).toBe("existing");
});
it("uses process credentials and explicitly selected accounts", async () => {
  cloudflare(); vi.stubEnv("CLOUDFLARE_API_TOKEN", "process-token");
  expect((await connect("cloudflare", { quiet: true, accountId: "explicit-account" })).envValues).toEqual({ CLOUDFLARE_API_TOKEN: "process-token", CLOUDFLARE_ACCOUNT_ID: "explicit-account" });
});
it("opens a permission-scoped token page and trims a hidden paste after declining local credentials", async () => {
  cloudflare(); vi.mocked(prompt.confirm).mockResolvedValueOnce(false); vi.mocked(prompt.askSecret).mockResolvedValueOnce("  pasted  ");
  const groups = [{ key: "workers_tail", type: "read" }, { key: "workers_tail", type: "read" }, { key: "workers_scripts", type: "edit" }, null, { key: 1, type: "read" }, { key: "invalid", type: "write" }];
  expect((await connect("cloudflare", { metadata: { permissionGroups: groups } }, { CLOUDFLARE_API_TOKEN: "existing" })).envValues.CLOUDFLARE_API_TOKEN).toBe("pasted");
  const url = new URL(vi.mocked(prompt.openBrowser).mock.calls[0]![0]);
  expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([{ key: "workers_tail", type: "read" }, { key: "workers_scripts", type: "edit" }]);
});
it.each([undefined, { permissionGroups: "invalid" }, { permissionGroups: [] }])("uses the default Cloudflare permission template for missing metadata", async metadata => {
  cloudflare(); vi.mocked(prompt.askSecret).mockResolvedValueOnce("pasted"); await connect("cloudflare", { metadata });
  const url = new URL(vi.mocked(prompt.openBrowser).mock.calls[0]![0]); expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toHaveLength(3);
});
it("skips an empty paste without verifying or discovering and rejects missing quiet credentials", async () => {
  const mocks = cloudflare(); expect(await connect("cloudflare")).toEqual({ skipped: true, provider: "cloudflare", providerName: "local", displayName: "local", accountId: null, envValues: {}, sources: [] });
  await expect(connect("cloudflare", { quiet: true })).rejects.toThrow("CLOUDFLARE_API_TOKEN is missing"); expect(mocks.verify).not.toHaveBeenCalled();
});
it("propagates prompt errors and verification failures", async () => {
  cloudflare(); vi.mocked(prompt.askSecret).mockRejectedValueOnce(new Error("cancelled")); await expect(connect("cloudflare")).rejects.toThrow("cancelled");
  vi.mocked(cf.verifyCfCredentials).mockRejectedValueOnce(new Error("Invalid token")); await expect(connect("cloudflare", { token: "bad" })).rejects.toThrow("Invalid token");
});
it("chooses an interactive account and applies the default selection for blank or invalid input", async () => {
  const mocks = cloudflare(); mocks.verify.mockResolvedValue([{ id: "first", name: "First" }, { id: "second", name: "Second" }]);
  vi.mocked(prompt.ask).mockResolvedValueOnce("2"); expect((await connect("cloudflare", { token: "token" })).accountId).toBe("second");
  vi.mocked(prompt.ask).mockResolvedValueOnce("nonsense"); expect((await connect("cloudflare", { token: "token" })).accountId).toBe("first");
  expect((await connect("cloudflare", { token: "token" })).accountId).toBe("first");
  expect((await connect("cloudflare", { token: "token", quiet: true })).accountId).toBe("first");
  mocks.verify.mockResolvedValueOnce([]); await expect(connect("cloudflare", { token: "token" })).rejects.toThrow("no accounts");
});
it("keeps independent source catalogs usable when one discovery fails", async () => {
  const mocks = cloudflare(); mocks.gateways.mockRejectedValueOnce(new Error("Gateway permission missing"));
  expect((await connect("cloudflare", { token: "token" })).sources[0]?.items).toEqual([item]); expect(console.warn).toHaveBeenCalledWith("could not discover cloudflare-ai-gateway: Gateway permission missing");
  mocks.workers.mockRejectedValueOnce("worker failure"); await connect("cloudflare", { token: "token" }); expect(console.warn).toHaveBeenCalledWith("could not discover cloudflare-worker-tail: worker failure");
});
it("uses Fly local credentials, explicit organization and safely handles failed app discovery", async () => {
  vi.spyOn(flyLogTailDriver, "verifyCredentials").mockResolvedValue([{ id: "personal", name: "Personal" }]); const discover = vi.spyOn(flyLogTailDriver, "discoverSources").mockResolvedValue([]);
  expect((await connect("fly", { token: "explicit", accountId: "organization" })).accountId).toBe("organization");
  expect((await connect("fly", { quiet: true }, { FLY_API_TOKEN: "local", FLY_ORG: "personal" })).envValues).toEqual({ FLY_API_TOKEN: "local" });
  discover.mockRejectedValueOnce(new Error("No app access")); expect((await connect("fly", { token: "explicit" })).sources[0]?.items).toEqual([]);
});
it("uses the Fly CLI token when available and skips or fails when it is unavailable", async () => {
  vi.spyOn(flyLogTailDriver, "verifyCredentials").mockResolvedValue([{ id: "personal", name: "Personal" }]); vi.spyOn(flyLogTailDriver, "discoverSources").mockResolvedValue([]);
  const spawn = vi.mocked(cp.spawnSync).mockReturnValue({ status: 0, stdout: "  cli-token\n", stderr: "", pid: 1, output: [], signal: null } as unknown as ReturnType<typeof cp.spawnSync>);
  expect((await connect("fly")).envValues.FLY_API_TOKEN).toBe("cli-token"); expect(spawn).toHaveBeenCalledWith("fly", ["auth", "token"], { encoding: "utf8" });
  spawn.mockReturnValueOnce({ status: 0, stdout: "\n" } as unknown as ReturnType<typeof cp.spawnSync>); expect((await connect("fly")).skipped).toBe(true);
  spawn.mockReturnValue({ status: 1 } as ReturnType<typeof cp.spawnSync>); await expect(connect("fly", { quiet: true })).rejects.toThrow("Fly token missing"); expect((await connect("fly")).skipped).toBe(true);
});
it("discovers Vercel personal projects without treating the user identity as a team", async () => {
  vi.spyOn(vercelLogsDriver, "verifyCredentials").mockResolvedValue([{ id: "user", name: "User" }]); const discover = vi.spyOn(vercelLogsDriver, "discoverSources").mockResolvedValue([]);
  expect((await connect("vercel", { token: "token", quiet: true })).accountId).toBeNull(); expect(discover).toHaveBeenCalledWith({ credentials: { apiToken: "token" }, accountId: "" });
  expect((await connect("vercel", { token: "token", quiet: true, accountId: "team" })).accountId).toBe("team"); expect(discover).toHaveBeenLastCalledWith({ credentials: { apiToken: "token" }, accountId: "team" });
});
it("discovers Supabase functions for the selected project and uses the PAT variable", async () => {
  vi.spyOn(supabaseEdgeLogsDriver, "verifyCredentials").mockResolvedValue([{ id: "project", name: "Project" }]); const discover = vi.spyOn(supabaseEdgeLogsDriver, "discoverSources").mockResolvedValue([]);
  expect((await connect("supabase", { quiet: true }, { SUPABASE_PAT: "pat" })).envValues).toEqual({ SUPABASE_PAT: "pat" }); expect(discover).toHaveBeenCalledWith({ credentials: { pat: "pat" }, accountId: "project" });
});
it("skips a missing simple-provider paste and propagates simple-provider acquisition errors", async () => {
  expect((await connect("supabase")).skipped).toBe(true); expect(prompt.openBrowser).toHaveBeenCalledWith("https://supabase.com/dashboard/account/tokens");
  await expect(connect("supabase", { quiet: true })).rejects.toThrow("SUPABASE_PAT is missing");
});
it("preserves explicit Railway project/environment scope without an extra resolution query", async () => {
  vi.spyOn(railwayLogsDriver, "verifyCredentials").mockResolvedValue([{ id: "project", name: "Project" }]); const discover = vi.spyOn(railwayLogsDriver, "discoverSources").mockResolvedValue([]);
  expect((await connect("railway", { token: "token", accountId: "project:environment" })).accountId).toBe("project:environment"); expect(discover).toHaveBeenCalledWith({ credentials: { apiToken: "token" }, accountId: "project:environment" });
});
it("applies the same replacement protection to Fly and accepts process credentials without its CLI", async () => {
  vi.spyOn(flyLogTailDriver, "verifyCredentials").mockResolvedValue([{ id: "personal", name: "Personal" }]); vi.spyOn(flyLogTailDriver, "discoverSources").mockResolvedValue([]);
  await expect(connect("fly", { token: "new", quiet: true }, { FLY_API_TOKEN: "old" })).rejects.toThrow("pass --force");
  expect((await connect("fly", { token: "new", quiet: true, force: true }, { FLY_API_TOKEN: "old" })).envValues.FLY_API_TOKEN).toBe("new");
  vi.mocked(prompt.confirm).mockResolvedValueOnce(false); expect((await connect("fly", { token: "new" }, { FLY_API_TOKEN: "old" })).envValues.FLY_API_TOKEN).toBe("old");
  vi.stubEnv("FLY_API_TOKEN", "process-token"); expect((await connect("fly", { quiet: true })).envValues.FLY_API_TOKEN).toBe("process-token");
  vi.mocked(prompt.confirm).mockResolvedValueOnce(false); expect((await connect("fly")).skipped).toBe(true);
});
