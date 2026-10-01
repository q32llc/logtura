/** Service storage adapter; install composition is public @logtura/core. */
import { installBundleFiles, buildTar } from "@logtura/core";
import { assembleDeploymentBundle } from "./bundle-assembly";
import type { Env } from "./env";
import { gzipBytes } from "./tar";

export interface InstallBundle { filename: string; bytes: Uint8Array; }

export async function buildInstallBundle(env: Env, userId: string, deploymentId: string): Promise<InstallBundle> {
  const { deployment, bundle } = await assembleDeploymentBundle(env, userId, deploymentId);
  const dirName = `logtura-${deployment.id.replace(/^dep_/, "").toLowerCase()}`;
  const files = installBundleFiles(bundle, dirName, deployment.display_name);
  return { filename: `${dirName}.tgz`, bytes: await gzipBytes(buildTar(files)) };
}
