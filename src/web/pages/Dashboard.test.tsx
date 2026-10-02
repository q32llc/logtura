import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { api } from "../api";
import type { ApiConnection } from "../types";
import { Dashboard } from "./Dashboard";
function page() { render(<MantineProvider><MemoryRouter><Dashboard /></MemoryRouter></MantineProvider>); }
it("provides account setup navigation for an empty connection catalog", async () => {
  vi.spyOn(api, "listConnections").mockResolvedValue({ connections: [] }); page();
  await screen.findByText("No connections yet.");
  for (const name of ["Add connection", "Add your first connection"]) expect(screen.getByRole("link", { name }).getAttribute("href")).toBe("/app/connections/new");
});
it("shows connection identities, discovery timestamps and their management routes", async () => {
  const now = Date.UTC(2026, 9, 2, 12); vi.spyOn(Date, "now").mockReturnValue(now);
  const timestamps = [null, now - 30_000, now - 120_000, now - 7_200_000, now - 172_800_000];
  vi.spyOn(api, "listConnections").mockResolvedValue({ connections: timestamps.map((lastDiscoveredAt, index) => ({ id: `con_${index}`, displayName: `Connection ${index}`, provider: "cloudflare", externalAccountId: index ? `account_${index}` : null, lastDiscoveredAt }) as ApiConnection) });
  page(); await screen.findByText("Connection 0");
  for (const [index, suffix] of ["not discovered yet", "last discovered just now", "last discovered 2m ago", "last discovered 2h ago", "last discovered 2026-09-30"].entries()) {
    const link = screen.getByRole("link", { name: new RegExp(`Connection ${index}`) });
    expect(link.getAttribute("href")).toBe(`/app/connections/con_${index}`); expect(link.textContent).toContain(suffix);
  }
  expect(screen.queryByText("No connections yet.")).toBeNull();
});
it("reports catalog load failure while keeping the add-connection action available", async () => {
  vi.spyOn(api, "listConnections").mockRejectedValue(new Error("Unavailable")); page();
  await screen.findByText("Failed to load connections"); expect(screen.getByRole("link", { name: "Add connection" })).toBeTruthy();
});
