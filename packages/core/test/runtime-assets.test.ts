import { expect, it } from "vitest";
import { runtimeAssetFiles } from "../src/runtime-assets";
import { selfDeployFiles, installBundleFiles } from "../src/install";
import { flySelfDeployFiles } from "../src/fly-install";
import { flyBundleFiles } from "../src/fly-runtime";
import type { GeneratedBundle, GeneratedRuntimeAsset } from "../src/types";
const asset: GeneratedRuntimeAsset = {driverId: "custom", path: "nested/helper.bin", content: new Uint8Array([0, 255, 128]), mode: 0o700};
const bundle: GeneratedBundle = {dockerfile: "FROM scratch", vectorYaml: "sources: {}", runCommand: "docker run --env TOKEN=fixture image", envVars: [], runtimeAssets: [asset, {driverId: "other", path: "helper.js", content: "console.log('café')"}], componentManifest: [], selectedCount: 0, monitorSummary: ""};
it("preserves bytes and permissions in every shared build/archive/provider composer", () => {
 const expected = [{name: "assets/custom/nested/helper.bin", content: asset.content, mode: 0o700}, {name: "assets/other/helper.js", content: "console.log('café')", mode: undefined}];
 expect(runtimeAssetFiles(bundle.runtimeAssets)).toEqual(expected); expect(runtimeAssetFiles([])).toEqual([]);
 const generic = selfDeployFiles(bundle), fly = flySelfDeployFiles({bundle, appName: "app"}), install = installBundleFiles(bundle, "fixture");
 expect(generic.slice(3)).toEqual(expected.map(file => ({...file, mode: file.mode ?? 0o644})));
 expect(fly.slice(4)).toEqual(generic.slice(3));
 expect(install.filter(file => file.name.includes("/assets/"))).toEqual(expected.map(file => ({...file, name: `fixture/${file.name}`})));
 expect(generic.slice(0, 3)).toEqual([{name: "Dockerfile", content: bundle.dockerfile}, {name: "vector.yaml", content: bundle.vectorYaml}, {name: "run.sh", content: `#!/usr/bin/env bash\nset -euo pipefail\n\n${bundle.runCommand}\n`, mode: 0o600}]);
 const mounted = flyBundleFiles(bundle).slice(1);
 expect(mounted).toEqual([{guest_path: "/opt/logtura/assets/custom/nested/helper.bin", raw_value: "AP+A", mode: 0o700}, {guest_path: "/opt/logtura/assets/other/helper.js", raw_value: Buffer.from("console.log('café')").toString("base64"), mode: 0o644}]);
});
it.each([
 {driverId: undefined}, {driverId: "../escape"}, {path: undefined}, {path: ""}, {path: "/absolute"}, {path: "a//b"}, {path: "a/./b"}, {path: "a/../b"}, {path: "a\\b"}, {path: "a\0b"},
 {content: []}, {mode: -1}, {mode: 1.5}, {mode: 0o1000},
])("rejects invalid runtime asset fields consistently: %j", change => {
 const bad = {...asset, ...change} as unknown as GeneratedRuntimeAsset;
 for(const compose of [() => runtimeAssetFiles([bad]), () => selfDeployFiles({...bundle, runtimeAssets: [bad]}), () => installBundleFiles({...bundle, runtimeAssets: [bad]}), () => flySelfDeployFiles({appName: "app", bundle: {...bundle, runtimeAssets: [bad]}}), () => flyBundleFiles({...bundle, runtimeAssets: [bad]})]) expect(compose).toThrow(/runtime asset/);
});
it("rejects duplicate paths, permits the same filename under distinct drivers and preserves explicit mode zero", () => {
 expect(() => runtimeAssetFiles([asset, {...asset, content: "different"}])).toThrow("Duplicate runtime asset path");
 expect(runtimeAssetFiles([asset, {...asset, driverId: "other", mode: 0}])[1]!.mode).toBe(0);
 expect(selfDeployFiles({...bundle, runtimeAssets: []})).toHaveLength(3);
});
