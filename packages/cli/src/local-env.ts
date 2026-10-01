import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function readDotEnvFile(path = ".env"): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    out.set(m[1]!, unquoteEnv(m[2] ?? ""));
  }
  return out;
}

export function writeEnvValues(
  path: string,
  values: Record<string, string>,
  input: { force?: boolean } = {},
): { changed: boolean; skipped: string[] } {
  for (const key of Object.keys(values)) validateKey(key);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const present = readDotEnvFile(path);
  const skipped: string[] = [];
  let changed = false;

  for (const [key, value] of Object.entries(values)) {
    const old = present.get(key);
    if (old !== undefined && old !== value && !input.force) {
      skipped.push(key);
      continue;
    }
    if (old === value) continue;
    const rendered = `${key}=${quoteEnv(value)}`;
    const idx = lines.findIndex((line) =>
      new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}=`).test(line),
    );
    if (idx >= 0) lines[idx] = rendered;
    else lines.push(rendered);
    changed = true;
  }

  if (changed) writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"));
  return { changed, skipped };
}

export function appendMissingEnvKeys(path: string, keys: string[]): boolean {
  for (const key of keys) validateKey(key);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = readDotEnvFile(path);
  const missing = [...new Set(keys)].filter((k) => !present.has(k));
  if (missing.length === 0) return false;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const added = missing.map((k) => `${k}=`).join("\n") + "\n";
  writeFileSync(path, existing + prefix + added);
  return true;
}

function unquoteEnv(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("invalid environment key");
}
