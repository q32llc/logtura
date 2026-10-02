import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../api";
import type { ApiConnection, ApiDeployTargetDriver, ApiDeployment, ApiMonitor, ApiSource } from "../types";
import { DeployWizard } from "./DeployWizard";
const connection: ApiConnection = { id: "con_one", provider: "cloudflare-worker-tail", displayName: "Production", externalAccountId: "fixture", providerInstallationId: null, lastDiscoveredAt: null, createdAt: 0, updatedAt: 0 };
const sources: ApiSource[] = ["one", "two"].map(id => ({ id: `src_${id}`, sourceKind: "worker", sourceKindLabel: "Worker", externalId: id, displayName: `Site ${id}`, metadata: null, selected: true, discoveredAt: 0 }));
const monitors: ApiMonitor[] = [
  { id: "mon_global", connectionId: null, displayName: "Global errors", filterSteps: [{ kind: "errors" }], enabled: true, createdAt: 0, updatedAt: 0 },
  { id: "mon_scoped", connectionId: connection.id, displayName: "Scoped routes", filterSteps: [], enabled: true, createdAt: 0, updatedAt: 0 },
  { id: "mon_other", connectionId: "con_other", displayName: "Other account", filterSteps: [{ kind: "errors" }, { kind: "sample", rate: 0.5 }], enabled: true, createdAt: 0, updatedAt: 0 },
];
const fly: ApiDeployTargetDriver = { id: "fly", displayName: "Fly", description: "Deploy a Fly machine", supportsManaged: true, connectFlow: null, formFields: [] };
const other: ApiDeployTargetDriver = { ...fly, id: "other", displayName: "Your own host", supportsManaged: false };
function Location() { const location = useLocation(); return <output aria-label="Current route">{location.pathname}{location.search}</output>; }
function page(query = "", missingId = false) {
  render(<MantineProvider env="test"><MemoryRouter initialEntries={[missingId ? "/wizard" : `/app/connections/${connection.id}/deploy${query}`]}><Routes>
    <Route path={missingId ? "/wizard" : "/app/connections/:id/deploy"} element={<DeployWizard />} /><Route path="*" element={<Location />} />
  </Routes></MemoryRouter></MantineProvider>); return userEvent.setup();
}
async function configure(user: ReturnType<typeof userEvent.setup>, target = "Fly") {
  await user.click(await screen.findByRole("button", { name: `Deploy to ${target}` })); await screen.findByRole("textbox", { name: "Deployment name" });
}
async function customize(user: ReturnType<typeof userEvent.setup>) {
  const buttons = screen.getAllByRole("button", { name: "Customize" }); for (const button of buttons) await user.click(button);
}
beforeEach(() => {
  vi.spyOn(api, "deployTargetDrivers").mockResolvedValue({ drivers: [fly, other] });
  vi.spyOn(api, "getConnection").mockResolvedValue({ connection, sources, latestDiscoveryJob: null });
  vi.spyOn(api, "listMonitors").mockResolvedValue({ monitors, sinks: [] });
  vi.spyOn(api, "createDeployment").mockResolvedValue({ deployment: { id: "dep_created" } as ApiDeployment });
});
it("selects a target from the keyboard, preserves connection navigation and creates wildcard configuration", async () => {
  const user = page(); const target = await screen.findByRole("button", { name: "Deploy to Fly" });
  expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/app/connections/con_one");
  target.focus(); await user.keyboard("{Enter}"); await screen.findByRole("textbox", { name: "Deployment name" });
  expect((screen.getByRole("textbox", { name: "Deployment name" }) as HTMLInputElement).value).toBe("Production-forwarder");
  await user.click(screen.getByRole("button", { name: "Create & generate Fly bundle" }));
  await waitFor(() => expect(api.createDeployment).toHaveBeenCalledWith({ connectionId: connection.id, displayName: "Production-forwarder", targetKind: "fly", managed: false, sourceIds: null, monitorIds: null }));
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/app/deployments/dep_created"));
});
it("deselects individual wildcard items without losing every other selected source or monitor", async () => {
  const user = page(); await configure(user); await customize(user);
  expect(screen.queryByRole("switch", { name: "Other account" })).toBeNull();
  await user.click(screen.getByRole("switch", { name: "Site one" }));
  expect((screen.getByRole("switch", { name: "Site two" }) as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole("switch", { name: "Global errors" }));
  expect((screen.getByRole("switch", { name: "Scoped routes" }) as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole("button", { name: "Create & generate Fly bundle" }));
  await waitFor(() => expect(api.createDeployment).toHaveBeenCalledWith(expect.objectContaining({ sourceIds: ["src_two"], monitorIds: ["mon_scoped"] })));
});
it("supports explicit empty monitor selection and reselecting individual sources", async () => {
  const user = page(); await configure(user); await customize(user);
  await user.click(screen.getByRole("switch", { name: "Site one" })); await user.click(screen.getByRole("switch", { name: "Site two" }));
  expect((screen.getByRole("button", { name: "Create & generate Fly bundle" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("switch", { name: "Site one" }));
  await user.click(screen.getByRole("switch", { name: "Global errors" })); await user.click(screen.getByRole("switch", { name: "Scoped routes" }));
  await user.click(screen.getByRole("switch", { name: "Global errors" })); await user.click(screen.getByRole("switch", { name: "Global errors" }));
  await user.click(screen.getByRole("button", { name: "Create & generate Fly bundle" }));
  await waitFor(() => expect(api.createDeployment).toHaveBeenCalledWith(expect.objectContaining({ sourceIds: ["src_one"], monitorIds: [] })));
});
it("restores wildcard source and monitor policy using the all-selection controls", async () => {
  const user = page(); await configure(user); await customize(user);
  await user.click(screen.getByRole("switch", { name: "Site one" })); await user.click(screen.getByRole("switch", { name: "Global errors" }));
  for (const control of screen.getAllByRole("switch", { name: "1 of 2" })) await user.click(control);
  await user.click(screen.getByRole("button", { name: "Create & generate Fly bundle" }));
  await waitFor(() => expect(api.createDeployment).toHaveBeenCalledWith(expect.objectContaining({ sourceIds: null, monitorIds: null })));
});
it("requires a nonblank deployment name and trims the saved label", async () => {
  const user = page("?target=other"); const name = await screen.findByRole("textbox", { name: "Deployment name" });
  await user.clear(name); await user.type(name, "  "); expect((screen.getByRole("button", { name: "Create & show bundle" }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(name); await user.type(name, "  custom-forwarder  "); await user.click(screen.getByRole("button", { name: "Create & show bundle" }));
  await waitFor(() => expect(api.createDeployment).toHaveBeenCalledWith(expect.objectContaining({ displayName: "custom-forwarder", targetKind: "other" })));
});
it("clears unsupported managed mode when switching targets and keeps unavailable targets disabled", async () => {
  const user = page(); await configure(user); await user.click(screen.getByText("Let logtura manage it"));
  expect((screen.getByRole("button", { name: "Create deployment" }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByText("I'll handle it")); expect(screen.getByRole("button", { name: "Create & generate Fly bundle" })).toBeTruthy();
  await user.click(screen.getByText("Let logtura manage it")); await user.click(screen.getByRole("button", { name: "← Switch target" }));
  expect((screen.getByRole("button", { name: "Deploy to AWS" }) as HTMLButtonElement).disabled).toBe(true);
  await configure(user, "Your own host"); expect(screen.queryByText("Let logtura manage it")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Create & show bundle" })); await waitFor(() => expect(api.createDeployment).toHaveBeenCalledWith(expect.objectContaining({ managed: false, targetKind: "other" })));
});
it("creates a managed deployment with its selected sources and opens the Run tab", async () => {
  const user = page(); await configure(user); await customize(user);
  await user.click(screen.getByRole("switch", { name: "Site one" }));
  await user.click(screen.getByText("Let logtura manage it"));
  await user.click(screen.getByRole("button", { name: "Create deployment" }));
  await waitFor(() => expect(api.createDeployment).toHaveBeenCalledWith({ connectionId: connection.id, displayName: "Production-forwarder", targetKind: "fly", managed: true, sourceIds: ["src_two"], monitorIds: null }));
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/app/deployments/dep_created?tab=run"));
});
it("recovers invalid target deep links with a usable target picker", async () => {
  const user = page("?target=missing"); expect((await screen.findByRole("alert")).textContent).toContain("This deployment target is unavailable");
  await configure(user); expect(screen.getByRole("button", { name: "Create & generate Fly bundle" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
it.each([new ApiError("Create refused", 409), "unexpected"])("preserves configuration after a failed creation and allows retry", async error => {
  vi.mocked(api.createDeployment).mockRejectedValueOnce(error); const user = page(); await configure(user);
  await user.click(screen.getByRole("button", { name: "Create & generate Fly bundle" })); expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed");
  await user.click(screen.getByRole("button", { name: "Create & generate Fly bundle" })); await waitFor(() => expect(api.createDeployment).toHaveBeenCalledTimes(2));
});
it.each([new ApiError("Targets unavailable", 503), "unexpected"])("reports target catalog failures", async error => {
  vi.mocked(api.deployTargetDrivers).mockRejectedValue(error); page(); expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed to load targets");
});
it.each([new ApiError("Connection unavailable", 503), "unexpected"])("reports connection lookup failures", async error => {
  vi.mocked(api.getConnection).mockRejectedValue(error); page("?target=fly"); expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed to load connection");
});
it("handles a missing connection route and a catalog without the generic target", async () => {
  vi.mocked(api.deployTargetDrivers).mockResolvedValue({ drivers: [{ ...fly, id: "custom", displayName: "Custom host", supportsManaged: false }] }); page("", true);
  expect(await screen.findByRole("button", { name: "Deploy to Custom host" })).toBeTruthy(); expect(screen.queryByRole("button", { name: "Deploy to Your own host" })).toBeNull();
  expect(api.getConnection).not.toHaveBeenCalled(); expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/app");
});
it("retains deployment creation when optional monitor lookup fails", async () => {
  vi.mocked(api.listMonitors).mockRejectedValue(new Error("Unavailable")); const user = page(); await configure(user);
  expect(screen.getByRole("link", { name: "Create a monitor" }).getAttribute("href")).toBe("/app/monitors");
  expect(screen.getByRole("link", { name: "Cancel" }).getAttribute("href")).toBe("/app/connections/con_one");
  expect(screen.queryByRole("alert")).toBeNull();
});
it("describes empty, single-step and multiple-step monitor pipelines in customization", async () => {
  vi.mocked(api.listMonitors).mockResolvedValue({ monitors: [...monitors, { ...monitors[0]!, id: "mon_many", displayName: "Many filters", filterSteps: [{ kind: "errors" }, { kind: "sample", rate: 0.5 }] }], sinks: [] });
  const user = page(); await configure(user); await customize(user); expect(screen.getByText("no filters")).toBeTruthy(); expect(screen.getByText("1 step")).toBeTruthy(); expect(screen.getByText("2 steps")).toBeTruthy();
});
it("retains connection load errors when choosing an available target", async () => {
  vi.mocked(api.getConnection).mockRejectedValue(new ApiError("Connection unavailable", 503));
  const user = page(); await screen.findByText("Connection unavailable");
  await user.click(await screen.findByRole("button", { name: "Deploy to Fly" }));
  expect(screen.getByRole("alert").textContent).toContain("Connection unavailable");
  expect(screen.queryByRole("textbox", { name: "Deployment name" })).toBeNull();
});
