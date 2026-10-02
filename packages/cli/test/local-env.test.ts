import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { appendMissingEnvKeys, readDotEnvFile, writeEnvValues } from "../src/local-env";

const directories: string[] = [];
function file() { const dir = mkdtempSync(join(tmpdir(), "logt-env-test-")); directories.push(dir); return join(dir, ".env"); }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("local credential files", () => {
  it("reads absent files, comments, exports, CRLF, and quoted values", () => {
    const path = file();
    expect(readDotEnvFile(path).size).toBe(0);
    writeFileSync(path, '# comment\r\n\r\nnot an assignment\r\n export TOKEN="a b"\r\nSINGLE=\'other value\'\r\nEMPTY=\r\n');
    expect(Object.fromEntries(readDotEnvFile(path))).toEqual({ TOKEN: "a b", SINGLE: "other value", EMPTY: "" });
  });
  it("preserves existing credentials unless forced and keeps surrounding comments", () => {
    const path = file();
    writeFileSync(path, "# keep me\nexport TOKEN=old\nOTHER=untouched\n");
    expect(writeEnvValues(path, { TOKEN: "new" })).toEqual({ changed: false, skipped: ["TOKEN"] });
    expect(writeEnvValues(path, { TOKEN: "new" }, { force: true })).toEqual({ changed: true, skipped: [] });
    expect(readFileSync(path, "utf8")).toBe("# keep me\nTOKEN=new\nOTHER=untouched\n");
    expect(writeEnvValues(path, { TOKEN: "new" })).toEqual({ changed: false, skipped: [] });
  });
  it.each(["https://example.test/a", "space value", 'quote"value', "back\\slash", "line\nbreak", "", "literal $HOME and `command`"])("round trips secret values without evaluation: %j", (value) => {
    const path = file();
    writeEnvValues(path, { TOKEN: value });
    expect(readDotEnvFile(path).get("TOKEN")).toBe(value);
    expect(readFileSync(path, "utf8").split("\n")).toHaveLength(2);
  });
  it("adds missing keys once and preserves a file without a final newline", () => {
    const path = file(); writeFileSync(path, "TOKEN=already");
    expect(appendMissingEnvKeys(path, ["TOKEN", "NEW", "NEW"])).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("TOKEN=already\nNEW=\n");
    expect(appendMissingEnvKeys(path, ["TOKEN", "NEW"])).toBe(false);
    const absent = file(); expect(appendMissingEnvKeys(absent, ["FIRST"])).toBe(true);
    expect(readFileSync(absent, "utf8")).toBe("FIRST=\n");
  });
  it("rejects invalid keys before modifying the file", () => {
    const path = file(); writeFileSync(path, "TOKEN=old\n");
    expect(() => writeEnvValues(path, { "INVALID\nINJECTED": "value" })).toThrow(/invalid environment key/i);
    expect(() => appendMissingEnvKeys(path, ["BAD=key"])).toThrow(/invalid environment key/i);
    expect(readFileSync(path, "utf8")).toBe("TOKEN=old\n");
  });
});

it("creates private credential files and repairs permissions even when their values are unchanged", () => {
  const path = file(); writeEnvValues(path, { TOKEN: "secret" }); expect(statSync(path).mode & 0o777).toBe(0o600);
  const existing = file(); writeFileSync(existing, "TOKEN=secret\n", { mode: 0o664 });
  expect(writeEnvValues(existing, { TOKEN: "secret" }).changed).toBe(false); expect(statSync(existing).mode & 0o777).toBe(0o600);
  const placeholder = file(); appendMissingEnvKeys(placeholder, ["TOKEN"]); expect(statSync(placeholder).mode & 0o777).toBe(0o600);
});
it("replaces every duplicate assignment so the last effective value cannot retain an old token", () => {
  const path = file(); writeFileSync(path, "# keep\nTOKEN=old\nOTHER=keep\nexport TOKEN=stale\nTOKEN=last\n");
  writeEnvValues(path, { TOKEN: "new" }, { force: true }); expect(readFileSync(path, "utf8")).toBe("# keep\nTOKEN=new\nOTHER=keep\n"); expect(readDotEnvFile(path).get("TOKEN")).toBe("new");
});
