import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";
import { describe, expect, it } from "vitest";
import { readSecretFromTerminal } from "../src/prompt";

function fixture(raw = false, paused: boolean | null = true) {
  const stream = new PassThrough();
  const modes: boolean[] = [];
  let failMode: boolean | undefined;
  const terminal = Object.assign(stream, {
    isRaw: raw,
    setRawMode(value: boolean) {
      modes.push(value);
      if (failMode === value) throw new Error("private device details");
      this.isRaw = value;
      return this;
    },
  }) as unknown as ReadStream;
  if (paused) terminal.pause();
  else if (paused === false) terminal.resume();
  let output = "";
  const writer = { write(value: string | Uint8Array) { output += value.toString(); return true; } };
  const read = () => readSecretFromTerminal("Token: ", terminal, writer);
  const emit = (value: string | Buffer) => terminal.emit("data", Buffer.isBuffer(value) ? value : Buffer.from(value));
  const clean = () => {
    expect(terminal.listenerCount("data")).toBe(0);
    expect(terminal.listenerCount("end")).toBe(0);
    expect(terminal.listenerCount("close")).toBe(0);
    expect(terminal.listenerCount("error")).toBe(0);
    expect(terminal.isRaw).toBe(raw);
    expect(terminal.isPaused()).toBe(paused !== false);
  };
  return { terminal, modes, read, emit, clean, output: () => output, failMode: (value: boolean) => { failMode = value; } };
}

describe("secret terminal input", () => {
  it("handles a pasted token and enter in one chunk without echoing", async () => {
    const f = fixture(), result = f.read();
    f.emit("private-pasted-token\r\nignored-tail");
    expect(await result).toBe("private-pasted-token");
    expect(f.output()).toBe("Token: \n");
    expect(f.modes).toEqual([true, false]);
    f.clean();
  });
  it("edits characters rather than whole chunks, including split UTF-8", async () => {
    const f = fixture(), result = f.read();
    const bytes = Buffer.from("abcé🦊");
    for (const byte of bytes) f.emit(Buffer.from([byte]));
    f.emit("\x7f\bXY\x7fZ\n");
    expect(await result).toBe("abcXZ");
    expect(f.output()).toBe("Token: \n");
    f.clean();
  });
  it("ignores navigation and bracketed paste controls across chunks", async () => {
    const f = fixture(), result = f.read();
    f.emit("\x1b"); f.emit("[200~abc\x1b[A\x1b"); f.emit("[201~\x1bOP\t\0\r");
    expect(await result).toBe("abc");
    f.clean();
  });
  it("accepts empty input and restores an already raw, flowing terminal", async () => {
    const f = fixture(true, false), result = f.read();
    f.emit("\b\x7f\n");
    expect(await result).toBe("");
    expect(f.modes).toEqual([true, true]);
    f.clean();
  });
  it.each(["\x03", "\x04", "end", "close", "error"])("rejects %s and restores the terminal without secret details", async (event) => {
    const f = fixture(), result = f.read();
    const rejection = expect(result).rejects.toThrow(event === "\x03" ? "cancelled" : event === "error" ? "Unable to read secret input" : "Secret input ended before submission");
    f.emit("private-partial");
    if (event === "error") f.terminal.emit(event, new Error("private input details"));
    else if (event === "end" || event === "close") f.terminal.emit(event);
    else f.emit(`more${event}ignored`);
    await rejection;
    expect(f.output()).toBe("Token: \n");
    f.clean();
  });
  it("pauses initially idle stdin so a finished prompt cannot keep the CLI alive", async () => {
    const f = fixture(false, null);
    expect(f.terminal.readableFlowing).toBe(null);
    const result = f.read(); f.emit("value\r");
    expect(await result).toBe("value");
    f.clean();
  });
  it("rejects setup failure and removes listeners", async () => {
    const f = fixture(); f.failMode(true);
    await expect(f.read()).rejects.toThrow("Unable to start secret prompt");
    f.clean();
  });
  it("rejects restoration failure without leaking device details", async () => {
    const f = fixture(), result = f.read(); f.failMode(false);
    const rejection = expect(result).rejects.toThrow("Unable to restore terminal after secret prompt");
    f.emit("private\r"); await rejection;
    expect(f.terminal.listenerCount("data")).toBe(0);
    expect(f.output()).toBe("Token: ");
  });
});
