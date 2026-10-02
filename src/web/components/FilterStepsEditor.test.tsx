import { MantineProvider } from "@mantine/core";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { FilterStep } from "../types";
import { FilterStepsEditor } from "./FilterStepsEditor";

function page(initial: FilterStep[] = [], extra = {}) {
  const changed = vi.fn();
  function Editor() {
    const [steps, setSteps] = useState(initial);
    return <FilterStepsEditor {...extra} steps={steps} onChange={next => { changed(next); setSteps(next); }} />;
  }
  render(<MantineProvider env="test"><Editor /></MantineProvider>);
  return { user: userEvent.setup(), changed };
}
async function add(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.click(await screen.findByRole("menuitem", { name }));
  return within(await screen.findByRole("dialog"));
}
const defaults: Array<[string, FilterStep, string]> = [
  ["Errors", { kind: "errors" }, "errors"],
  ["Match (regex)", { kind: "match", pattern: "", mode: "exclude" }, "match: // ✕"],
  ["Level", { kind: "level", level: "error", mode: "include" }, "level = error"],
  ["Dedup", { kind: "dedup", window_secs: 300, fields: ["message"] }, "dedup 300s"],
  ["Rollup (summarize bursts)", { kind: "rollup", window_secs: 30, group_by: [], max_samples: 5 }, "rollup 30s"],
  ["Rate-limit", { kind: "rate_limit", per_minute: 60 }, "≤60/min"],
  ["Sample", { kind: "sample", rate: 0.1 }, "sample 10%"],
];
it.each(defaults)("adds %s with its documented default and reopens the saved value", async (name, step, chip) => {
  const { user, changed } = page([], { size: "xs", emptyHint: "Choose a filter" });
  expect(screen.getByText("Choose a filter")).toBeTruthy();
  const dialog = await add(user, name);
  await user.click(dialog.getByRole("button", { name: "Add" }));
  expect(changed).toHaveBeenLastCalledWith([step]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("Choose a filter")).toBeNull();
  await user.click(screen.getByRole("button", { name: `Edit ${chip}` }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(changed).toHaveBeenCalledTimes(1);
});
it("edits regex, optional field and mode, discards cancelled drafts, and isolates another match step", async () => {
  const { user, changed } = page([{ kind: "match", pattern: "first", mode: "exclude", field: "message" }, { kind: "match", pattern: "second", mode: "include" }]);
  await user.click(screen.getByRole("button", { name: "Edit match: /first/ ✕" }));
  let dialog = within(await screen.findByRole("dialog"));
  await user.clear(dialog.getByRole("textbox", { name: "Regex pattern" }));
  await user.type(dialog.getByRole("textbox", { name: "Regex pattern" }), "timeout|refused");
  await user.clear(dialog.getByRole("textbox", { name: "Field (default: message)" }));
  await user.click(dialog.getByRole("textbox", { name: "Mode" }));
  await user.click(await screen.findByRole("option", { name: "Include matching events" }));
  await user.click(dialog.getByRole("button", { name: "Save" }));
  expect(changed).toHaveBeenLastCalledWith([{ kind: "match", pattern: "timeout|refused", mode: "include", field: undefined }, { kind: "match", pattern: "second", mode: "include" }]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByRole("button", { name: "Edit match: /second/" }));
  dialog = within(await screen.findByRole("dialog"));
  expect((dialog.getByRole("textbox", { name: "Regex pattern" }) as HTMLInputElement).value).toBe("second");
  await user.type(dialog.getByRole("textbox", { name: "Regex pattern" }), "discard");
  await user.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByRole("button", { name: "Edit match: /second/" }));
  expect((within(await screen.findByRole("dialog")).getByRole("textbox", { name: "Regex pattern" }) as HTMLInputElement).value).toBe("second");
  expect(changed).toHaveBeenCalledTimes(1);
});
it("moves ordered filters in both directions, disables boundary controls, and removes without opening an editor", async () => {
  const steps: FilterStep[] = [{ kind: "errors" }, { kind: "sample", rate: 0.5 }, { kind: "level", level: "warn", mode: "exclude" }];
  const { user, changed } = page(steps);
  expect((screen.getAllByRole("button", { name: "Move left" })[0] as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getAllByRole("button", { name: "Move right" })[2] as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getAllByRole("button", { name: "Move left" })[1]!);
  expect(changed).toHaveBeenLastCalledWith([steps[1], steps[0], steps[2]]);
  await user.click(screen.getAllByRole("button", { name: "Move right" })[0]!);
  expect(changed).toHaveBeenLastCalledWith(steps);
  await user.click(screen.getByRole("button", { name: "Remove sample 50%" }));
  expect(changed).toHaveBeenLastCalledWith([steps[0], steps[2]]);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("parses comma-separated dedup and rollup fields, and saves edited numeric settings", async () => {
  const { user, changed } = page();
  let dialog = await add(user, "Dedup");
  await user.clear(dialog.getByRole("textbox", { name: "Fields (comma-separated)" }));
  await user.type(dialog.getByRole("textbox", { name: "Fields (comma-separated)" }), " script, , message , ");
  await user.clear(dialog.getByRole("textbox", { name: "Window (seconds)" }));
  await user.type(dialog.getByRole("textbox", { name: "Window (seconds)" }), "120");
  await user.click(dialog.getByRole("button", { name: "Add" }));
  expect(changed).toHaveBeenLastCalledWith([{ kind: "dedup", fields: ["script", "message"], window_secs: 120 }]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  dialog = await add(user, "Rollup (summarize bursts)");
  await user.type(dialog.getByRole("textbox", { name: "Group by (comma-separated; empty = global)" }), "script, , region");
  for (const [name, value] of [["Window (seconds)", "60"], ["Max samples in summary", "7"]]) {
    await user.clear(dialog.getByRole("textbox", { name })); await user.type(dialog.getByRole("textbox", { name }), value!);
  }
  await user.click(dialog.getByRole("button", { name: "Add" }));
  expect(changed.mock.lastCall?.[0][1]).toEqual({ kind: "rollup", window_secs: 60, group_by: ["script", "region"], max_samples: 7 });
});
it.each([
  ["Rate-limit", "Max events per minute", "120", { kind: "rate_limit", per_minute: 120 }],
  ["Sample", "Keep fraction (0–1)", "0.25", { kind: "sample", rate: 0.25 }],
] as const)("edits %s numeric configuration", async (name, label, value, expected) => {
  const { user, changed } = page(); const dialog = await add(user, name);
  await user.clear(dialog.getByRole("textbox", { name: label }));
  await user.type(dialog.getByRole("textbox", { name: label }), value);
  await user.click(dialog.getByRole("button", { name: "Add" }));
  expect(changed).toHaveBeenLastCalledWith([expected]);
});
it("edits a level and exclusion mode, then preserves both on reopening", async () => {
  const { user, changed } = page([{ kind: "level", level: "error" }]);
  await user.click(screen.getByRole("button", { name: "Edit level = error" }));
  let dialog = within(await screen.findByRole("dialog"));
  await user.clear(dialog.getByRole("textbox", { name: "Level" }));
  await user.type(dialog.getByRole("textbox", { name: "Level" }), "warn");
  await user.click(dialog.getByRole("textbox", { name: "Mode" }));
  await user.click(await screen.findByRole("option", { name: "Drop this level" }));
  await user.click(dialog.getByRole("button", { name: "Save" }));
  expect(changed).toHaveBeenLastCalledWith([{ kind: "level", level: "warn", mode: "exclude" }]);
  await user.click(screen.getByRole("button", { name: "Edit level ≠ warn" }));
  dialog = within(await screen.findByRole("dialog"));
  expect((dialog.getByRole("textbox", { name: "Level" }) as HTMLInputElement).value).toBe("warn");
  await user.click(dialog.getByRole("button", { name: "Cancel" }));
});
it("supports legacy omitted field lists and cancellation through the modal close button", async () => {
  const { user, changed } = page([{ kind: "dedup", window_secs: 20 }, { kind: "rollup", window_secs: 15 }]);
  await user.click(screen.getByRole("button", { name: "Edit dedup 20s" }));
  let dialog = within(await screen.findByRole("dialog"));
  expect((dialog.getByRole("textbox", { name: "Fields (comma-separated)" }) as HTMLInputElement).value).toBe("message");
  await user.clear(dialog.getByRole("textbox", { name: "Fields (comma-separated)" }));
  await user.click(dialog.getByRole("button", { name: "Save" }));
  expect(changed.mock.lastCall?.[0][0].fields).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Edit rollup 15s" }));
  dialog = within(await screen.findByRole("dialog"));
  expect((dialog.getByRole("textbox", { name: "Group by (comma-separated; empty = global)" }) as HTMLInputElement).value).toBe("");
  expect((dialog.getByRole("textbox", { name: "Max samples in summary" }) as HTMLInputElement).value).toBe("5");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(changed).toHaveBeenCalledTimes(1);
});
