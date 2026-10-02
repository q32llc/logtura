import { expect, it } from "vitest";
import { otherDriver } from "../../src/deploy-targets/other";
import { serializeBundleFiles } from "../../src/deploy-targets/bundle-files";
import { selfDeployFiles, type GeneratedBundle } from "@logtura/core";
const bundle: GeneratedBundle = {dockerfile: "FROM scratch", vectorYaml: "sources: {}", runCommand: "docker run image", envVars: [], runtimeAssets: [], componentManifest: [], selectedCount: 0, monitorSummary: ""};
it("uses the packaged generic composer and retains its non-managed target contract", () => {
 expect(otherDriver.id).toBe("other"); expect(otherDriver.supportsManaged).toBe(false); expect(otherDriver.formFields).toEqual([]);
 const result = otherDriver.generateTargetBundle({sourceBundle: bundle, deploymentName: "Fixture", connectionId: "fixture"});
 expect(result.files).toEqual(serializeBundleFiles(selfDeployFiles(bundle), {Dockerfile: "dockerfile", "vector.yaml": "yaml", "run.sh": "bash"}));
 expect(result.files[2]).toMatchObject({name: "run.sh", content: "#!/usr/bin/env bash\nset -euo pipefail\n\ndocker run image\n", mode: 0o600});
 expect(result.selfDeployInstructions).toContain("docker build -t logtura-forwarder"); expect(result.selfDeployInstructions).toContain("assets/ subdirectories and permission modes");
});
it("preserves nested binary and Unicode assets in the generic JSON response", () => {
 const result = otherDriver.generateTargetBundle({sourceBundle: {...bundle, runtimeAssets: [{driverId: "custom", path: "nested/helper.bin", content: new Uint8Array([0, 255, 128]), mode: 0o700}, {driverId: "custom", path: "helper.js", content: "café"}, {driverId: "custom", path: "empty.bin", content: new Uint8Array()}]}, deploymentName: "Fixture", connectionId: "fixture"});
 expect(JSON.parse(JSON.stringify(result)).files.slice(3)).toEqual([{name: "assets/custom/nested/helper.bin", content: "AP+A", encoding: "base64", mode: 0o700}, {name: "assets/custom/helper.js", content: "café", mode: 0o644}, {name: "assets/custom/empty.bin", content: "", encoding: "base64", mode: 0o644}]);
});
