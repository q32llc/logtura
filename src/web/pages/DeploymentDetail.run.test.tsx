import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../api";
import type { ApiDeployment, ApiDeployTarget, ApiJob, ApiTargetBundle } from "../types";
import { DeploymentDetail } from "./DeploymentDetail";

const deployment: ApiDeployment = { id: "dep_run", connectionId: "con_fixture", displayName: "Run fixture", targetKind: "fly", managed: true, status: "running", externalId: null, sourceIds: [], monitorIds: [], heartbeatTarget: "none", metricsTarget: null, metricsSnapshot: null, bundleOutdated: false, createdAt: 0, updatedAt: 0, lastSeenAt: null };
const bundle: ApiTargetBundle = { target: { id: "fly", displayName: "Fly", supportsManaged: true }, files: [], envVars: [], selfDeployInstructions: "Run the forwarder", selectedCount: 0, monitorSummary: "No monitors", componentManifest: [] };
const target: ApiDeployTarget = { id: "target_personal", kind: "fly", displayName: "Fly account", externalAccountId: "personal", mintsForProviders: [], createdAt: 0, updatedAt: 0 };
function job(status: ApiJob["status"], extra: Partial<ApiJob> = {}): ApiJob {
  return { id: "job_deploy", kind: "fly_deploy", status, parentJobId: null, error: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null, result: null, progress: null, ...extra };
}
function page() {
  return render(<MantineProvider env="test"><MemoryRouter initialEntries={["/app/deployments/dep_run?tab=run"]}><Routes><Route path="/app/deployments/:id" element={<DeploymentDetail />} /></Routes></MemoryRouter></MantineProvider>);
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
beforeEach(() => {
  vi.spyOn(api, "getDeployment").mockResolvedValue({ deployment, latestDeployJob: null, connections: [] });
  vi.spyOn(api, "getDeploymentBundle").mockResolvedValue(bundle);
  vi.spyOn(api, "getDeploymentConfigurationState").mockResolvedValue({ desired: { sequence: 1, revision: `sha256:${"a".repeat(64)}`, configurationVersion: 1, document: { kind: "logtura.deployment", schema_version: 1, connections: [], monitors: [], runtimeEnv: null } }, applied: null, activeInstanceId: null, lastReportSequence: 0, stale: false });
  vi.spyOn(api, "listAllSources").mockResolvedValue({ sources: [], connections: [] });
  vi.spyOn(api, "listMonitors").mockResolvedValue({ monitors: [], sinks: [] });
  vi.spyOn(api, "listDestinations").mockResolvedValue({ destinations: [] });
  vi.spyOn(api, "listDeployTargets").mockResolvedValue({ deployTargets: [target] });
  vi.spyOn(api,"getManagedRollback").mockResolvedValue({configurationVersion:1,availableReplacementId:null,rollback:null});
  vi.spyOn(api, "deployNow").mockResolvedValue({ job: job("queued"), deduped: false });
  vi.spyOn(api, "getJob").mockResolvedValue({ job: job("succeeded") });
  vi.spyOn(api, "flyConnectStart").mockResolvedValue({ sessionId: "session_fixture", authUrl: "https://fly.io/authorize/fixture" });
  vi.spyOn(api, "flyConnectPoll").mockResolvedValue({ status: "pending" });
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => { vi.useRealTimers(); window.history.replaceState({}, "", "/"); });

it("submits one deploy to the personal Fly account and disables resubmission while queued", async () => {
  page(); const deploy = await screen.findByRole("button", { name: "Deploy now" });
  fireEvent.click(deploy); fireEvent.click(deploy);
  await screen.findByText("Queued");
  expect(api.deployNow).toHaveBeenCalledExactlyOnceWith("dep_run", { deployTargetId: "target_personal" });
  expect((deploy as HTMLButtonElement).disabled).toBe(true);
});
it.each(["queued", "running"] as const)("rehydrates the exact %s deploy after remount without enqueueing again", async status => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment, latestDeployJob: job(status, { id: "job_existing", progress: { label: "Creating machine", detail: "Region ord" } }), connections: [] });
  const first = page(); await screen.findByText("Creating machine"); first.unmount();
  vi.useFakeTimers(); page();
  await act(async () => {});
  expect(screen.getByText("Region ord")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Deploy now" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(api.getJob).mockResolvedValue({ job: job("succeeded", { id: "job_existing", result: { appName: "fixture-app", appUrl: "https://fixture-app.fly.dev", machineId: "machine_fixture", region: "ord" } }) });
  await tick();
  expect(api.getJob).toHaveBeenCalledExactlyOnceWith("job_existing");
  expect(api.deployNow).not.toHaveBeenCalled();
  expect(screen.getByText("Deployed to Fly: fixture-app")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open on fly.io" }).getAttribute("href")).toBe("https://fixture-app.fly.dev");
  expect(api.getDeployment).toHaveBeenCalledTimes(3);
  await tick(); await tick(); expect(api.getJob).toHaveBeenCalledTimes(1);
});
it("polls running progress until failure, then permits an explicit retry", async () => {
  page(); await screen.findByRole("button", { name: "Deploy now" }); vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Deploy now" })); await act(async () => {});
  vi.mocked(api.getJob).mockResolvedValueOnce({ job: job("running", { progress: { label: "Pushing image", detail: "Uploading layer" } }) }).mockResolvedValueOnce({ job: job("failed", { error: "Provider unavailable" }) });
  await tick(); expect(screen.getByText("Pushing image")).toBeTruthy(); expect(screen.getByText("Uploading layer")).toBeTruthy();
  await tick(); expect(screen.getByText("Deploy failed: Provider unavailable")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Deploy now" }) as HTMLButtonElement).disabled).toBe(false);
  await tick(); expect(api.getJob).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Deploy now" })); await act(async () => {});
  expect(api.deployNow).toHaveBeenCalledTimes(2); expect(screen.getByText("Queued")).toBeTruthy();
});
it.each([new ApiError("Deploy refused", 409, "conflict"), new Error("Private detail")])("shows a deployment submission failure and permits retry", async error => {
  vi.mocked(api.deployNow).mockRejectedValueOnce(error);
  page(); fireEvent.click(await screen.findByRole("button", { name: "Deploy now" }));
  await screen.findByText(error instanceof ApiError ? "Deploy refused" : "Failed to start deploy");
  expect(document.body.textContent).not.toContain("Private detail");
  fireEvent.click(screen.getByRole("button", { name: "Deploy now" })); await screen.findByText("Queued"); expect(api.deployNow).toHaveBeenCalledTimes(2);
});
it.each([new ApiError("Poll refused", 503, "unavailable"), new Error("Private detail")])("keeps the in-flight deploy locked when polling fails", async error => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment, latestDeployJob: job("running"), connections: [] });
  vi.mocked(api.getJob).mockRejectedValue(error);
  vi.useFakeTimers(); page(); await act(async () => {}); await tick();
  expect(screen.getByText(error instanceof ApiError ? "Poll refused" : "Job poll failed")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Deploy now" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.deployNow).not.toHaveBeenCalled();
});
it("cancels deploy polling when the page unmounts", async () => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment, latestDeployJob: job("running"), connections: [] });
  vi.useFakeTimers(); const view = page(); await act(async () => {}); expect(screen.getByText("Deploying…")).toBeTruthy(); view.unmount();
  await tick(); expect(api.getJob).not.toHaveBeenCalled();
});
it("offers authorization instead of selecting an organization's Fly target", async () => {
  vi.mocked(api.listDeployTargets).mockResolvedValue({ deployTargets: [{ ...target, externalAccountId: "organization" }] });
  page(); fireEvent.click(await screen.findByRole("button", { name: "Connect Fly" }));
  await screen.findByText(/Waiting for Fly approval/);
  expect(window.open).toHaveBeenCalledWith("https://fly.io/authorize/fixture", "_blank", "noopener,noreferrer");
  expect(screen.getByRole("link", { name: "Open Fly auth" }).getAttribute("href")).toBe("https://fly.io/authorize/fixture");
  expect(api.deployNow).not.toHaveBeenCalled();
});
it("polls pending Fly approval and refreshes targets after connection", async () => {
  vi.mocked(api.listDeployTargets).mockResolvedValueOnce({ deployTargets: [] }).mockResolvedValue({ deployTargets: [target] });
  page(); await screen.findByRole("button", { name: "Connect Fly" }); vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Connect Fly" })); await act(async () => {});
  await tick(); expect(api.flyConnectPoll).toHaveBeenCalledExactlyOnceWith("session_fixture");
  expect(screen.getByText(/Waiting for Fly approval/)).toBeTruthy();
  vi.mocked(api.flyConnectPoll).mockResolvedValue({ status: "connected", deployTargetId: target.id, displayName: "Fly account" });
  await tick(); expect(screen.getByText("Connected as Fly account")).toBeTruthy(); expect(screen.getByRole("button", { name: "Deploy now" })).toBeTruthy();
  await tick(); expect(api.flyConnectPoll).toHaveBeenCalledTimes(2); expect(api.deployNow).not.toHaveBeenCalled();
});
it("cancels Fly authorization without polling or changing deployment state", async () => {
  vi.mocked(api.listDeployTargets).mockResolvedValue({ deployTargets: [] });
  page(); await screen.findByRole("button", { name: "Connect Fly" }); vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Connect Fly" })); await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await tick();
  expect(api.flyConnectPoll).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Connect Fly" })).toBeTruthy();
});
it("ignores an authorization response arriving after cancellation", async () => {
  vi.mocked(api.listDeployTargets).mockResolvedValue({ deployTargets: [] });
  let finish!: (value: Awaited<ReturnType<typeof api.flyConnectPoll>>) => void;
  vi.mocked(api.flyConnectPoll).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  page(); await screen.findByRole("button", { name: "Connect Fly" }); vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Connect Fly" })); await act(async () => {}); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => { finish({ status: "connected", deployTargetId: target.id, displayName: "Fly account" }); });
  await tick();
  expect(api.listDeployTargets).toHaveBeenCalledTimes(1); expect(api.flyConnectPoll).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Connect Fly" })).toBeTruthy(); expect(screen.queryByText("Connected as Fly account")).toBeNull();
});
it("ignores deployment completion arriving after the page unmounts", async () => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment, latestDeployJob: job("running"), connections: [] });
  let finish!: (value: Awaited<ReturnType<typeof api.getJob>>) => void;
  vi.mocked(api.getJob).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers(); const view = page(); await act(async () => {}); await tick(); view.unmount();
  await act(async () => { finish({ job: job("succeeded") }); }); await tick();
  expect(api.getJob).toHaveBeenCalledTimes(1); expect(api.getDeployment).toHaveBeenCalledTimes(1);
});
it("follows the deduplicated job returned by the server", async () => {
  vi.mocked(api.deployNow).mockResolvedValue({ job: job("running", { id: "job_deduplicated" }), deduped: true });
  page(); await screen.findByRole("button", { name: "Deploy now" }); vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Deploy now" })); await act(async () => {}); await tick();
  expect(api.getJob).toHaveBeenCalledExactlyOnceWith("job_deduplicated"); expect(api.deployNow).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Redeploy" })).toBeTruthy();
});
it.each([new ApiError("Connect refused", 403, "forbidden"), new Error("Private detail")])("shows authorization-start errors and permits another attempt", async error => {
  vi.mocked(api.listDeployTargets).mockResolvedValue({ deployTargets: [] }); vi.mocked(api.flyConnectStart).mockRejectedValueOnce(error);
  page(); fireEvent.click(await screen.findByRole("button", { name: "Connect Fly" }));
  await screen.findByText(error instanceof ApiError ? "Connect refused" : "Failed to start connect");
  fireEvent.click(screen.getByRole("button", { name: "Connect Fly" })); await screen.findByText(/Waiting for Fly approval/);
  expect(api.flyConnectStart).toHaveBeenCalledTimes(2);
});
it.each([new ApiError("Authorization expired", 410, "expired"), new Error("Private detail")])("stops authorization polling on failure", async error => {
  vi.mocked(api.listDeployTargets).mockResolvedValue({ deployTargets: [] }); vi.mocked(api.flyConnectPoll).mockRejectedValue(error);
  page(); await screen.findByRole("button", { name: "Connect Fly" }); vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Connect Fly" })); await act(async () => {}); await tick();
  expect(screen.getByText(error instanceof ApiError ? "Authorization expired" : "Polling failed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect Fly" })).toBeTruthy(); await tick(); expect(api.flyConnectPoll).toHaveBeenCalledTimes(1);
});
it("allows reconnecting the personal account without starting a deployment", async () => {
  page(); fireEvent.click(await screen.findByRole("button", { name: "Reconnect Fly" }));
  await vi.waitFor(() => expect(api.flyConnectStart).toHaveBeenCalledTimes(1)); expect(api.deployNow).not.toHaveBeenCalled();
});
it.each(["other", "railway"])("keeps self-deploy available for the %s target", async kind => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, targetKind: kind }, latestDeployJob: null, connections: [] });
  page(); await screen.findByText(kind === "other" ? /You picked Other as the target/ : "Managed deploy for railway: coming next");
  expect(screen.getByRole("link", { name: "Download install bundle" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Deploy now" })).toBeNull(); expect(api.deployNow).not.toHaveBeenCalled();
});

it("consumes a redeploy link once after the personal target loads", async () => {
  window.history.replaceState({}, "", "/app/deployments/dep_run?action=deploy");
  page(); await screen.findByText("Queued");
  expect(api.deployNow).toHaveBeenCalledExactlyOnceWith("dep_run", { deployTargetId: target.id });
  expect(window.location.search).toBe("");
});
it("does not enqueue a redeploy link when the server rehydrates an active job", async () => {
  window.history.replaceState({}, "", "/app/deployments/dep_run?action=deploy");
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment, latestDeployJob: job("running"), connections: [] });
  page(); await screen.findByText("Deploying…"); await screen.findByRole("button", { name: "Reconnect Fly" });
  expect(api.deployNow).not.toHaveBeenCalled();
});
it("keeps a redeploy link from using an organization account", async () => {
  window.history.replaceState({}, "", "/app/deployments/dep_run?action=deploy");
  vi.mocked(api.listDeployTargets).mockResolvedValue({ deployTargets: [{ ...target, externalAccountId: "organization" }] });
  page(); await screen.findByRole("button", { name: "Connect Fly" }); expect(api.deployNow).not.toHaveBeenCalled();
});
it.each([new ApiError("Targets unavailable", 503, "unavailable"), new Error("Private detail")])("shows target catalog failures without submitting a deploy", async error => {
  vi.mocked(api.listDeployTargets).mockRejectedValue(error); page();
  await screen.findByText(error instanceof ApiError ? "Targets unavailable" : "Failed to load"); expect(api.deployNow).not.toHaveBeenCalled();
});
it("signs an install command for this deployment and enables a new URL only after expiry", async () => {
  const expiresAt = Date.now() + 4000;
  vi.spyOn(api, "signInstallBundle").mockResolvedValue({ url: "https://logtura.example/install?signature=fixture", expiresAt });
  page(); await screen.findByRole("button", { name: "Generate install one-liner" }); vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Generate install one-liner" })); await act(async () => {});
  expect(api.signInstallBundle).toHaveBeenCalledExactlyOnceWith("dep_run");
  expect(screen.getByText("curl -fsSL 'https://logtura.example/install?signature=fixture' -o logtura.tgz && tar xzf logtura.tgz && cd logtura-* && ./install.sh")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Regenerate one-liner" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(screen.getByText("Link expired. Click Regenerate.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Generate install one-liner" })); await act(async () => {});
  expect(api.signInstallBundle).toHaveBeenCalledTimes(2);
});
it.each([new ApiError("Signing refused", 403, "forbidden"), new Error("Private detail")])("shows install signing failures and permits retry", async error => {
  vi.spyOn(api, "signInstallBundle").mockRejectedValueOnce(error).mockResolvedValue({ url: "https://logtura.example/install", expiresAt: Date.now() + 60000 });
  page(); fireEvent.click(await screen.findByRole("button", { name: "Generate install one-liner" }));
  await screen.findByText(error instanceof ApiError ? "Signing refused" : "Could not sign URL");
  fireEvent.click(screen.getByRole("button", { name: "Generate install one-liner" })); await screen.findByText(/curl -fsSL/);
  expect(api.signInstallBundle).toHaveBeenCalledTimes(2);
});
