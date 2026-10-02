import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../api";
import type { ApiConnection, ApiDestination, ApiMonitor, ApiSinkRecord } from "../types";
import { Monitors } from "./Monitors";
const connection: ApiConnection = { id: "con_one", displayName: "Production", provider: "cloudflare-worker-tail", externalAccountId: "fixture", providerInstallationId: null, lastDiscoveredAt: null, createdAt: 0, updatedAt: 0 };
const destination: ApiDestination = { id: "dst_one", displayName: "Webhook", kind: "webhook", flows: ["logs"], createdAt: 0, updatedAt: 0 };
function monitor(overrides: Partial<ApiMonitor> = {}): ApiMonitor { return { id: "mon_one", displayName: "Errors", connectionId: null, enabled: true, filterSteps: [{ kind: "errors" }], createdAt: 0, updatedAt: 0, ...overrides }; }
function sink(overrides: Partial<ApiSinkRecord> = {}): ApiSinkRecord { return { id: "sink_one", monitorId: "mon_one", destinationId: "dst_one", filterSteps: [{ kind: "dedup", window_secs: 300 }], createdAt: 0, ...overrides }; }
function page() { render(<MantineProvider env="test"><MemoryRouter><Monitors /></MemoryRouter></MantineProvider>); return userEvent.setup(); }
function loaded(monitors = [monitor()], sinks: ApiSinkRecord[] = []) { vi.mocked(api.listMonitors).mockResolvedValue({ monitors, sinks }); }
async function card(name = "Errors") { return within(await screen.findByRole("region", { name: `Monitor ${name}` })); }
beforeEach(() => {
  vi.spyOn(notifications, "show").mockImplementation(() => "notification");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "listMonitors").mockResolvedValue({ monitors: [], sinks: [] });
  vi.spyOn(api, "listDestinations").mockResolvedValue({ destinations: [destination] });
  vi.spyOn(api, "listConnections").mockResolvedValue({ connections: [connection] });
  vi.spyOn(api, "createMonitor").mockResolvedValue({ monitor: monitor() });
  vi.spyOn(api, "updateMonitor").mockResolvedValue({ monitor: monitor() });
  vi.spyOn(api, "deleteMonitor").mockResolvedValue({ ok: true });
  vi.spyOn(api, "addSink").mockResolvedValue({ sink: sink() });
  vi.spyOn(api, "deleteSink").mockResolvedValue({ ok: true });
  vi.spyOn(api, "updateSinkSteps").mockResolvedValue({ ok: true });
});
it("creates an all-connection monitor with errors by default and a trimmed name", async () => {
  const user = page(); await screen.findByText("No monitors yet.");
  await user.click(screen.getByRole("button", { name: "Create your first monitor" }));
  const dialog = within(await screen.findByRole("dialog", { name: "New monitor" }));
  expect((dialog.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(dialog.getByRole("textbox", { name: "Name" }), "  Alerts  ");
  await user.click(dialog.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(api.createMonitor).toHaveBeenCalledWith({ displayName: "Alerts", connectionId: null, filterSteps: [{ kind: "errors" }] }));
  expect(notifications.show).toHaveBeenCalledWith({ message: "Monitor created", color: "teal" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("selects a connection scope and resets cancelled creation drafts", async () => {
  const user = page(); await screen.findByText("No monitors yet."); await user.click(screen.getByRole("button", { name: "New monitor" }));
  let dialog = within(await screen.findByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Name" }), "Discarded");
  await user.click(dialog.getByRole("textbox", { name: "Scope" })); await user.click(await screen.findByRole("option", { name: "Production" }));
  await user.click(dialog.getByRole("button", { name: "Remove errors" }));
  await user.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(api.createMonitor).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "New monitor" })); dialog = within(await screen.findByRole("dialog"));
  expect((dialog.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("");
  expect((dialog.getByRole("textbox", { name: "Scope" }) as HTMLInputElement).value).toBe("All connections");
  expect(dialog.getByRole("button", { name: "Edit errors" })).toBeTruthy();
  await user.type(dialog.getByRole("textbox", { name: "Name" }), "Scoped");
  await user.click(dialog.getByRole("textbox", { name: "Scope" })); await user.click(await screen.findByRole("option", { name: "Production" }));
  await user.click(dialog.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(api.createMonitor).toHaveBeenCalledWith({ displayName: "Scoped", connectionId: connection.id, filterSteps: [{ kind: "errors" }] }));
});
it.each([new ApiError("Invalid monitor", 400), "unexpected"])("retains a failed creation for retry", async error => {
  vi.mocked(api.createMonitor).mockRejectedValueOnce(error); const user = page(); await screen.findByText("No monitors yet.");
  await user.click(screen.getByRole("button", { name: "New monitor" })); const dialog = within(await screen.findByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Name" }), "Retry"); await user.click(dialog.getByRole("button", { name: "Create" }));
  expect((await dialog.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed");
  await user.click(dialog.getByRole("button", { name: "Create" })); await waitFor(() => expect(api.createMonitor).toHaveBeenCalledTimes(2));
});
it("renders shared and connection-specific monitors with missing-resource fallbacks", async () => {
  loaded([monitor(), monitor({ id: "mon_scoped", displayName: "Scoped", connectionId: connection.id, enabled: false }), monitor({ id: "mon_unknown", displayName: "Unknown", connectionId: "con_missing", filterSteps: [] })], [sink({ destinationId: "dst_missing" }), sink({ id: "sink_two" })]);
  page(); const shared = await card(); expect(shared.getByText("all connections")).toBeTruthy();
  expect(shared.getByText("→ dst_missing")).toBeTruthy(); expect(shared.getByText("?")).toBeTruthy(); expect(shared.getByText("→ Webhook")).toBeTruthy();
  expect((await card("Scoped")).getByText("Production")).toBeTruthy();
  expect((await card("Unknown")).getByText("con_missing")).toBeTruthy();
  expect((await card("Unknown")).getByText("No filters — every event reaches the sinks below.")).toBeTruthy();
});
it.each([new ApiError("Account unavailable", 503), "unexpected"])("reports catalog failure", async error => {
  vi.mocked(api.listConnections).mockRejectedValue(error); page(); expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed to load");
});
it("requires confirmation before deletion and refreshes after deleting the selected monitor", async () => {
  loaded(); const user = page(), view = await card(); vi.mocked(window.confirm).mockReturnValueOnce(false);
  await user.click(view.getByRole("button", { name: "Delete" })); expect(api.deleteMonitor).not.toHaveBeenCalled();
  loaded([]); await user.click(view.getByRole("button", { name: "Delete" }));
  expect(window.confirm).toHaveBeenCalledWith("Delete this monitor and its sinks?"); await screen.findByText("No monitors yet.");
  expect(api.deleteMonitor).toHaveBeenCalledWith("mon_one"); expect(notifications.show).toHaveBeenCalledWith({ message: "Monitor deleted", color: "teal" });
});
it.each([new ApiError("Delete refused", 409), "unexpected"])("preserves monitors after failed deletion", async error => {
  loaded(); vi.mocked(api.deleteMonitor).mockRejectedValue(error); const user = page(); await user.click((await card()).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ message: error instanceof ApiError ? error.message : "Failed", color: "red" }));
  expect(screen.getByRole("region", { name: "Monitor Errors" })).toBeTruthy();
});
it("toggles both enabled states and refreshes the saved state", async () => {
  loaded(); const user = page(); loaded([monitor({ enabled: false })]);
  await user.click((await card()).getByRole("switch", { name: "Enabled" }));
  await waitFor(() => expect(api.updateMonitor).toHaveBeenCalledWith("mon_one", { enabled: false }));
  await screen.findByRole("switch", { name: "Disabled" }); loaded();
  await user.click(screen.getByRole("switch", { name: "Disabled" }));
  await waitFor(() => expect(api.updateMonitor).toHaveBeenLastCalledWith("mon_one", { enabled: true }));
  await screen.findByRole("switch", { name: "Enabled" });
});
it.each([new ApiError("Save refused", 409), "unexpected"])("preserves enabled state when toggling fails", async error => {
  loaded(); vi.mocked(api.updateMonitor).mockRejectedValue(error); const user = page(); await user.click((await card()).getByRole("switch", { name: "Enabled" }));
  await waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ message: error instanceof ApiError ? error.message : "Failed", color: "red" }));
  expect((screen.getByRole("switch", { name: "Enabled" }) as HTMLInputElement).checked).toBe(true);
});
it("saves monitor and per-sink pipelines independently without altering other monitors or sinks", async () => {
  loaded([monitor(), monitor({ id: "mon_two", displayName: "Other" })], [sink(), sink({ id: "sink_two", filterSteps: [{ kind: "sample", rate: 0.5 }] })]);
  const user = page(), view = await card(); await user.click(view.getByRole("button", { name: "Remove errors" }));
  await waitFor(() => expect(api.updateMonitor).toHaveBeenCalledWith("mon_one", { filterSteps: [] }));
  await view.findByText("No filters — every event reaches the sinks below."); expect((await card("Other")).getByRole("button", { name: "Edit errors" })).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Remove dedup 300s" }));
  await waitFor(() => expect(api.updateSinkSteps).toHaveBeenCalledWith("sink_one", []));
  await view.findByText("No per-sink refinement — uses the monitor's pipeline output as-is.");
  expect(view.getByRole("button", { name: "Edit sample 50%" })).toBeTruthy();
});
it.each([new ApiError("Pipeline rejected", 400), "unexpected"])("retains both pipelines when saving fails", async error => {
  loaded([monitor()], [sink()]); vi.mocked(api.updateMonitor).mockRejectedValue(error); vi.mocked(api.updateSinkSteps).mockRejectedValue(error);
  const user = page(), view = await card(); await user.click(view.getByRole("button", { name: "Remove errors" }));
  await user.click(view.getByRole("button", { name: "Remove dedup 300s" }));
  await waitFor(() => expect(notifications.show).toHaveBeenCalledTimes(2));
  expect(view.getByRole("button", { name: "Edit errors" })).toBeTruthy(); expect(view.getByRole("button", { name: "Edit dedup 300s" })).toBeTruthy();
  expect(notifications.show).toHaveBeenLastCalledWith({ message: error instanceof ApiError ? error.message : "Failed", color: "red" });
});
it("adds a sink to the selected monitor and removes it with refreshed routing state", async () => {
  loaded(); const user = page(); await user.click((await card()).getByRole("button", { name: "Add sink" }));
  let dialog = within(await screen.findByRole("dialog", { name: "Add sink to Errors" }));
  expect((dialog.getByRole("textbox", { name: "Destination" }) as HTMLInputElement).value).toBe("Webhook (webhook)");
  loaded([monitor()], [sink()]); await user.click(dialog.getByRole("button", { name: "Add sink" }));
  await waitFor(() => expect(api.addSink).toHaveBeenCalledWith("mon_one", { destinationId: "dst_one" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  loaded(); await user.click((await card()).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(api.deleteSink).toHaveBeenCalledWith("sink_one"));
  await screen.findByText("No sinks. Add one to route matches to a destination.");
});
it("allows choosing another destination and cancelling without adding a sink", async () => {
  loaded(); vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [destination, { ...destination, id: "dst_two", displayName: "Backup" }] });
  const user = page(); await user.click((await card()).getByRole("button", { name: "Add sink" })); let dialog = within(await screen.findByRole("dialog"));
  await user.click(dialog.getByRole("textbox", { name: "Destination" })); await user.click(await screen.findByRole("option", { name: "Backup (webhook)" }));
  await user.click(dialog.getByRole("button", { name: "Cancel" })); expect(api.addSink).not.toHaveBeenCalled();
  await user.click((await card()).getByRole("button", { name: "Add sink" })); dialog = within(await screen.findByRole("dialog"));
  expect((dialog.getByRole("textbox", { name: "Destination" }) as HTMLInputElement).value).toBe("Webhook (webhook)");
  await user.click(dialog.getByRole("textbox", { name: "Destination" })); await user.click(await screen.findByRole("option", { name: "Backup (webhook)" }));
  await user.click(dialog.getByRole("button", { name: "Add sink" })); await waitFor(() => expect(api.addSink).toHaveBeenCalledWith("mon_one", { destinationId: "dst_two" }));
});
it.each([new ApiError("Sink refused", 400), "unexpected"])("allows a failed sink creation to be retried", async error => {
  loaded(); vi.mocked(api.addSink).mockRejectedValueOnce(error); const user = page(); await user.click((await card()).getByRole("button", { name: "Add sink" }));
  const dialog = within(await screen.findByRole("dialog")); await user.click(dialog.getByRole("button", { name: "Add sink" }));
  expect((await dialog.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed");
  await user.click(dialog.getByRole("button", { name: "Add sink" })); await waitFor(() => expect(api.addSink).toHaveBeenCalledTimes(2));
});
it.each([new ApiError("Removal refused", 409), "unexpected"])("keeps routing visible if sink deletion fails", async error => {
  loaded([monitor()], [sink()]); vi.mocked(api.deleteSink).mockRejectedValue(error); const user = page(); await user.click((await card()).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ message: error instanceof ApiError ? error.message : "Failed", color: "red" }));
  expect((await card()).getByText("→ Webhook")).toBeTruthy();
});
it("offers destination setup when no sink destination exists", async () => {
  loaded(); vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [] }); const user = page(); await user.click((await card()).getByRole("button", { name: "Add sink" }));
  const dialog = within(await screen.findByRole("dialog")); expect(dialog.getByRole("link", { name: "Create one first." }).getAttribute("href")).toBe("/app/destinations");
  expect(dialog.queryByRole("button", { name: "Add sink" })).toBeNull(); await user.keyboard("{Escape}"); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
