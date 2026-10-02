import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { SelectionEditor } from "./SelectionEditor";

const items = [{ id: "a", label: "Site A", sublabel: "Production" }, { id: "b", label: "Site B" }];
it("changes wildcard selection to an explicit subset and retains it when customization is hidden", async () => {
  const user = userEvent.setup();
  function Editor() {
    const [all, setAll] = useState(true);
    const [picked, setPicked] = useState(new Set(["a", "b"]));
    return <SelectionEditor label="Sources" hint="Choose sites" all={all} onAll={setAll} items={items} picked={picked}
      toggle={(id, on) => { setAll(false); setPicked(previous => { const next = new Set(previous); if (on) next.add(id); else next.delete(id); return next; }); }} />;
  }
  render(<MantineProvider><Editor /></MantineProvider>);
  expect(screen.queryByRole("switch", { name: "Site A" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Customize" }));
  expect((screen.getByRole("switch", { name: "Site A" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("Production")).toBeTruthy();
  await user.click(screen.getByRole("switch", { name: "Site B" }));
  expect(screen.getByRole("switch", { name: "1 of 2" })).toBeTruthy();
  expect((screen.getByRole("switch", { name: "Site B" }) as HTMLInputElement).checked).toBe(false);
  await user.click(screen.getByRole("button", { name: "Hide" }));
  await user.click(screen.getByRole("button", { name: "Customize" }));
  expect((screen.getByRole("switch", { name: "Site B" }) as HTMLInputElement).checked).toBe(false);
  await user.click(screen.getByRole("switch", { name: "1 of 2" }));
  expect(screen.getByRole("switch", { name: "All selected" })).toBeTruthy();
  expect((screen.getByRole("switch", { name: "Site B" }) as HTMLInputElement).checked).toBe(true);
});
it("starts expanded when requested and uses stable IDs for explicitly chosen items", async () => {
  const toggle = vi.fn(), onAll = vi.fn(), user = userEvent.setup();
  render(<MantineProvider><SelectionEditor label="Monitors" hint="Choose routes" all={false} onAll={onAll} items={items}
    picked={new Set(["b"])} toggle={toggle} initiallyExpanded /></MantineProvider>);
  expect((screen.getByRole("switch", { name: "Site A" }) as HTMLInputElement).checked).toBe(false);
  await user.click(screen.getByRole("switch", { name: "Site A" }));
  expect(toggle).toHaveBeenCalledWith("a", true);
  await user.click(screen.getByRole("switch", { name: "Site B" }));
  expect(toggle).toHaveBeenCalledWith("b", false);
  await user.click(screen.getByRole("switch", { name: "1 of 2" }));
  expect(onAll).toHaveBeenCalledWith(true);
});
it("shows the supplied empty-state action without selection controls", () => {
  render(<MantineProvider><SelectionEditor label="Sources" hint="Choose sites" all={false} onAll={vi.fn()} items={[]}
    picked={new Set()} toggle={vi.fn()} empty={<a href="/app/connections/new">Connect a site</a>} initiallyExpanded /></MantineProvider>);
  expect(screen.getByRole("link", { name: "Connect a site" }).getAttribute("href")).toBe("/app/connections/new");
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});
