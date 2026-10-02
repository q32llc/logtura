import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../api";
import type { ApiDeployment, ApiMonitor, ApiTargetBundle } from "../types";
import { DeploymentDetail } from "./DeploymentDetail";

const deployment: ApiDeployment = { id: "dep_config", connectionId: "con_one", displayName: "Config fixture", targetKind: "fly", managed: false, status: "running", externalId: null, sourceIds: ["src_alpha"], monitorIds: null, heartbeatTarget: null, metricsTarget: null, metricsSnapshot: null, bundleOutdated: false, createdAt: 0, updatedAt: 0, lastSeenAt: null };
const bundle: ApiTargetBundle = { target: { id: "fly", displayName: "Fly", supportsManaged: true }, files: [], envVars: [], selfDeployInstructions: "Run", selectedCount: 1, monitorSummary: "All monitors", componentManifest: [] };
const catalog: Awaited<ReturnType<typeof api.listAllSources>> = {
  connections: [{ id: "con_one", displayName: "First account", provider: "cloudflare", externalAccountId: null }, { id: "con_two", displayName: "Second account", provider: "fly", externalAccountId: null }],
  sources: [{ id: "src_alpha", connectionId: "con_one", displayName: "Alpha", sourceKind: "worker", externalId: "alpha" }, { id: "src_beta", connectionId: "con_one", displayName: "Beta", sourceKind: "worker", externalId: "beta" }, { id: "src_gamma", connectionId: "con_two", displayName: "Gamma", sourceKind: "app", externalId: "gamma" }],
};
const monitor = (id: string, connectionId: string | null): ApiMonitor => ({ id, connectionId, displayName: id, enabled: true, filterSteps: [], createdAt: 0, updatedAt: 0 });
function page() { return render(<MantineProvider env="test"><MemoryRouter initialEntries={["/app/deployments/dep_config?tab=configure"]}><Routes><Route path="/app/deployments/:id" element={<DeploymentDetail />} /></Routes></MemoryRouter></MantineProvider>); }
async function ready() { await screen.findByRole("switch", { name: "Alpha" }); }
async function save() { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); await vi.waitFor(() => expect(api.updateDeployment).toHaveBeenCalledTimes(1)); }
beforeEach(() => {
  vi.spyOn(api, "getDeployment").mockResolvedValue({ deployment, latestDeployJob: null, connections: [] });
  vi.spyOn(api, "getDeploymentBundle").mockResolvedValue(bundle);
  vi.spyOn(api, "getDeploymentConfigurationState").mockRejectedValue(new Error("No fixture revision"));
  vi.spyOn(api, "listAllSources").mockResolvedValue(catalog);
  vi.spyOn(api, "listMonitors").mockResolvedValue({ monitors: [monitor("Global monitor", null), monitor("First monitor", "con_one"), monitor("Second monitor", "con_two")], sinks: [] });
  vi.spyOn(api, "listDestinations").mockResolvedValue({ destinations: [] });
  vi.spyOn(api, "listDeployTargets").mockResolvedValue({ deployTargets: [] });
  vi.spyOn(api, "updateDeployment").mockResolvedValue({ deployment });
  vi.spyOn(notifications, "show").mockReturnValue("fixture_notice");
});

it("shows the exact selected source and applicable monitors with an unchanged save disabled", async () => {
  page(); await ready(); expect((screen.getByRole("switch", { name: "Alpha" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("switch", { name: "Beta" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("First account · cloudflare")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  expect(screen.getByRole("switch", { name: "Global monitor" })).toBeTruthy(); expect(screen.getByRole("switch", { name: "First monitor" })).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Second monitor" })).toBeNull();
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
});
it("does not enable saving when no configuration changed", async () => {
  page(); await ready(); expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
});
it.each(["listAllSources", "listMonitors", "listDestinations"] as const)("prevents saving a legacy wildcard when %s fails and recovers through retry", async method => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, sourceIds: null }, latestDeployJob: null, connections: [] });
  vi.mocked(api[method]).mockRejectedValueOnce(new Error("Private provider failure"));
  page(); await screen.findByText("Could not load configuration data. Retry before saving.");
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull(); expect(api.updateDeployment).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("Private provider failure");
  fireEvent.click(screen.getByRole("button", { name: "Retry configuration data" })); await ready();
  expect((screen.getByRole("switch", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("switch", { name: "Gamma" }) as HTMLInputElement).checked).toBe(false);
  await save(); expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ sourceIds: ["src_alpha", "src_beta"] }));
});
it("waits for every configuration catalog before exposing editable selections", async () => {
  let finish!: (value: typeof catalog) => void;
  vi.mocked(api.listAllSources).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  page(); await screen.findByText("Loading deployment configuration…");
  expect(screen.queryByLabelText("Deployment name")).toBeNull(); expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  await act(async () => { finish(catalog); }); await ready();
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
});
it("expands a legacy wildcard to its anchor's sources without selecting other accounts", async () => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, sourceIds: null }, latestDeployJob: null, connections: [] });
  page(); await ready(); await save(); expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ sourceIds: ["src_alpha", "src_beta"] }));
});
it("selects an individual source and derives the additional applicable monitor", async () => {
  page(); await ready(); fireEvent.click(screen.getByRole("switch", { name: "Gamma" }));
  expect(screen.getByText("Second account · fly")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  expect(screen.getByRole("switch", { name: "Second monitor" })).toBeTruthy();
  await save(); expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ sourceIds: ["src_alpha", "src_gamma"], monitorIds: null }));
});
it("toggles all sources in one connection independently of another connection", async () => {
  page(); await ready(); fireEvent.click(screen.getByRole("switch", { name: "All sources from Second account" }));
  fireEvent.click(screen.getByRole("switch", { name: "All sources from First account" }));
  expect((screen.getByRole("switch", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: "All sources from First account" }));
  await save(); expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ sourceIds: ["src_gamma"] }));
});
it("filters case-insensitively by kind and restricts bulk selection and clearing to visible sources", async () => {
  page(); await ready(); fireEvent.change(screen.getByRole("textbox", { name: "Filter sources" }), { target: { value: " APP " } });
  expect(screen.queryByRole("switch", { name: "Alpha" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select all matching" }));
  expect((screen.getByRole("switch", { name: "Gamma" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter sources" }), { target: { value: " WORKER " } });
  fireEvent.click(screen.getByRole("button", { name: "Clear matching" })); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ sourceIds: ["src_gamma"] }));
});
it("preserves hidden selections when selecting all matching by name", async () => {
  page(); await ready(); fireEvent.change(screen.getByRole("textbox", { name: "Filter sources" }), { target: { value: "bEtA" } });
  fireEvent.click(screen.getByRole("button", { name: "Select all matching" })); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ sourceIds: ["src_alpha", "src_beta"] }));
});
it("disables bulk actions when the filter matches no sources", async () => {
  page(); await ready(); fireEvent.change(screen.getByRole("textbox", { name: "Filter sources" }), { target: { value: "absent" } });
  expect(screen.getByText('No sources match "absent".')).toBeTruthy();
  expect((screen.getByRole("button", { name: "Select all matching" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Clear matching" }) as HTMLButtonElement).disabled).toBe(true);
});
it("supports explicitly clearing every source", async () => {
  page(); await ready(); fireEvent.click(screen.getByRole("button", { name: "Clear" })); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ sourceIds: [] }));
});
it.each(["selectAll", "discoverSources"] as const)("shows a CLI %s selection and preserves its graph on a name-only save", async mode => {
  const graphSelection = { schema_version: 1 as const, connections: [{ id: "con_one", sourceIds: [], [mode]: true }, { id: "con_two", sourceIds: ["src_gamma"] }], monitors: [] };
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, sourceIds: null, graphSelection }, latestDeployJob: null, connections: [] });
  page(); await ready(); expect((screen.getByRole("switch", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("switch", { name: "Gamma" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Deployment name"), { target: { value: "  Renamed  " } }); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", { displayName: "Renamed", heartbeatTarget: "logtura", metricsTarget: null });
});
it("switches the source section to an explicit list when a CLI discovery selection is edited", async () => {
  const graphSelection = { schema_version: 1 as const, connections: [{ id: "con_one", sourceIds: [], discoverSources: true }], monitors: [] };
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, graphSelection }, latestDeployJob: null, connections: [] });
  page(); await ready(); fireEvent.click(screen.getByRole("switch", { name: "Beta" })); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", { displayName: deployment.displayName, sourceIds: ["src_alpha"], heartbeatTarget: "logtura", metricsTarget: null });
});
it("keeps modern graph monitors applicable even when discovery currently has no sources", async () => {
  vi.mocked(api.listAllSources).mockResolvedValue({ connections: catalog.connections, sources: [] });
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, sourceIds: [], graphSelection: { schema_version: 1, connections: [{ id: "con_two", sourceIds: [], discoverSources: true }], monitors: [] } }, latestDeployJob: null, connections: [] });
  page(); await screen.findByText("No sources discovered yet. Connect a provider on the Connections page.");
  fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  expect(screen.getByRole("switch", { name: "Second monitor" })).toBeTruthy(); expect(screen.queryByRole("switch", { name: "First monitor" })).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "Global monitor" }));
  await save(); expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ monitorIds: ["Second monitor"] }));
  expect(vi.mocked(api.updateDeployment).mock.calls[0]![1]).not.toHaveProperty("sourceIds");
});
it("preserves explicit graph source IDs missing from the current catalog on unrelated edits", async () => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, graphSelection: { schema_version: 1, connections: [{ id: "con_one", sourceIds: ["src_missing"] }], monitors: [] } }, latestDeployJob: null, connections: [] });
  page(); await ready(); fireEvent.change(screen.getByLabelText("Deployment name"), { target: { value: "Renamed" } }); await save();
  expect(vi.mocked(api.updateDeployment).mock.calls[0]![1]).not.toHaveProperty("sourceIds");
});
it.each([new ApiError("Update refused", 409, "conflict"), new Error("Private detail")])("retains selections after a save failure and retries them", async error => {
  vi.mocked(api.updateDeployment).mockRejectedValueOnce(error).mockResolvedValue({ deployment });
  page(); await ready(); fireEvent.click(screen.getByRole("switch", { name: "Beta" })); fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(error instanceof ApiError ? "Update refused" : "Failed"); expect((screen.getByRole("switch", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" })); await vi.waitFor(() => expect(api.updateDeployment).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.updateDeployment).mock.calls[1]![1].sourceIds).toEqual(["src_alpha", "src_beta"]);
});
it("rejects an empty name and trims a valid replacement", async () => {
  page(); await ready(); fireEvent.change(screen.getByLabelText("Deployment name"), { target: { value: "   " } });
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Deployment name"), { target: { value: "  Renamed  " } }); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ displayName: "Renamed" }));
});
it("offers only metrics-capable destinations and saves the chosen target", async () => {
  vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [
    { id: "dest_metrics", kind: "datadog-metrics", displayName: "Metrics endpoint", flows: ["metrics"], createdAt: 0, updatedAt: 0 },
    { id: "dest_logs", kind: "webhook", displayName: "Logs endpoint", flows: ["logs"], createdAt: 0, updatedAt: 0 },
  ] });
  page(); await ready(); fireEvent.click(screen.getByRole("textbox", { name: "Metrics target" }));
  expect(screen.queryByRole("option", { name: /Logs endpoint/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "Metrics endpoint (datadog-metrics)" })); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ metricsTarget: "dest_metrics" }));
});
it("saves disabled heartbeat checks and logtura metrics independently", async () => {
  page(); await ready(); fireEvent.click(screen.getByRole("textbox", { name: "Heartbeat target" }));
  fireEvent.click(screen.getByRole("option", { name: "None (no liveness checks)" }));
  fireEvent.click(screen.getByRole("textbox", { name: "Metrics target" })); fireEvent.click(screen.getByRole("option", { name: "logtura (last-received only)" }));
  await save(); expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ heartbeatTarget: "none", metricsTarget: "logtura" }));
});
it("restores wildcard monitors after an explicit edit", async () => {
  page(); await ready(); fireEvent.click(screen.getByRole("button", { name: "Customize" })); fireEvent.click(screen.getByRole("switch", { name: "First monitor" }));
  fireEvent.click(screen.getByRole("switch", { name: "1 of 2" }));
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Deployment name"), { target: { value: "Renamed" } }); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ monitorIds: null }));
});
it("does not issue a second save while the first request is unresolved", async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.updateDeployment>>) => void;
  vi.mocked(api.updateDeployment).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  page(); await ready(); fireEvent.click(screen.getByRole("switch", { name: "Beta" }));
  const button = screen.getByRole("button", { name: "Save changes" }); fireEvent.click(button); fireEvent.click(button);
  expect(api.updateDeployment).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ deployment }); });
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
});
it("rehydrates the saved source selection and disables saving after the resource reloads", async () => {
  const updated = { ...deployment, sourceIds: ["src_alpha", "src_beta"] };
  vi.mocked(api.getDeployment).mockResolvedValueOnce({ deployment, latestDeployJob: null, connections: [] }).mockResolvedValue({ deployment: updated, latestDeployJob: null, connections: [] });
  vi.mocked(api.updateDeployment).mockResolvedValue({ deployment: updated });
  page(); await ready(); fireEvent.click(screen.getByRole("switch", { name: "Beta" })); await save();
  await vi.waitFor(() => expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole("switch", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
});
it("honors existing legacy section overrides rather than restoring a retired modern policy", async () => {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, graphSelection: { schema_version: 1, legacySources: true, legacyMonitors: true, connections: [{ id: "con_two", sourceIds: [], discoverSources: true }], monitors: [] } }, latestDeployJob: null, connections: [] });
  page(); await ready(); expect((screen.getByRole("switch", { name: "Gamma" }) as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText("Deployment name"), { target: { value: "Renamed" } }); await save();
  expect(api.updateDeployment).toHaveBeenCalledWith("dep_config", expect.objectContaining({ sourceIds: ["src_alpha"], monitorIds: null }));
});
