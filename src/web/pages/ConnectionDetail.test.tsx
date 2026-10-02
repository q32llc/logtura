import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../api";
import type { ApiConnection, ApiDeployment, ApiDestination, ApiJob, ApiProvider, ApiSource } from "../types";
import { ConnectionDetail } from "./ConnectionDetail";
const connection: ApiConnection = { id: "con_one", provider: "cloudflare-worker-tail", displayName: "Production", externalAccountId: "fixture-account", providerInstallationId: null, createdAt: 0, updatedAt: 0, lastDiscoveredAt: null };
const provider: ApiProvider = { id: connection.provider, displayName: "Cloudflare", connectFlow: { kind: "external_token", url: "https://example.com/tokens", buttonLabel: "Authorize Cloudflare", buttonDescription: "Create a scoped token", pasteFieldName: "token", manualInstructions: "Open token settings" }, formFields: [{ name: "token", label: "API token", type: "password", required: true }, { name: "account", label: "Account ID", type: "text", required: false }] };
const destination: ApiDestination = { id: "dst_one", kind: "webhook", displayName: "Webhook", flows: ["logs"], createdAt: 0, updatedAt: 0 };
function source(id: string, kind = "Worker"): ApiSource { return { id, sourceKind: kind.toLowerCase(), sourceKindLabel: kind, externalId: id, displayName: id, metadata: null, selected: true, discoveredAt: 0 }; }
function deployment(overrides: Partial<ApiDeployment> = {}): ApiDeployment { return { id: "dep_one", connectionId: connection.id, targetKind: "fly", displayName: "Forwarder", managed: false, status: "running", externalId: null, sourceIds: null, monitorIds: null, heartbeatTarget: "logtura", metricsTarget: null, metricsSnapshot: null, bundleOutdated: false, createdAt: 0, updatedAt: 0, lastSeenAt: null, ...overrides }; }
function job(overrides: Partial<ApiJob> = {}): ApiJob { return { id: "job_one", kind: "discovery", status: "queued", parentJobId: null, error: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null, result: null, progress: null, ...overrides }; }
function Location() { return <output aria-label="Current route">{useLocation().pathname}</output>; }
function page() { return render(<MantineProvider env="test"><MemoryRouter initialEntries={["/app/connections/con_one"]}><Routes><Route path="/app/connections/:id" element={<ConnectionDetail />} /><Route path="*" element={<Location />} /></Routes></MemoryRouter></MantineProvider>); }
function load(sources: ApiSource[] = [], latestDiscoveryJob: ApiJob | null = null, overrides: Partial<ApiConnection> = {}) { vi.mocked(api.getConnection).mockResolvedValue({ connection: { ...connection, ...overrides }, sources, latestDiscoveryJob }); }
beforeEach(() => {
  vi.spyOn(notifications, "show").mockReturnValue("notification"); vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "getConnection").mockResolvedValue({ connection, sources: [], latestDiscoveryJob: null });
  vi.spyOn(api, "listDeploymentsForConnection").mockResolvedValue({ deployments: [] });
  vi.spyOn(api, "providers").mockResolvedValue({ providers: [provider] });
  vi.spyOn(api, "listDestinations").mockResolvedValue({ destinations: [] });
  vi.spyOn(api, "rediscover").mockResolvedValue({ job: job(), deduped: false });
  vi.spyOn(api, "deleteConnection").mockResolvedValue({ ok: true });
  vi.spyOn(api, "reconnectConnection").mockResolvedValue({ connection });
});
afterEach(() => vi.useRealTimers());
it("shows the account, empty discovery guidance and disabled deployment action", async () => {
  page(); await screen.findByRole("heading", { name: "Production" }); expect(screen.getByText("No sources discovered yet.")).toBeTruthy();
  expect(screen.getByText(/account fixture-account/)).toBeTruthy(); expect(screen.getByText(/No deployments yet/)).toBeTruthy();
  expect(screen.getByText("New deployment").closest("a")?.getAttribute("data-disabled")).toBe("true");
});
it("filters by source name or kind and offers destination setup without selecting sources on the connection", async () => {
  load([source("API-one"), source("API-two"), source("Logs", "Gateway")]); const user = userEvent.setup(); page(); await screen.findByRole("heading", { name: "Production" });
  expect(screen.getByRole("link", { name: "Set up a destination" }).getAttribute("href")).toBe("/app/destinations");
  expect(screen.getByRole("link", { name: "New deployment" }).getAttribute("href")).toBe("/app/connections/con_one/deploy");
  expect(screen.getByText("2 Workers")).toBeTruthy(); expect(screen.getByText("1 Gateway")).toBeTruthy();
  const filter = screen.getByPlaceholderText("Filter…"); await user.type(filter, "  api  "); expect(screen.getByText("Showing 2 of 3")).toBeTruthy(); expect(screen.queryByText("Logs")).toBeNull();
  await user.clear(filter); await user.type(filter, "gateway"); expect(screen.getByText("Logs")).toBeTruthy(); expect(screen.getByText("Showing 1 of 3")).toBeTruthy();
  await user.clear(filter); await user.type(filter, "missing"); expect(screen.getByText("No sources match this filter.")).toBeTruthy();
});
it("reports one ready source when a destination exists", async () => {
  load([source("Only worker")], null, { externalAccountId: null }); vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [destination] }); page();
  await screen.findByText("1 source ready to forward."); expect(screen.queryByRole("link", { name: "Set up a destination" })).toBeNull();
  expect(screen.getByText(/account —/)).toBeTruthy();
});
it.each([new ApiError("Connection not found", 404), "unexpected"])("reports initial connection loading failures", async error => {
  vi.mocked(api.getConnection).mockRejectedValue(error); page(); expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed to load");
});
it("keeps discovery usable when optional destination or provider metadata is missing", async () => {
  vi.mocked(api.listDestinations).mockRejectedValue(new Error("Unavailable")); vi.mocked(api.providers).mockResolvedValue({ providers: [] }); page(); await screen.findByRole("heading", { name: "Production" });
  await userEvent.click(screen.getByRole("button", { name: "Reconnect" })); const dialog = within(await screen.findByRole("dialog", { name: "Reconnect" }));
  expect((dialog.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(true);
});
it.each([false, true])("queues discovery and explains whether it was deduplicated (%s)", async deduped => {
  vi.mocked(api.rediscover).mockResolvedValue({ job: job(), deduped }); page(); await screen.findByRole("heading", { name: "Production" }); await userEvent.click(screen.getByRole("button", { name: "Re-discover" }));
  expect(api.rediscover).toHaveBeenCalledWith(connection.id); await screen.findByText("Discovery queued");
  expect(notifications.show).toHaveBeenCalledWith({ message: deduped ? "Discovery is already running" : "Discovery queued", color: "teal" });
  expect((screen.getByRole("button", { name: "Discovering…" }) as HTMLButtonElement).disabled).toBe(true);
});
it.each([new ApiError("Queue unavailable", 503), "unexpected"])("allows rediscovery retry after an enqueue failure", async error => {
  vi.mocked(api.rediscover).mockRejectedValue(error); page(); await screen.findByRole("heading", { name: "Production" }); await userEvent.click(screen.getByRole("button", { name: "Re-discover" }));
  await waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ message: error instanceof ApiError ? error.message : "Could not queue discovery", color: "red" }));
  expect((screen.getByRole("button", { name: "Re-discover" }) as HTMLButtonElement).disabled).toBe(false);
});
it.each(["queued", "running"] as const)("rehydrates %s discovery on mount and stops polling when it completes", async status => {
  vi.useFakeTimers(); load([], job({ status })); const first = page(); await act(async () => { await Promise.resolve(); });
  expect(screen.getByText(status === "queued" ? "Discovery queued" : "Discovery running")).toBeTruthy();
  expect(api.rediscover).not.toHaveBeenCalled(); first.unmount(); const callsBeforeRemount = vi.mocked(api.getConnection).mock.calls.length;
  page(); await act(async () => { await Promise.resolve(); }); expect(vi.mocked(api.getConnection).mock.calls.length).toBeGreaterThan(callsBeforeRemount);
  load([source("Discovered")]); await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText("Discovered")).toBeTruthy(); expect(screen.getByRole("button", { name: "Re-discover" })).toBeTruthy();
  const calls = vi.mocked(api.getConnection).mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(api.getConnection).toHaveBeenCalledTimes(calls);
});
it.each(["scope missing", null])("renders a failed discovery and its retry guidance (%s)", async error => {
  load([], job({ status: "failed", error })); page(); expect((await screen.findByRole("alert")).textContent).toContain(error ?? "Unknown error.");
  expect(screen.getByText("Last discovery failed")).toBeTruthy(); expect(screen.getByRole("button", { name: "Re-discover" })).toBeTruthy();
});
it.each([1, 2, null])("renders completed discovery counts without continuing polling (%s)", async sourceCount => {
  vi.spyOn(Date, "now").mockReturnValue(10_000); load([], job({ status: "succeeded", completedAt: 9000, result: sourceCount === null ? null : { sourceCount } })); page();
  await screen.findByText("Last discovery succeeded"); expect(screen.getByText(sourceCount === null ? "Completed just now." : `Found ${sourceCount} source${sourceCount === 1 ? "" : "s"} just now.`)).toBeTruthy();
});
it("omits a terminal job banner without a completion timestamp", async () => {
  load([], job({ status: "succeeded" })); page(); await screen.findByRole("heading", { name: "Production" }); expect(screen.queryByRole("alert")).toBeNull();
});
it("requires connection deletion confirmation and returns to the account dashboard", async () => {
  const user = userEvent.setup(); page(); await screen.findByRole("heading", { name: "Production" }); vi.mocked(window.confirm).mockReturnValueOnce(false);
  await user.click(screen.getByRole("button", { name: "Delete" })); expect(api.deleteConnection).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete" })); await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/app"));
  expect(window.confirm).toHaveBeenCalledWith("Delete this connection? Deployments using it will be removed too."); expect(api.deleteConnection).toHaveBeenCalledWith(connection.id);
});
it.each([new ApiError("Deletion refused", 409), "unexpected"])("retains connection controls after failed deletion", async error => {
  vi.mocked(api.deleteConnection).mockRejectedValue(error); page(); await screen.findByRole("heading", { name: "Production" }); await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ message: error instanceof ApiError ? error.message : "Failed to delete", color: "red" }));
  expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
});
it("reveals reconnect credentials through manual instructions and resets cancelled private drafts", async () => {
  const user = userEvent.setup(); page(); await screen.findByRole("heading", { name: "Production" }); await user.click(screen.getByRole("button", { name: "Reconnect" })); let dialog = within(await screen.findByRole("dialog"));
  expect(dialog.queryByLabelText(/^API token/)).toBeNull(); await user.click(dialog.getByRole("button", { name: "Or create the token manually" }));
  await user.type(dialog.getByLabelText(/^API token/), "discarded-fixture-token"); await user.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(api.reconnectConnection).not.toHaveBeenCalled(); await user.click(screen.getByRole("button", { name: "Reconnect" })); dialog = within(await screen.findByRole("dialog"));
  expect(dialog.queryByLabelText(/^API token/)).toBeNull(); await user.click(dialog.getByRole("button", { name: "Or create the token manually" }));
  expect((dialog.getByLabelText(/^API token/) as HTMLInputElement).value).toBe("");
});
it("reconnects the existing identity with newly typed fields and refreshes discovery", async () => {
  const user = userEvent.setup(); page(); await screen.findByRole("heading", { name: "Production" }); await user.click(screen.getByRole("button", { name: "Reconnect" })); const dialog = within(await screen.findByRole("dialog"));
  await user.click(dialog.getByRole("link", { name: "Authorize Cloudflare" }));
  await user.type(dialog.getByLabelText(/^API token/), "replacement-fixture-token"); await user.type(dialog.getByRole("textbox", { name: "Account ID" }), "replacement-account");
  await user.click(dialog.getByRole("button", { name: "Reconnect" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const [id, form] = vi.mocked(api.reconnectConnection).mock.calls[0]!; expect(id).toBe(connection.id); expect(Object.fromEntries(form.entries())).toEqual({ token: "replacement-fixture-token", account: "replacement-account" });
  expect(notifications.show).toHaveBeenCalledWith({ message: "Reconnected — re-discovering sources", color: "teal" });
});
it.each([new ApiError("Token rejected", 401), "unexpected"])("retains failed reconnection input for retry", async error => {
  vi.mocked(api.reconnectConnection).mockRejectedValueOnce(error); const user = userEvent.setup(); page(); await screen.findByRole("heading", { name: "Production" }); await user.click(screen.getByRole("button", { name: "Reconnect" })); const dialog = within(await screen.findByRole("dialog"));
  await user.click(dialog.getByRole("button", { name: "Or create the token manually" })); await user.type(dialog.getByLabelText(/^API token/), "fixture-token"); await user.click(dialog.getByRole("button", { name: "Reconnect" }));
  expect((await dialog.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Could not reconnect — check the new token's scopes");
  expect((dialog.getByLabelText(/^API token/) as HTMLInputElement).value).toBe("fixture-token"); await user.click(dialog.getByRole("button", { name: "Reconnect" })); await waitFor(() => expect(api.reconnectConnection).toHaveBeenCalledTimes(2));
});
it("offers a scoped OAuth reconnect alongside raw token fallback", async () => {
  vi.mocked(api.providers).mockResolvedValue({ providers: [{ ...provider, oauthShortcut: { startPath: "/api/oauth/start", buttonLabel: "Authorize account", buttonDescription: "Reconnect through OAuth" } }] }); page(); await screen.findByRole("heading", { name: "Production" }); await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  const dialog = within(await screen.findByRole("dialog")); expect(dialog.getByRole("link", { name: "Authorize account" }).getAttribute("href")).toBe("/api/oauth/start?reconnect_id=con_one");
});
it("shows direct reconnect fields for providers without a guided flow", async () => {
  vi.mocked(api.providers).mockResolvedValue({ providers: [{ ...provider, connectFlow: null }] }); page(); await screen.findByRole("heading", { name: "Production" }); await userEvent.click(screen.getByRole("button", { name: "Reconnect" })); expect(within(await screen.findByRole("dialog")).getByLabelText(/^API token/)).toBeTruthy();
});
it("summarizes deployment status, topology, timestamps and metrics with navigation", async () => {
  const now = Date.UTC(2026, 9, 2, 12); vi.spyOn(Date, "now").mockReturnValue(now);
  const times = [null, now - 10_000, now - 120_000, now - 7_200_000, now - 172_800_000];
  vi.mocked(api.listDeploymentsForConnection).mockResolvedValue({ deployments: ["running", "crashed", "stopped", "detached", "pending"].map((status, index) => deployment({ id: `dep_${index}`, displayName: `Forwarder ${index}`, status: status as ApiDeployment["status"], lastSeenAt: times[index]!, managed: index === 0, bundleOutdated: index === 0, sourceIds: index === 0 ? null : index === 1 ? ["one"] : ["one", "two"], monitorIds: index === 0 ? null : index === 1 ? ["monitor"] : [], metricsTarget: index === 0 ? "logtura" : null })) });
  page(); await screen.findByText("Forwarder 0"); expect(screen.getByText("redeploy needed")).toBeTruthy(); expect(screen.getByText("managed")).toBeTruthy();
  for (let index = 0; index < 5; index++) expect(screen.getByRole("link", { name: new RegExp(`Forwarder ${index}`) }).getAttribute("href")).toBe(`/app/deployments/dep_${index}`);
  for (const text of ["no heartbeat yet", "last seen just now", "last seen 2m ago", "last seen 2h ago", "last seen 2026-09-30", "all sources", "1 source", "all monitors", "1 monitor", "metrics logtura"]) expect(screen.getByText(text)).toBeTruthy();
});
it("renders compact metrics totals and handles a nonfinite legacy metric value", async () => {
  vi.mocked(api.listDeploymentsForConnection).mockResolvedValue({ deployments: [deployment({ metricsSnapshot: { byComponent: {}, totals: { received: 1200, sent: 4500, errors: 123, discarded: Number.NaN }, lifetimeOffset: { received: 0, sent: 0, errors: 0, discarded: 0 }, processStartAt: null, updatedAt: Date.now() } })] });
  page(); await screen.findByText("1.2K"); for (const value of ["4.5K", "123", "0", "received", "sent", "errors", "discarded", "updated just now"]) expect(screen.getByText(value)).toBeTruthy();
});
it("lists Supabase projects and preserves the selected project across picker reopening", async () => {
  load([], null, { provider: "supabase-edge-logs", externalAccountId: "project_one" });
  vi.spyOn(api, "listSupabaseProjects").mockResolvedValue({ projects: [{ ref: "project_one", name: "Primary", organizationId: null, functionCount: 2 }, { ref: "project_two", name: "Backup", organizationId: "org", functionCount: null }] });
  const user = userEvent.setup(); page(); await screen.findByRole("heading", { name: "Production" });
  expect(screen.queryByText("Pick a Supabase project")).toBeNull(); await user.click(screen.getByRole("button", { name: "change project" })); await screen.findByText("Primary");
  expect((screen.getByRole("button", { name: "Selected" }) as HTMLButtonElement).disabled).toBe(true); expect(screen.getByText("?")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "hide picker" })); expect(screen.queryByText("Primary")).toBeNull();
  await user.click(screen.getByRole("button", { name: "change project" })); expect(await screen.findByText("Primary")).toBeTruthy();
});
it("picks a Supabase project on the existing connection and refreshes its discovery state", async () => {
  load([], null, { provider: "supabase-edge-logs", externalAccountId: null });
  vi.spyOn(api, "listSupabaseProjects").mockResolvedValue({ projects: [{ ref: "project_one", name: "Primary", organizationId: null, functionCount: 1 }] });
  const picked = { ...connection, provider: "supabase-edge-logs", externalAccountId: "project_one" };
  vi.spyOn(api, "pickSupabaseProject").mockResolvedValue({ connection: picked }); const user = userEvent.setup(); page(); await screen.findByText("Primary");
  load([], null, picked); await user.click(screen.getByRole("button", { name: "Pick" }));
  await waitFor(() => expect(api.pickSupabaseProject).toHaveBeenCalledWith(connection.id, "project_one"));
  expect(notifications.show).toHaveBeenCalledWith({ message: "Picked project_one; discovering…", color: "teal" });
  await waitFor(() => expect(screen.queryByText("Pick a Supabase project")).toBeNull());
});
it("shows the Supabase empty catalog and allows toggling its project picker", async () => {
  load([], null, { provider: "supabase-edge-logs", externalAccountId: null }); vi.spyOn(api, "listSupabaseProjects").mockResolvedValue({ projects: [] });
  page(); await screen.findByText("No projects visible to this token."); expect(screen.getByRole("button", { name: "pick project" })).toBeTruthy();
});
it.each([new ApiError("Projects unavailable", 503), "unexpected"])("reports Supabase project catalog errors", async error => {
  load([], null, { provider: "supabase-edge-logs", externalAccountId: null }); vi.spyOn(api, "listSupabaseProjects").mockRejectedValue(error);
  page(); expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed to list projects");
});
it.each([new ApiError("Project refused", 409), "unexpected"])("retains project selection for retry after a failed pick", async error => {
  load([], null, { provider: "supabase-edge-logs", externalAccountId: null }); vi.spyOn(api, "listSupabaseProjects").mockResolvedValue({ projects: [{ ref: "one", name: "Only", organizationId: null, functionCount: 0 }] });
  vi.spyOn(api, "pickSupabaseProject").mockRejectedValue(error); page(); await screen.findByText("Only"); await userEvent.click(screen.getByRole("button", { name: "Pick" }));
  expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Pick failed"); expect((screen.getByRole("button", { name: "Pick" }) as HTMLButtonElement).disabled).toBe(false);
});
