import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../api";
import type { ApiConnection, ApiDeployTarget, ApiProvider } from "../types";
import { NewConnection } from "./NewConnection";
const connection = { id: "con_created" } as ApiConnection;
function provider(id = "cloudflare", displayName = "Cloudflare", overrides: Partial<ApiProvider> = {}): ApiProvider {
  return { id, displayName, connectFlow: {
    kind: "external_token", url: "https://example.com/create-token", buttonLabel: `Connect ${displayName}`,
    buttonDescription: "Create a scoped read-only token", pasteFieldName: "token", manualInstructions: "Create a token in account settings",
  }, formFields: [{ name: "token", label: "API token", type: "password", required: true }, { name: "account", label: "Account ID", type: "text", required: false }], ...overrides };
}
function Location() { const location = useLocation(); return <output aria-label="Current route">{location.pathname}</output>; }
function page(query = "") {
  render(<MantineProvider env="test"><MemoryRouter initialEntries={[`/app/connections/new${query}`]}><Routes>
    <Route path="/app/connections/new" element={<NewConnection />} /><Route path="*" element={<Location />} />
  </Routes></MemoryRouter></MantineProvider>);
  return userEvent.setup();
}
async function name(user: ReturnType<typeof userEvent.setup>, value = "Production") {
  await user.type(screen.getByRole("textbox", { name: "Connection name" }), value);
}
async function manual(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Or create the token manually" }));
}
beforeEach(() => {
  vi.spyOn(api, "providers").mockResolvedValue({ providers: [provider()] });
  vi.spyOn(api, "listDeployTargets").mockResolvedValue({ deployTargets: [] });
  vi.spyOn(api, "getConnectionByProviderInstallation").mockResolvedValue({ connection: null });
  vi.spyOn(api, "createConnection").mockResolvedValue({ connection });
  vi.spyOn(api, "createConnectionFromBootstrap").mockResolvedValue({ connection });
});
it("starts disabled while loading and provides the cancellation route", async () => {
  let resolve!: (value: { providers: ApiProvider[] }) => void;
  vi.mocked(api.providers).mockReturnValue(new Promise(r => { resolve = r; }));
  page(); expect((screen.getByRole("textbox", { name: "Provider" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole("link", { name: "Cancel" }).getAttribute("href")).toBe("/app");
  expect((screen.getByRole("button", { name: "Verify & continue" }) as HTMLButtonElement).disabled).toBe(true);
  resolve({ providers: [provider()] });
  await screen.findByRole("link", { name: "Connect Cloudflare" });
  expect(screen.queryByLabelText(/^API token/)).toBeNull();
});
it("reveals token fields only after authorization and submits the complete provider form", async () => {
  const user = page(); await name(user);
  const link = await screen.findByRole("link", { name: "Connect Cloudflare" });
  expect(link.getAttribute("target")).toBe("_blank"); expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  await user.click(link); await screen.findByText("Paste the token below.");
  await user.type(screen.getByLabelText(/^API token/), "fixture-token");
  await user.type(screen.getByRole("textbox", { name: "Account ID" }), "fixture-account");
  expect((screen.getByLabelText(/^API token/) as HTMLInputElement).type).toBe("password");
  await user.click(screen.getByRole("button", { name: "Verify & continue" }));
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/app/connections/con_created"));
  const form = vi.mocked(api.createConnection).mock.calls[0]![0];
  expect(Object.fromEntries(form.entries())).toEqual({ provider: "cloudflare", display_name: "Production", token: "fixture-token", account: "fixture-account" });
});
it("keeps provider credentials and authorization state isolated when changing providers", async () => {
  vi.mocked(api.providers).mockResolvedValue({ providers: [provider(), provider("railway-logs", "Railway")] });
  const user = page(); await manual(user); await name(user);
  await user.type(screen.getByLabelText(/^API token/), "cloudflare-fixture-secret");
  await user.type(screen.getByRole("textbox", { name: "Account ID" }), "cloudflare-account");
  await user.click(screen.getByRole("textbox", { name: "Provider" }));
  await user.click(await screen.findByRole("option", { name: "Railway" }));
  expect(screen.queryByLabelText(/^API token/)).toBeNull();
  expect(screen.queryByText("Create a token in account settings")).toBeNull();
  await manual(user);
  expect((screen.getByLabelText(/^API token/) as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("textbox", { name: "Account ID" }) as HTMLInputElement).value).toBe("");
  await user.type(screen.getByLabelText(/^API token/), "railway-fixture-secret");
  await user.click(screen.getByRole("button", { name: "Verify & continue" }));
  await waitFor(() => expect(api.createConnection).toHaveBeenCalledTimes(1));
  expect(Object.fromEntries(vi.mocked(api.createConnection).mock.calls[0]![0].entries())).toEqual({ provider: "railway-logs", display_name: "Production", token: "railway-fixture-secret", account: "" });
});
it.each([new ApiError("Token rejected", 401), new Error("Unexpected")])("allows retry after a failed verification", async error => {
  vi.mocked(api.createConnection).mockRejectedValueOnce(error);
  const user = page(); await name(user); await manual(user);
  await user.type(screen.getByLabelText(/^API token/), "fixture-token");
  await user.click(screen.getByRole("button", { name: "Verify & continue" }));
  expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? "Token rejected" : "Something went wrong");
  expect((screen.getByLabelText(/^API token/) as HTMLInputElement).value).toBe("fixture-token");
  await user.click(screen.getByRole("button", { name: "Verify & continue" }));
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/app/connections/con_created"));
});
it("offers only compatible deploy identities and mints with the selected scope", async () => {
  const targets = [{ id: "target_fly", kind: "fly", displayName: "Fly organization", externalAccountId: "org_fixture", mintsForProviders: ["cloudflare"], createdAt: 0, updatedAt: 0 }, { id: "target_other", kind: "fly", displayName: "Unrelated", externalAccountId: null, mintsForProviders: ["fly-log-tail"], createdAt: 0, updatedAt: 0 }] as ApiDeployTarget[];
  vi.mocked(api.listDeployTargets).mockResolvedValue({ deployTargets: targets });
  const user = page(); await screen.findByText("Fly organization"); expect(screen.queryByText("Unrelated")).toBeNull();
  expect((screen.getByRole("button", { name: "Mint & connect" }) as HTMLButtonElement).disabled).toBe(true);
  await name(user); await user.click(screen.getByRole("button", { name: "Mint & connect" }));
  await waitFor(() => expect(api.createConnectionFromBootstrap).toHaveBeenCalledWith({ deployTargetId: "target_fly", providerId: "cloudflare", displayName: "Production", scope: "org_fixture" }));
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/app/connections/con_created"));
});
it.each([new ApiError("Mint unavailable", 503), "unexpected"])("allows bootstrap retries and omits absent organization scope", async error => {
  vi.mocked(api.listDeployTargets).mockResolvedValue({ deployTargets: [{ id: "target", kind: "fly", displayName: "Identity", externalAccountId: null, mintsForProviders: ["cloudflare"], createdAt: 0, updatedAt: 0 } as ApiDeployTarget] });
  vi.mocked(api.createConnectionFromBootstrap).mockRejectedValueOnce(error);
  const user = page(); await screen.findByText("Identity"); await name(user);
  await user.click(screen.getByRole("button", { name: "Mint & connect" }));
  expect((await screen.findByRole("alert")).textContent).toContain(error instanceof ApiError ? "Mint unavailable" : "Something went wrong");
  await user.click(screen.getByRole("button", { name: "Mint & connect" }));
  await waitFor(() => expect(api.createConnectionFromBootstrap).toHaveBeenLastCalledWith({ deployTargetId: "target", providerId: "cloudflare", displayName: "Production", scope: undefined }));
});
it.each(["vercel", "railway"])("normalizes the %s installation return and opens an existing connection", async alias => {
  const id = `${alias}-logs`; vi.mocked(api.providers).mockResolvedValue({ providers: [provider(), provider(id, alias)] });
  vi.mocked(api.getConnectionByProviderInstallation).mockResolvedValue({ connection });
  page(`?provider=${alias}&configurationId=installation-fixture`);
  await waitFor(() => expect(api.getConnectionByProviderInstallation).toHaveBeenCalledWith(id, "installation-fixture"));
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/app/connections/con_created"));
});
it("retains the requested provider and installation in the OAuth shortcut while preserving token fallback", async () => {
  const oauthShortcut = { startPath: "/api/oauth/start", buttonLabel: "Authorize Supabase", buttonDescription: "Choose a project" };
  vi.mocked(api.providers).mockResolvedValue({ providers: [provider(), provider("supabase-edge-logs", "Supabase", { oauthShortcut })] });
  const user = page("?provider=supabase-edge-logs&configurationId=config%26fixture&error=oauth_state");
  await screen.findByText("Supabase OAuth state didn't match. Try connecting again from scratch.");
  await waitFor(() => expect(screen.getAllByText("Authorize Supabase").some(element => element.closest("a"))).toBe(true));
  await name(user, "Site & Account");
  const href = screen.getByRole("link", { name: "Authorize Supabase" }).getAttribute("href")!;
  const url = new URL(href, "https://logtura.invalid");
  expect(url.searchParams.get("display_name")).toBe("Site & Account"); expect(url.searchParams.get("configurationId")).toBe("config&fixture");
  expect(screen.getByRole("link", { name: "Connect Supabase" })).toBeTruthy();
  await manual(user); expect(screen.getByLabelText(/^API token/)).toBeTruthy();
});
it("keeps the paste flow functional when optional identity and installation lookups fail", async () => {
  vi.mocked(api.listDeployTargets).mockRejectedValue(new Error("Unavailable"));
  vi.mocked(api.getConnectionByProviderInstallation).mockRejectedValue(new Error("Unavailable"));
  const user = page("?provider=missing&configurationId=missing&error=unknown");
  await manual(user); expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Provider" }) as HTMLInputElement).value).toBe("Cloudflare");
});
it("shows provider load failures and disables verification for an empty provider catalog", async () => {
  vi.mocked(api.providers).mockRejectedValueOnce(new Error("Unavailable"));
  page(); expect((await screen.findByRole("alert")).textContent).toContain("Failed to load providers");
});
it("renders direct credential fields without a connect flow", async () => {
  vi.mocked(api.providers).mockResolvedValue({ providers: [provider("custom", "Custom", { connectFlow: null })] });
  const user = page(); await screen.findByLabelText(/^API token/); await name(user);
  await user.type(screen.getByLabelText(/^API token/), "direct-fixture-token");
  await user.click(screen.getByRole("button", { name: "Verify & continue" }));
  await waitFor(() => expect(api.createConnection).toHaveBeenCalledTimes(1));
});
it("does not offer verification with an empty catalog", async () => {
  vi.mocked(api.providers).mockResolvedValue({ providers: [] }); page();
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Provider" }) as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByRole("button", { name: "Verify & continue" }) as HTMLButtonElement).disabled).toBe(true);
});
