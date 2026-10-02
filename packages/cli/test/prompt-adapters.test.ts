import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn(), spawn: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: () => boundary }));
vi.mock("node:child_process", () => ({ spawnSync: boundary.spawn }));
vi.mock("node:process", () => {
  const input = Object.assign(new PassThrough(), { isTTY: false, isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this; } });
  return { stdin: input, stdout: { write: vi.fn(() => true) } };
});
import { stdin } from "node:process";
import { ask, askSecret, confirm, openBrowser } from "../src/prompt";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
it.each([[true, "", true], [false, "", false], [false, " YES ", true],
  [true, "y", true], [true, "no", false], [false, "maybe", false]])(
  "normalizes confirmation input with default %s and answer %j", async (defaultYes, answer, accepted) => {
    boundary.question.mockResolvedValueOnce(answer);
    expect(await confirm("Continue?", defaultYes)).toBe(accepted);
    expect(boundary.question).toHaveBeenCalledWith(`Continue? ${defaultYes ? "[Y/n]" : "[y/N]"} `);
    expect(boundary.close).toHaveBeenCalledOnce();
  });
it("closes readline even when input fails", async () => {
  boundary.question.mockRejectedValueOnce(new Error("input closed"));
  await expect(ask("Name: ")).rejects.toThrow("input closed");
  expect(boundary.close).toHaveBeenCalledOnce();
});
it("accepts piped secret input through readline", async () => {
  boundary.question.mockResolvedValueOnce("piped-token");
  expect(await askSecret("Token: ")).toBe("piped-token");
  expect(boundary.close).toHaveBeenCalledOnce();
});
it("uses raw terminal input for an interactive secret and restores its state", async () => {
  const terminal = stdin as typeof stdin & { isTTY: boolean };
  terminal.isTTY = true;
  try {
    const pending = askSecret("Token: ");
    terminal.emit("data", Buffer.from("interactive-token\r"));
    expect(await pending).toBe("interactive-token");
    expect(boundary.question).not.toHaveBeenCalled();
    expect(terminal.isRaw).toBe(false);
    expect(terminal.listenerCount("data")).toBe(0);
  } finally { terminal.isTTY = false; }
});
it.each([["darwin", "open", ["https://fixture.invalid/login"]],
  ["win32", "cmd", ["/c", "start", "", "https://fixture.invalid/login"]],
  ["linux", "xdg-open", ["https://fixture.invalid/login"]]])(
  "opens the login URL with the %s browser adapter", (platform, command, args) => {
    vi.stubGlobal("process", { platform });
    openBrowser("https://fixture.invalid/login");
    expect(boundary.spawn).toHaveBeenCalledWith(command, args, { stdio: "ignore" });
  });
