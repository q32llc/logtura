import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import type { GeneratedBundle } from "@logtura/core";
import { buildInstallArchive } from "../src/install";
import { getProvider, getDestination, listProviders, listDestinations } from "../src/registry";

it("resolves every packaged driver and rejects unknown identities", () => {
  for (const provider of listProviders()) expect(getProvider(provider.id)).toBe(provider);
  for (const destination of listDestinations()) expect(getDestination(destination.id)).toBe(destination);
  for (const id of ["", "unknown", "constructor", "__proto__", "toString"]) {
    expect(getProvider(id)).toBeNull();
    expect(getDestination(id)).toBeNull();
  }
  expect(new Set(listProviders().map(driver => driver.id)).size).toBe(7);
  expect(new Set(listDestinations().map(driver => driver.id)).size).toBe(5);
});

// Read the wire format independently of the shared tar writer.
function unpack(bytes: Uint8Array) {
  const tar = gunzipSync(bytes);
  const files = new Map<string, { mode: number; bytes: Buffer }>();
  for (let offset = 0; tar[offset];) {
    const name = tar.subarray(offset, offset + 100).toString().split("\0")[0]!;
    const mode = parseInt(tar.subarray(offset + 100, offset + 108).toString(), 8);
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
    expect(tar.subarray(offset + 257, offset + 262).toString()).toBe("ustar");
    files.set(name, { mode, bytes: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
it.each([undefined, "My Forwarder"])("ships a complete portable gzip install archive with name %j", name => {
  const bundle: GeneratedBundle = {
    dockerfile: "FROM fixture\nCOPY assets/fixture/helper.bin /helper.bin\n",
    vectorYaml: "sources: {}\nsinks: {}\n",
    runtimeAssets: [{ driverId: "fixture", path: "helper.bin", content: new Uint8Array([0, 255, 10]), mode: 0o755 }],
    runCommand: "docker run fixture", envVars: [{ name: "FIXTURE_TOKEN", value: "private-fixture", description: "API token", source: "credential" }],
    selectedCount: 1, monitorSummary: "fixture", componentManifest: [],
  };
  const archive = name === undefined ? buildInstallArchive(bundle) : buildInstallArchive(bundle, name);
  const files = unpack(archive), root = name === undefined ? "logtura-forwarder" : "my-forwarder";
  expect([...files.keys()].sort()).toEqual([".env", "Dockerfile", "README.md", "assets/fixture/helper.bin", "install.sh", "manifest.json", "vector.yaml"].map(path => `${root}/${path}`).sort());
  expect(files.get(`${root}/Dockerfile`)!.bytes.toString()).toBe(bundle.dockerfile);
  expect(files.get(`${root}/vector.yaml`)!.bytes.toString()).toBe(bundle.vectorYaml);
  expect(files.get(`${root}/assets/fixture/helper.bin`)).toEqual({ mode: 0o755, bytes: Buffer.from([0, 255, 10]) });
  expect(files.get(`${root}/.env`)!.mode).toBe(0o600);
  expect(files.get(`${root}/.env`)!.bytes.toString()).toContain("FIXTURE_TOKEN=private-fixture");
  expect(files.get(`${root}/install.sh`)!.mode).toBe(0o755);
  expect(JSON.parse(files.get(`${root}/manifest.json`)!.bytes.toString())).toEqual([]);
});
