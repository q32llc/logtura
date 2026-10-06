import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it } from "vitest";
import { Home } from "./Home";
import { Docs } from "./Docs";
const user = { id: "usr_public", githubLogin: "fixture", name: null, email: null, avatarUrl: null };
function home(path = "/", signedIn = false) { return render(<MantineProvider env="test"><MemoryRouter initialEntries={[path]}><Home user={signedIn ? user : null} /></MemoryRouter></MantineProvider>); }
function docs(path = "/docs") { return render(<MantineProvider env="test"><MemoryRouter initialEntries={[path]}><Routes><Route path="/docs" element={<Docs />} /><Route path="/docs/:slug" element={<Docs />} /></Routes></MemoryRouter></MantineProvider>); }
it("offers standalone documentation and GitHub sign-up to anonymous visitors", () => {
  home(); expect(screen.getAllByRole("link", { name: "Sign up with GitHub" }).every(link => link.getAttribute("href") === "/login/github")).toBe(true);
  expect(screen.getByRole("link", { name: "How it works" }).getAttribute("href")).toBe("#how");
  expect(screen.getAllByRole("link", { name: "Docs" }).every(link => link.getAttribute("href") === "/docs")).toBe(true);
  for (const label of ["Privacy", "Terms", "Support"]) expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(`/${label.toLowerCase()}`);
});
it("routes signed-in visitors to their dashboard", () => {
  home("/", true); expect(screen.getByRole("link", { name: "Go to dashboard" }).getAttribute("href")).toBe("/app");
  expect(screen.queryByRole("link", { name: "Sign up with GitHub" })).toBeNull();
});
it.each([["oauth_state", "Sign-in failed: bad OAuth state. Please try again."], ["auth_required", "Please sign in to continue."]])("explains the %s authentication return", (code, message) => { home(`/?error=${code}`); expect(screen.getByText(message)).toBeTruthy(); });
it("does not echo an unknown authentication error into the page", () => { home("/?error=private-provider-detail"); expect(document.body.textContent).not.toContain("private-provider-detail"); });
it.each([["overview", "Architecture"], ["hosted-ux", "Hosted UI"], ["deploy", "Deploy"], ["open-source", "Open source"], ["agent-skills", "Use Logtura with Claude Code or Codex"]])("renders the real %s documentation", (slug, heading) => {
  docs(`/docs/${slug}`); expect(screen.getByRole("heading", { name: heading, level: 1 })).toBeTruthy();
  expect(screen.getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe("https://github.com/logtura/logtura");
  expect(screen.getAllByRole("link", { name: new RegExp(`^${slug === "overview" ? "Overview" : slug === "hosted-ux" ? "Hosted UX" : slug === "agent-skills" ? "Claude Code & Codex" : heading}`) }).every(link => link.hasAttribute("data-active"))).toBe(true);
});
it("redirects an unknown documentation slug to the architecture page", () => { docs("/docs/unknown"); expect(screen.getByRole("heading", { name: "Architecture", level: 1 })).toBeTruthy(); });
it("navigates documentation sections while retaining the public layout", () => {
  docs(); fireEvent.click(screen.getAllByRole("link", { name: /^Open source/ })[0]!);
  expect(screen.getByRole("heading", { name: "Open source", level: 1 })).toBeTruthy(); expect(screen.getByRole("heading", { name: "Logtura Docs" })).toBeTruthy();
});
it("renders documentation tables, code samples and screenshot captions with meaningful content", () => {
  docs("/docs/hosted-ux"); expect(screen.getByRole("img", { name: "Connections list" }).getAttribute("src")).toBe("/docs-screenshots/connections.png");
  expect(screen.getByText("Connections list", { selector: "p" })).toBeTruthy();
  expect(within(screen.getAllByRole("table")[0]!).getByRole("columnheader", { name: "Provider" })).toBeTruthy();
});
it("documents supported standalone commands and the desired/applied distinction", () => {
  docs("/docs/open-source"); expect(screen.getByText(/logt -c logt.yaml validate/)).toBeTruthy();
  expect(screen.getByText(/logt -c linked.yaml push/)).toBeTruthy(); expect(screen.getByText(/Push does not restart the forwarder/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("install-zip"); expect(document.body.textContent).not.toContain("LOGTURA_HEARTBEAT_URL");
});
