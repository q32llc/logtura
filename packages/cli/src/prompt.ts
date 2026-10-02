import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ReadStream, WriteStream } from "node:tty";

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await ask(question + suffix)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function askSecret(question: string): Promise<string> {
  if (!input.isTTY) return ask(question);
  return readSecretFromTerminal(question, input, output);
}

/** Internal terminal adapter: chunks are transport boundaries, never keystrokes. */
export function readSecretFromTerminal(
  question: string,
  terminal: ReadStream,
  writer: Pick<WriteStream, "write">,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const characters: string[] = [];
    const wasRaw = terminal.isRaw;
    const wasFlowing = terminal.readableFlowing === true;
    let done = false;
    let escape: "none" | "start" | "csi" = "none";
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      terminal.off("data", onData);
      terminal.off("end", onEnd);
      terminal.off("close", onEnd);
      terminal.off("error", onError);
      try {
        terminal.setRawMode(wasRaw);
        if (!wasFlowing) terminal.pause();
        writer.write("\n");
      } catch {
        reject(new Error("Unable to restore terminal after secret prompt"));
        return;
      }
      if (error) reject(error);
      else resolve(characters.join(""));
    };
    const onEnd = () => finish(new Error("Secret input ended before submission"));
    const onError = () => finish(new Error("Unable to read secret input"));
    const onData = (chunk: Buffer) => {
      for (const character of decoder.write(chunk)) {
        if (character === "\u0003") {
          finish(new Error("cancelled"));
          return;
        }
        if (character === "\u0004") {
          onEnd();
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        // Ignore terminal navigation and bracketed-paste control sequences.
        if (escape === "start") {
          escape = character === "[" || character === "O" ? "csi" : "none";
          continue;
        }
        if (escape === "csi") {
          if (character >= "@" && character <= "~") escape = "none";
          continue;
        }
        if (character === "\u001b") {
          escape = "start";
          continue;
        }
        if (character === "\u007f" || character === "\b") {
          characters.pop();
        } else if (character >= " " && character !== "\u001b") {
          characters.push(character);
        }
      }
    };
    try {
      writer.write(question);
      terminal.setRawMode(true);
      terminal.on("data", onData);
      terminal.on("end", onEnd);
      terminal.on("close", onEnd);
      terminal.on("error", onError);
      terminal.resume();
    } catch {
      finish(new Error("Unable to start secret prompt"));
    }
  });
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawnSync(cmd, args, { stdio: "ignore" });
}
