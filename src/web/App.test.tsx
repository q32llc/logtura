import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App, reportApiError } from "./App";
import { api, ApiError } from "./api";
import type { ApiDeployment, ApiUser } from "./types";

const user: ApiUser = { id: "usr_router", githubLogin: "router-fixture", name: "Fixture", email: null, avatarUrl: "https://avatars.example.invalid/fixture" };
const deployment: ApiDeployment = { id: "dep_router", connectionId: "con_router", displayName: "Existing forwarder", targetKind: "fly", managed: false, status: "running", externalId: null, sourceIds: [], monitorIds: [], heartbeatTarget: "none", metricsTarget: null, metricsSnapshot: null, bundleOutdated: true, createdAt: 0, updatedAt: 0, lastSeenAt: null };
function Location() { const location = useLocation(); return <output aria-label="Current route">{location.pathname + location.search}</output>; }
function page(path = "/app") { return render(<MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter>); }
async function signIn() { await screen.findByRole("link", { name: "Sign out" }); }
beforeEach(() => {
  vi.spyOn(api, "me").mockResolvedValue({ user });
  vi.spyOn(api, "listConnections").mockResolvedValue({ connections: [] });
  vi.spyOn(api, "listDeployments").mockResolvedValue({ deployments: [] });
  vi.spyOn(api, "listDestinations").mockResolvedValue({ destinations: [] });
  vi.spyOn(api, "destinationDrivers").mockResolvedValue({ drivers: [] });
  vi.spyOn(api, "listMonitors").mockResolvedValue({ monitors: [], sinks: [] });
  vi.spyOn(api, "cliTokens").mockResolvedValue({ tokens: [] });
});
afterEach(() => { vi.useRealTimers(); });

it.each(["/app", "/app/connections/new", "/app/connections/con_fixture", "/app/connections/con_fixture/deploy", "/app/destinations", "/app/monitors", "/app/deployments", "/app/deployments/dep_fixture"])("guards %s before rendering account content", async path => {
  vi.mocked(api.me).mockResolvedValue({ user: null }); page(path);
  await screen.findByText("Please sign in to continue.");
  expect(screen.getByLabelText("Current route").textContent).toBe("/?error=auth_required");
  expect(screen.getByRole("link", { name: "Sign in with GitHub" }).getAttribute("href")).toBe("/login/github");
  expect(api.listConnections).not.toHaveBeenCalled(); expect(api.listDeployments).not.toHaveBeenCalled();
});
it("withholds protected content until authentication resolves", async () => {
  let finish!: (value: { user: ApiUser | null }) => void;
  vi.mocked(api.me).mockImplementation(() => new Promise(resolve => { finish = resolve; })); page();
  expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull(); expect(api.listConnections).not.toHaveBeenCalled();
  await act(async () => { finish({ user }); }); await signIn();
  expect(api.listConnections).toHaveBeenCalledTimes(1); expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
});
it("renders a supplied identity without an auth request during static rendering", () => {
  render(<MemoryRouter initialEntries={["/"]}><App initialUser={user} staticRender /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "Sign out" })).toBeTruthy();
  expect(api.me).not.toHaveBeenCalled();
});
it("treats an authentication lookup failure as signed-out and does not expose its details", async () => {
  vi.mocked(api.me).mockRejectedValue(new Error("Private authentication failure")); page(); await screen.findByText("Please sign in to continue.");
  expect(document.body.textContent).not.toContain("Private authentication failure"); expect(api.listConnections).not.toHaveBeenCalled();
});
it("shows account identity, logout and the authenticated navigation", async () => {
  page(); await signIn(); expect(screen.getByText(user.githubLogin)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Sign out" }).getAttribute("href")).toBe("/logout");
  for (const name of ["Connections", "Destinations", "Monitors", "CLI access", "Deployments"]) expect(screen.getByRole("link", { name })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Connections" }).hasAttribute("data-active")).toBe(true);
});
it("navigates between the real account pages and updates active links", async () => {
  page(); await signIn(); fireEvent.click(screen.getByRole("link", { name: "Destinations" }));
  await screen.findByRole("heading", { name: "Destinations" }); expect(screen.getByLabelText("Current route").textContent).toBe("/app/destinations");
  expect(screen.getByRole("link", { name: "Destinations" }).hasAttribute("data-active")).toBe(true);
  expect(screen.getByRole("link", { name: "Connections" }).hasAttribute("data-active")).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: "Monitors" })); await screen.findByRole("heading", { name: "Monitors" });
  fireEvent.click(screen.getByRole("link", { name: "CLI access" })); await screen.findByText("No active CLI clients.");
  expect(screen.getByRole("link", { name: "CLI access" }).hasAttribute("data-active")).toBe(true);
});
it("allows the CLI login return page without redirecting an anonymous user to the homepage", async () => {
  vi.mocked(api.me).mockResolvedValue({ user: null }); page("/app/cli?code=FIXTURE-CODE");
  await screen.findByText("Sign in to authorize the CLI for your Logtura account."); expect(screen.getByLabelText("Current route").textContent).toBe("/app/cli?code=FIXTURE-CODE");
  expect(screen.getAllByRole("link", { name: "Sign in with GitHub" }).some(link => link.getAttribute("href") === "/login/github?return_to=%2Fapp%2Fcli%3Fcode%3DFIXTURE-CODE")).toBe(true);
  expect(api.cliTokens).not.toHaveBeenCalled();
});
it("keeps public routes accessible when signed out and redirects unknown routes home", async () => {
  vi.mocked(api.me).mockResolvedValue({ user: null }); page("/missing/route");
  await screen.findByRole("link", { name: "Sign in with GitHub" }); expect(screen.getByLabelText("Current route").textContent).toBe("/");
  expect(screen.getByRole("heading", { name: "Every log, from every provider, in five minutes." })).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Docs" }).every(link => link.getAttribute("href") === "/docs")).toBe(true);
  expect(api.listDeployments).not.toHaveBeenCalled();
});
it("renders public documentation through the production MDX transformation", async () => {
  vi.mocked(api.me).mockResolvedValue({ user: null }); page("/docs/open-source");
  await screen.findByRole("heading", { name: "Logtura Docs" });
  expect(screen.getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe("https://github.com/logtura/logtura");
  expect(screen.getByRole("heading", { name: /Open.source/ })).toBeTruthy();
  expect(api.listDeployments).not.toHaveBeenCalled();
});
it.each([["/privacy", "Logtura privacy policy"], ["/privacy/plugin", "Logtura plugin privacy notice"], ["/terms", "Logtura terms of use"], ["/support", "Logtura support"]])("serves %s without account authorization or redirect", async (path, title) => {
  vi.mocked(api.me).mockResolvedValue({ user: null }); page(path);
  await screen.findByRole("link", { name: "Sign in with GitHub" });
  expect(screen.getByRole("heading", { name: title, level: 1 })).toBeTruthy();
  expect(screen.getByLabelText("Current route").textContent).toBe(path);
  expect(api.listDeployments).not.toHaveBeenCalled();
});
it("states that the skills-only plugin has no MCP server or Logtura data collection", async () => {
  vi.mocked(api.me).mockResolvedValue({ user: null }); page("/privacy/plugin");
  await screen.findByRole("heading", { name: "Logtura plugin privacy notice" });
  expect(screen.getByText(/contains no MCP server, remote API connection, hosted backend/)).toBeTruthy();
  expect(screen.getByText(/Installing or using the plugin sends no data to Logtura/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "General Logtura privacy policy" }).getAttribute("href")).toBe("/privacy");
});
it("explains standalone and linked data handling, license, and the actual support channel", async () => {
  vi.mocked(api.me).mockResolvedValue({ user: null }); page("/privacy");
  await screen.findByRole("link", { name: "Sign in with GitHub" });
  expect(screen.getByText(/Installing the skill does not create a Logtura account/)).toBeTruthy();
  expect(screen.getByText(/this policy does not specify a fixed retention period/)).toBeTruthy();
  expect(screen.getByText(/encrypted in storage/)).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Terms" }));
  expect(screen.getByRole("link", { name: "Read the Apache 2.0 license" }).getAttribute("href")).toBe("https://github.com/logtura/logtura/blob/main/LICENSE");
  fireEvent.click(screen.getByRole("link", { name: "Support" }));
  expect(screen.getByRole("link", { name: "Open or search a support issue" }).getAttribute("href")).toBe("https://github.com/logtura/logtura/issues");
  expect(screen.getByText(/request a private contact channel before sharing details/)).toBeTruthy();
});
it("refreshes the deployment badge every 30 seconds and preserves it across transient failures", async () => {
  vi.mocked(api.listDeployments).mockResolvedValueOnce({ deployments: [deployment] }).mockRejectedValueOnce(new Error("Transient" )).mockResolvedValue({ deployments: [] });
  vi.useFakeTimers(); page("/app/cli"); await act(async () => {});
  const navigation = screen.getByRole("link", { name: "Deployments 1" }); expect(within(navigation).getByText("1")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(within(navigation).getByText("1")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(within(navigation).queryByText("1")).toBeNull(); expect(api.listDeployments).toHaveBeenCalledTimes(3);
});
it("stops polling and ignores a late navigation-badge response after unmount", async () => {
  let finish!: (value: { deployments: ApiDeployment[] }) => void;
  vi.mocked(api.listDeployments).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers(); const view = page("/app/cli"); await act(async () => {}); view.unmount();
  await act(async () => { finish({ deployments: [deployment] }); await vi.advanceTimersByTimeAsync(60_000); });
  expect(api.listDeployments).toHaveBeenCalledTimes(1);
});
it("uses a safe fallback for non-API failures while retaining actionable API messages", () => {
  expect(reportApiError(new Error("Private detail"), "Retry")).toBe("Retry");
  expect(reportApiError(new ApiError("", 500), "Retry")).toBe("Retry");
  expect(reportApiError(new ApiError("Session expired", 401), "Retry")).toBe("Session expired");
});
