import { existsSync, lstatSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { parseDeploymentManifest, hashConfigDocument, type DeploymentConfigExport, type LogturaServiceClient } from "@logtura/core";
import { writeEnvValues } from "./local-env";
import { createDeploymentLink, validateDeploymentLink, type DeploymentLink } from "./deployment-link";
import { assertNoPendingPush, assertTransactionClear, commitFileTransaction, deploymentLinkPath } from "./file-transaction";
/** Stage both files before touching either destination. Roll back ordinary I/O
 * failures, preserve unrelated .env entries, and never leave public secret files. */
export async function writePulledConfig(result: DeploymentConfigExport, path: string, force = false, link?: DeploymentLink, pendingRequestId?:string): Promise<void> {
    const parsed = parseDeploymentManifest(result.document, { env: result.secretValues });
    if (parsed.missingEnv.length)
        throw new Error("Service export is missing required secret payloads");
    if (await hashConfigDocument(result.document) !== result.revision)
        throw new Error("Service export revision does not match its manifest");
    if(link){link=await validateDeploymentLink(link);if(link.revision!==result.revision || link.deployment.id!==result.deployment.id || link.configurationVersion!==result.configurationVersion || link.desiredSequence!==result.desiredSequence)throw new Error("Deployment link does not match the exported baseline");}
    const config = resolve(path), env = resolve(dirname(config), ".env");
    if (config === env)
        throw new Error("Configuration cannot overwrite the companion .env file");
    const checkDestinations=()=>{
      assertNoPendingPush(config,pendingRequestId);
      for (const target of [config, env, ...(link ? [deploymentLinkPath(config)] : [])])
        if (existsSync(target) && !lstatSync(target).isFile())
            throw new Error("Pull requires regular file destinations");
      if ((existsSync(config) || (link && existsSync(deploymentLinkPath(config)))) && !force)
        throw new Error("Configuration exists; pass --force to replace it");
    };
    checkDestinations();
    assertTransactionClear(config);
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const tag = randomUUID();
    const files = [env, config, ...(link ? [deploymentLinkPath(config)] : [])].map(target => ({ target, stage: `${target}.${tag}.tmp`, backup: `${target}.${tag}.bak` }));
    commitFileTransaction(config, files, () => {
        checkDestinations();
        writeFileSync(files[0]!.stage, "", { flag: "wx", mode: 0o600 });
        if (existsSync(env)) {
            copyFileSync(env, files[0]!.stage);
            chmodSync(files[0]!.stage, 0o600);
        }
        const values = Object.fromEntries(parsed.requiredEnv.map(name => [name, result.secretValues![name]!]));
        const written = writeEnvValues(files[0]!.stage, values, { force });
        if (written.skipped.length)
            throw new Error("Companion .env has conflicting values; pass --force to replace them");
        writeFileSync(files[1]!.stage, stringify(result.document), { flag: "wx", mode: 0o644 });
        if(link)writeFileSync(files[2]!.stage,JSON.stringify(link)+"\n",{flag:"wx",mode:0o600});
    });
}

export async function pullDeploymentConfig(client: LogturaServiceClient, id: string, path: string, force = false): Promise<string> {
    const result = await client.pullDeploymentConfig(id, true);
    const user=await client.whoami();
    const link=await createDeploymentLink(client.url,user.id,result);
    await writePulledConfig(result, path, force, link);
    return result.revision;
}
