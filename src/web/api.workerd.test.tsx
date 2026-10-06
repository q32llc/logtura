// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { startLocalService } from "../../test/e2e/local-workerd";
import { api } from "./api";

let service: Awaited<ReturnType<typeof startLocalService>>;
const nativeFetch = globalThis.fetch;
beforeAll(async () => { service = await startLocalService({ flyAuthorization: true }); }, 60_000);
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (typeof input !== "string" || !input.startsWith("/api/")) return nativeFetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("cookie", service.cookie); headers.set("origin", service.url); headers.set("connection", "close");
    return nativeFetch(new URL(input, service.url), { ...init, headers });
  });
});
afterAll(async () => {
  if (!service) return;
  try { expect(service.unexpected).toEqual([]); }
  finally { await service.service.dispose(); }
});
function connectionForm() { const form = new FormData(); form.set("provider", "cloudflare-worker-tail"); form.set("display_name", "API contract account"); form.set("api_token", "fixture-private-provider-token"); return form; }

it("reads the account and public driver catalogs through the real session-authenticated backend", async () => {
  expect((await api.me()).user?.id).toBe(service.userId);
  expect((await api.providers()).providers.some(provider => provider.id === "cloudflare-worker-tail")).toBe(true);
  expect((await api.destinationDrivers()).drivers.some(driver => driver.id === "webhook")).toBe(true);
  expect((await api.deployTargetDrivers()).drivers.some(driver => driver.id === "fly")).toBe(true);
  expect((await api.listDeployTargets()).deployTargets).toEqual([]);
  expect((await api.cliTokens()).tokens).toEqual([]);
});
it("creates, reads, reconnects and removes a provider account through multipart requests", async () => {
  const { connection } = await api.createConnection(connectionForm());
  try {
    expect((await api.listConnections()).connections.map(item => item.id)).toContain(connection.id);
    expect((await api.getConnection(connection.id)).connection.displayName).toBe("API contract account");
    expect((await api.getConnectionByProviderInstallation("vercel-logs", "unknown /?&installation")).connection).toBeNull();
    expect((await api.reconnectConnection(connection.id, connectionForm())).connection.id).toBe(connection.id);
    expect((await api.listAllSources()).connections.map(item => item.id)).toContain(connection.id);
    await expect(api.listSupabaseProjects(connection.id)).rejects.toMatchObject({ status: 400, code: "wrong_provider" });
    await expect(api.pickSupabaseProject(connection.id, "project-fixture")).rejects.toMatchObject({ status: 400, code: "wrong_provider" });
    await expect(api.listRailwayEnvironments(connection.id)).rejects.toMatchObject({ status: 400, code: "wrong_provider" });
    await expect(api.pickRailwayEnvironment(connection.id, { projectId: "project-fixture", environmentId: "env-fixture" })).rejects.toMatchObject({ status: 400, code: "wrong_provider" });
    await expect(api.createConnectionFromBootstrap({ deployTargetId: "missing", providerId: "cloudflare-worker-tail", displayName: "Refused" })).rejects.toMatchObject({ status: 404, code: "bootstrap_not_found" });
  } finally { await api.deleteConnection(connection.id); }
  expect((await api.listConnections()).connections).toEqual([]);
});
it("reattaches to and deduplicates real queued discovery while a provider request is held", async () => {
  const { connection } = await api.createConnection(connectionForm());
  const release = service.holdDiscovery();
  try {
    const { job } = await api.rediscover(connection.id);
    expect((await api.getJob(job.id)).job.id).toBe(job.id);
    const again = await api.rediscover(connection.id);
    expect(again.deduped).toBe(true); expect(again.job.id).toBe(job.id);
    expect((await api.getConnection(connection.id)).latestDiscoveryJob?.id).toBe(job.id);
  } finally { release(); await api.deleteConnection(connection.id); }
});
it("creates and updates monitor routing with an encrypted destination, then deletes its owned graph", async () => {
  const form = new FormData(); form.set("kind", "webhook"); form.set("display_name", "API contract webhook"); form.set("url", "https://webhook.example.invalid/private-fixture");
  const { destination } = await api.createDestination(form);
  const { monitor } = await api.createMonitor({ displayName: "API contract monitor", enabled: true, connectionId: null, filterSteps: [{ kind: "errors" }] });
  try {
    expect((await api.listDestinations()).destinations.map(item => item.id)).toContain(destination.id);
    expect((await api.updateMonitor(monitor.id, { displayName: "Updated monitor", enabled: false })).monitor).toMatchObject({ id: monitor.id, displayName: "Updated monitor", enabled: false });
    const { sink } = await api.addSink(monitor.id, { destinationId: destination.id, filterSteps: [{ kind: "dedup", window_secs: 60 }] });
    await api.updateSinkSteps(sink.id, [{ kind: "sample", rate: 0.5 }]);
    const routing = await api.listMonitors();
    expect(routing.sinks.find(item => item.id === sink.id)?.filterSteps).toEqual([{ kind: "sample", rate: 0.5 }]);
    await api.deleteSink(sink.id); expect((await api.listMonitors()).sinks.some(item => item.id === sink.id)).toBe(false);
  } finally { await api.deleteMonitor(monitor.id); await api.deleteDestination(destination.id); }
});
it("preserves an existing deployment identity through configuration, bundle, signing and deletion", async () => {
  const { connection } = await api.createConnection(connectionForm());
  const { deployment } = await api.createDeployment({ connectionId: connection.id, displayName: "API contract forwarder", targetKind: "other", sourceIds: [], monitorIds: [], heartbeatTarget: "none" });
  try {
    expect((await api.listDeployments()).deployments.map(item => item.id)).toContain(deployment.id);
    expect((await api.listDeploymentsForConnection(connection.id)).deployments.map(item => item.id)).toContain(deployment.id);
    expect((await api.getDeployment(deployment.id)).deployment.id).toBe(deployment.id);
    expect(await api.getDeploymentConfigurationState(deployment.id)).toBeNull();
    expect((await api.updateDeployment(deployment.id, { displayName: "Updated forwarder", metricsTarget: "logtura" })).deployment).toMatchObject({ id: deployment.id, displayName: "Updated forwarder", metricsTarget: "logtura" });
    expect((await api.getDeploymentBundle(deployment.id)).files.some(file => file.name === "vector.yaml")).toBe(true);
    expect((await api.getDeploymentBundle(deployment.id, "fly", "ord")).target.id).toBe("fly");
    const signed = await api.signInstallBundle(deployment.id); expect(new URL(signed.url).origin).toBe(service.url); expect(signed.expiresAt).toBeGreaterThan(Date.now());
    expect((await api.markDeploymentDeployed(deployment.id)).deployment?.bundleOutdated).toBe(false);
    await expect(api.deployNow(deployment.id, { deployTargetId: "missing", region: "ord" })).rejects.toMatchObject({ status: 404 });
  } finally { await api.deleteDeployment(deployment.id); await api.deleteConnection(connection.id); }
  expect((await api.listDeployments()).deployments).toEqual([]);
});
it("refuses path traversal and unknown CLI approvals through real HTTP rather than selecting another resource", async () => {
  await expect(api.getConnection("../../me")).rejects.toMatchObject({ status: 404 });
  await expect(api.cliDevice("UNKNOWN /?CODE")).rejects.toMatchObject({ status: 404 });
  await expect(api.decideCliDevice("UNKNOWN /?CODE", true)).rejects.toMatchObject({ status: 409, code: "not_found_or_decided" });
  expect(await api.revokeCliToken("UNKNOWN /?TOKEN")).toEqual({ ok: true });
});
it("starts the Fly authorization fixture and refuses polling without its signed flow cookie", async () => {
  const started = await api.flyConnectStart();
  expect(started).toEqual({ sessionId: "fixture-fly-session", authUrl: "https://fly.io/authorize/fixture-fly-session" });
  await expect(api.flyConnectPoll(started.sessionId)).rejects.toMatchObject({ status: 400, code: "session_mismatch" });
});

it("retains and revokes a real CLI client through the browser API and native D1",async()=>{
  const started=await nativeFetch(`${service.url}/api/cli/device/start`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({label:"Local production smoke fixture"})});expect(started.status).toBe(200);
  const device=await started.json() as {deviceCode:string;userCode:string};await api.decideCliDevice(device.userCode,true);
  const issued=await nativeFetch(`${service.url}/api/cli/device/poll`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceCode:device.deviceCode})});expect(issued.status).toBe(200);
  const row=(await api.cliTokens()).tokens.find(token=>token.label==="Local production smoke fixture");expect(row).toBeTruthy();
  expect(await api.persistCliToken(row!.id)).toEqual({expiresAt:253402300799999,scope:"account:read account:write"});expect((await api.cliTokens()).tokens.find(token=>token.id===row!.id)?.expires_at).toBe(253402300799999);
  await api.revokeCliToken(row!.id);await expect(api.persistCliToken(row!.id)).rejects.toMatchObject({status:404,code:"active_token_not_found"});
});
