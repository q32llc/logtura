import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { ApiConnectFlow } from "../types";
import { ConnectSection, renderField } from "./ConnectSection";
const token: ApiConnectFlow = { kind: "external_token", url: "https://example.com/tokens", buttonLabel: "Connect Provider", buttonDescription: "Scoped read-only access", pasteFieldName: "token", manualInstructions: "Open token settings" };
it("tracks external authorization, safely reopens its URL and toggles manual instructions", async () => {
  const user = userEvent.setup(); const connected = vi.fn();
  function Host() {
    const [clicked, setClicked] = useState(false), [manual, setManual] = useState(false);
    return <ConnectSection providerName="Provider" flow={token} clicked={clicked} onConnect={() => { connected(); setClicked(true); }}
      showManual={manual} toggleManual={() => setManual(v => !v)} stepIndex={8} />;
  }
  render(<MantineProvider env="test"><Host /></MantineProvider>);
  const link = screen.getByRole("link", { name: "Connect Provider" });
  expect(link.getAttribute("href")).toBe(token.url); expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  await user.click(link); expect(connected).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "Re-open Provider" })).toBeTruthy(); expect(screen.getByText("Paste the token below.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Or create the token manually" }));
  expect(screen.getByText("Open token settings")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Hide manual instructions" }));
  expect(screen.queryByText("Open token settings")).toBeNull();
});
it("omits the stepper and manual controls when a reconnect host does not need them", () => {
  render(<MantineProvider><ConnectSection providerName="Provider" flow={{ ...token, manualInstructions: undefined }} clicked={false}
    onConnect={vi.fn()} showManual={false} toggleManual={vi.fn()} stepIndex={0} showStepper={false} /></MantineProvider>);
  expect(screen.queryByText("Name")).toBeNull(); expect(screen.queryByRole("button")).toBeNull();
});
it.each([undefined, "", "   "])("requires a nonblank name before OAuth authorization (%s)", displayName => {
  render(<MantineProvider><ConnectSection providerName="Provider" flow={{ kind: "oauth_redirect", startPath: "/api/oauth/start", buttonLabel: "Authorize", buttonDescription: "Grant scoped access" }}
    displayName={displayName} clicked={false} onConnect={vi.fn()} showManual={false} toggleManual={vi.fn()} stepIndex={0} /></MantineProvider>);
  expect(screen.getByText("Pick a connection name first.")).toBeTruthy();
  const button = screen.getByText("Authorize").closest("a")!;
  expect(button.getAttribute("href")).toBeNull(); expect(button.getAttribute("data-disabled")).toBe("true");
});
it("encodes an OAuth connection name in the service start URL", () => {
  render(<MantineProvider><ConnectSection providerName="Provider" flow={{ kind: "oauth_redirect", startPath: "/api/oauth/start", buttonLabel: "Authorize", buttonDescription: "Grant scoped access" }}
    displayName="Site & Account/東京" clicked={false} onConnect={vi.fn()} showManual={false} toggleManual={vi.fn()} stepIndex={0} /></MantineProvider>);
  const href = screen.getByRole("link", { name: "Authorize" }).getAttribute("href")!;
  expect(new URL(href, "https://logtura.invalid").searchParams.get("display_name")).toBe("Site & Account/東京");
  expect(screen.queryByText("Pick a connection name first.")).toBeNull();
});
it("leaves CLI session controls to the owning deploy page", () => {
  const { container } = render(<MantineProvider><ConnectSection providerName="Fly" flow={{ kind: "cli_session", startPath: "/start", pollPath: "/poll", buttonLabel: "Connect", buttonDescription: "CLI login" }}
    clicked={false} onConnect={vi.fn()} showManual={false} toggleManual={vi.fn()} stepIndex={0} /></MantineProvider>);
  expect(container.querySelector("a, button, input")).toBeNull();
});
it("renders secret and text fields with independent state and no credential autofill", async () => {
  const user = userEvent.setup();
  function Host() { const [values, setValues] = useState<Record<string, string>>({ account: "Account fixture" }); return <>
    {renderField({ name: "token", label: "API token", type: "password", required: true, description: "Keep private", placeholder: "Paste token" }, values, setValues)}
    {renderField({ name: "account", label: "Account", type: "text", required: false }, values, setValues)}
  </>; }
  render(<MantineProvider><Host /></MantineProvider>);
  const secret = screen.getByLabelText(/^API token/) as HTMLInputElement;
  expect(secret.type).toBe("password"); expect(secret.autocomplete).toBe("off"); expect(secret.required).toBe(true); expect(secret.value).toBe("");
  await user.type(secret, "fixture-only-token");
  const account = screen.getByRole("textbox", { name: "Account" }) as HTMLInputElement;
  expect(account.value).toBe("Account fixture"); await user.clear(account); await user.type(account, "Replacement fixture");
  expect(secret.value).toBe("fixture-only-token"); expect(account.value).toBe("Replacement fixture");
});
