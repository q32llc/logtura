import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../api";
import type { ApiDestination, ApiDestinationDriver } from "../types";
import { Destinations } from "./Destinations";
const destination: ApiDestination = { id: "dst_one", kind: "webhook", displayName: "Production alerts", flows: ["logs"], createdAt: Date.UTC(2026, 9, 2), updatedAt: 0 };
const webhook: ApiDestinationDriver = { id: "webhook", displayName: "Webhook", description: "Send events to your endpoint", connectFlow: null, formFields: [{ name: "url", label: "URL", type: "text", required: true }, { name: "secret", label: "Secret", type: "password", required: false }] };
const slack: ApiDestinationDriver = { id: "slack", displayName: "Slack", description: "Send messages to Slack", connectFlow: { kind: "oauth_redirect", startPath: "/api/slack/start", buttonLabel: "Connect Slack", buttonDescription: "Choose a Slack workspace" }, formFields: [] };
function Location() { return <output aria-label="Current query">{useLocation().search}</output>; }
function page(query = "") { render(<MantineProvider env="test"><MemoryRouter initialEntries={[`/app/destinations${query}`]}><Destinations /><Location /></MemoryRouter></MantineProvider>); return userEvent.setup(); }
async function open(user: ReturnType<typeof userEvent.setup>, name = "Webhook") {
  await user.click(await screen.findByRole("button", { name: `Add ${name} destination` })); return within(await screen.findByRole("dialog", { name: `Add ${name} destination` }));
}
beforeEach(() => {
  vi.spyOn(notifications, "show").mockImplementation(() => "notification"); vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "listDestinations").mockResolvedValue({ destinations: [] });
  vi.spyOn(api, "destinationDrivers").mockResolvedValue({ drivers: [webhook, slack] });
  vi.spyOn(api, "createDestination").mockResolvedValue({ destination });
  vi.spyOn(api, "deleteDestination").mockResolvedValue({ ok: true });
});
it("opens destination choices from the keyboard", async () => {
  const user = page(); const choice = await screen.findByRole("button", { name: "Add Webhook destination" });
  await user.tab(); expect(document.activeElement).toBe(choice); await user.keyboard("{Enter}");
  expect(await screen.findByRole("dialog", { name: "Add Webhook destination" })).toBeTruthy();
});
it("creates a destination from independently typed public and private fields", async () => {
  const user = page(); await screen.findByText("No destinations yet. Pick one above."); const dialog = await open(user);
  await user.type(dialog.getByRole("textbox", { name: "Display name" }), "Production alerts");
  await user.type(dialog.getByRole("textbox", { name: "URL" }), "https://example.com/events");
  const secret = dialog.getByLabelText("Secret") as HTMLInputElement; expect(secret.type).toBe("password"); expect(secret.autocomplete).toBe("off");
  await user.type(secret, "fixture-only-secret");
  vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [destination] });
  await user.click(dialog.getByRole("button", { name: "Add destination" }));
  await screen.findByRole("region", { name: "Destination Production alerts" });
  expect(Object.fromEntries(vi.mocked(api.createDestination).mock.calls[0]![0].entries())).toEqual({ kind: "webhook", display_name: "Production alerts", url: "https://example.com/events", secret: "fixture-only-secret" });
  expect(notifications.show).toHaveBeenCalledWith({ message: "Destination added", color: "teal" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("discards cancelled credentials and isolates drafts across destination drivers", async () => {
  vi.mocked(api.destinationDrivers).mockResolvedValue({ drivers: [webhook, { ...webhook, id: "custom", displayName: "Custom" }] });
  const user = page(); let dialog = await open(user);
  await user.type(dialog.getByRole("textbox", { name: "Display name" }), "Discarded"); await user.type(dialog.getByLabelText("Secret"), "discarded-fixture-secret");
  await user.click(dialog.getByRole("button", { name: "Cancel" })); expect(api.createDestination).not.toHaveBeenCalled();
  dialog = await open(user, "Custom"); expect((dialog.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe(""); expect((dialog.getByLabelText("Secret") as HTMLInputElement).value).toBe("");
  await user.keyboard("{Escape}"); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  dialog = await open(user); expect((dialog.getByLabelText("Secret") as HTMLInputElement).value).toBe("");
});
it("omits unspecified optional fields from input state while sending their declared empty values", async () => {
  const user = page(), dialog = await open(user);
  await user.type(dialog.getByRole("textbox", { name: "Display name" }), "Public endpoint");
  await user.type(dialog.getByRole("textbox", { name: "URL" }), "https://example.com/events");
  await user.click(dialog.getByRole("button", { name: "Add destination" }));
  await waitFor(() => expect(api.createDestination).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.createDestination).mock.calls[0]![0].get("secret")).toBe("");
});
it.each([new ApiError("Invalid URL", 400), "unexpected"])("retains failed destination creation for retry", async error => {
  vi.mocked(api.createDestination).mockRejectedValueOnce(error); const user = page(), dialog = await open(user);
  await user.type(dialog.getByRole("textbox", { name: "Display name" }), "Retry");
  await user.click(dialog.getByRole("button", { name: "Add destination" }));
  expect((await dialog.findByRole("alert")).textContent).toContain(error instanceof ApiError ? error.message : "Failed");
  expect((dialog.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe("Retry");
  await user.click(dialog.getByRole("button", { name: "Add destination" })); await waitFor(() => expect(api.createDestination).toHaveBeenCalledTimes(2));
});
it("opens the advertised OAuth start route without submitting credential form data", async () => {
  const user = page(), dialog = await open(user, "Slack");
  expect(dialog.getByRole("link", { name: "Connect Slack" }).getAttribute("href")).toBe("/api/slack/start");
  expect(dialog.getByText("Choose a Slack workspace")).toBeTruthy(); expect(dialog.queryByRole("textbox")).toBeNull();
  expect(dialog.queryByRole("button", { name: "Add destination" })).toBeNull(); expect(api.createDestination).not.toHaveBeenCalled();
});
it.each([
  ["?notice=slack_connected", "Slack workspace connected."],
  ["?error=oauth_state", "Slack OAuth failed: bad state. Try connecting again."],
  ["?error=slack_not_configured", "Slack OAuth isn't configured on this deployment. Use a webhook destination instead."],
  ["?error=slack_exchange", "Slack rejected the OAuth exchange. Try again from scratch."],
])("shows and dismisses OAuth return status (%s)", async (query, message) => {
  const user = page(query); const alert = await screen.findByRole("alert"); expect(alert.textContent).toContain(message);
  await user.click(within(alert).getByRole("button")); await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByLabelText("Current query").textContent).toBe("");
});
it("ignores unknown return status while allowing existing destination management without the driver catalog", async () => {
  vi.mocked(api.destinationDrivers).mockRejectedValue(new Error("Unavailable"));
  vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [destination, { ...destination, id: "dst_custom", kind: "custom", displayName: "Custom output" }] });
  page("?notice=unknown&error=unknown"); await screen.findByRole("region", { name: "Destination Production alerts" });
  expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByText("Custom output")).toBeTruthy(); expect(screen.getAllByText("Created 2026-10-02")).toHaveLength(2);
});
it.each([new ApiError("Account unavailable", 503), "unexpected"])("reports destination catalog failures", async error => {
  vi.mocked(api.listDestinations).mockRejectedValue(error); page(); await screen.findByText(error instanceof ApiError ? error.message : "Failed to load");
  expect(await screen.findByRole("button", { name: "Add Webhook destination" })).toBeTruthy();
});
it("requires confirmation before deleting the selected destination and refreshes after deletion", async () => {
  vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [destination] }); const user = page(); const card = within(await screen.findByRole("region", { name: "Destination Production alerts" }));
  vi.mocked(window.confirm).mockReturnValueOnce(false); await user.click(card.getByRole("button", { name: "Delete" })); expect(api.deleteDestination).not.toHaveBeenCalled();
  vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [] }); await user.click(card.getByRole("button", { name: "Delete" }));
  await screen.findByText("No destinations yet. Pick one above."); expect(api.deleteDestination).toHaveBeenCalledWith("dst_one");
  expect(window.confirm).toHaveBeenCalledWith("Delete this destination? Sinks pointing at it will also be removed."); expect(notifications.show).toHaveBeenCalledWith({ message: "Destination deleted", color: "teal" });
});
it.each([new ApiError("Deletion refused", 409), "unexpected"])("keeps the destination visible after a failed deletion", async error => {
  vi.mocked(api.listDestinations).mockResolvedValue({ destinations: [destination] }); vi.mocked(api.deleteDestination).mockRejectedValue(error);
  const user = page(), card = within(await screen.findByRole("region", { name: "Destination Production alerts" })); await user.click(card.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(notifications.show).toHaveBeenCalledWith({ message: error instanceof ApiError ? error.message : "Failed", color: "red" }));
  expect(card.getByText("Production alerts")).toBeTruthy();
});
