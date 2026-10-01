import { gzipSync } from "node:zlib";
import { buildTar, installBundleFiles, type GeneratedBundle } from "@logtura/core";
export { installBundleFiles, renderEnvFile } from "@logtura/core";

export function buildInstallArchive(bundle: GeneratedBundle, name = "logtura-forwarder"): Uint8Array {
  return gzipSync(buildTar(installBundleFiles(bundle, name)));
}
