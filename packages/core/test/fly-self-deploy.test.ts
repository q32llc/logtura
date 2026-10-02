import { expect, it } from "vitest";
import { flySelfDeployFiles } from "../src/fly-install";
import { buildTar } from "../src/tar";
import type { GeneratedBundle } from "../src/types";
const bundle: GeneratedBundle = {dockerfile: "FROM scratch", vectorYaml: "sources: {}", runtimeAssets: [], runCommand: "", envVars: [], componentManifest: [], selectedCount: 0, monitorSummary: ""};
it("composes all build inputs with literal asset bytes, nested paths and modes", () => {
  const bytes = new Uint8Array([0, 255, 128, 10, 13]);
  const files = flySelfDeployFiles({appName: "app", region: "ord", bundle: {...bundle, runtimeAssets: [
    {driverId: "custom", path: "nested/helper.bin", content: bytes, mode: 0o700},
    {driverId: "other", path: "script.js", content: "console.log('hello')"},
  ]}});
  expect(files.map(file => file.name)).toEqual(["Dockerfile", "vector.yaml", "fly.toml", "deploy.sh", "assets/custom/nested/helper.bin", "assets/other/script.js"]);
  expect(files[2]!.content).toContain('primary_region = "ord"');
  expect(files[3]!.mode).toBe(0o600);
  expect(files[4]).toEqual({name: "assets/custom/nested/helper.bin", content: bytes, mode: 0o700});
  expect(files[5]!.mode).toBe(0o644);
  const tar = buildTar(files); expect(tar.length).toBeGreaterThan(0);
  // Exact binary body follows four small file entries and this file's header.
  expect(tar.slice(4 * 1024 + 512, 4 * 1024 + 517)).toEqual(bytes);
});
it("uses the default region without assets and rejects untrusted asset paths before emitting files", () => {
  expect(flySelfDeployFiles({appName: "app", bundle})[2]!.content).toContain('primary_region = "iad"');
  expect(() => flySelfDeployFiles({appName: "app", bundle: {...bundle, runtimeAssets: [{driverId: "custom", path: "../outside", content: "bad"}]}})).toThrow("runtime asset");
});
it("carries credential guidance and the private launch workflow into the complete context", () => {
  const files = flySelfDeployFiles({appName: "app", bundle: {...bundle, envVars: [
    {name: "TOKEN", value: "literal $(payload)", source: "credential", description: "Token"},
    {name: "MISSING", value: null, source: "credential", description: "Caller value"},
  ]}});
  expect(files[2]!.content).toContain("#   TOKEN\n#   MISSING");
  expect(files[3]!.content).toContain("'TOKEN=literal $(payload)'");
  expect(files[3]!.content).toContain('${MISSING:?Set MISSING before running deploy.sh}');
});
