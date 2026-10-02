import type { GeneratedRuntimeAsset } from "./types";
import type { TarFile } from "./tar";

/** Runtime assets have the same safe relative layout in archives, build
 * contexts and provider-mounted files. Preserve bytes and optional modes. */
export function runtimeAssetFiles(assets: readonly GeneratedRuntimeAsset[]): TarFile[] {
  const seen = new Set<string>();
  return assets.map(asset => {
    if (typeof asset.driverId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(asset.driverId)
      || typeof asset.path !== "string" || !asset.path || asset.path.includes("\\")
      || /[\u0000-\u001f\u007f]/.test(asset.path)
      || asset.path.split("/").some(part => part === "" || part === "." || part === "..")
      || (typeof asset.content !== "string" && !(asset.content instanceof Uint8Array))
      || (asset.mode !== undefined && (!Number.isSafeInteger(asset.mode) || asset.mode < 0 || asset.mode > 0o777))) {
      throw new Error("Invalid runtime asset");
    }
    const name = `assets/${asset.driverId}/${asset.path}`;
    if (seen.has(name)) throw new Error("Duplicate runtime asset path");
    seen.add(name);
    return {name, content: asset.content, mode: asset.mode};
  });
}
