import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";

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
  output.write(question);
  const chunks: string[] = [];
  input.setRawMode(true);
  input.resume();
  return await new Promise((resolve, reject) => {
    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (s === "\u0003") {
        cleanup();
        reject(new Error("cancelled"));
        return;
      }
      if (s === "\r" || s === "\n") {
        cleanup();
        output.write("\n");
        resolve(chunks.join(""));
        return;
      }
      if (s === "\u007f" || s === "\b") {
        chunks.pop();
        return;
      }
      chunks.push(s);
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    input.on("data", onData);
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
