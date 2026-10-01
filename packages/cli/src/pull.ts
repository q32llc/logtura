import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { parseDeploymentManifest, hashConfigDocument, type DeploymentConfigExport, type LogturaServiceClient } from "@logtura/core";
import { writeEnvValues } from "./local-env";
/** Stage both files before touching either destination. Roll back ordinary I/O
 * failures, preserve unrelated .env entries, and never leave public secret files. */
export async function writePulledConfig(result: DeploymentConfigExport, path: string, force = false): Promise<void> {
    const parsed = parseDeploymentManifest(result.document, { env: result.secretValues });
    if (parsed.missingEnv.length)
        throw new Error("Service export is missing required secret payloads");
    if (await hashConfigDocument(result.document) !== result.revision)
        throw new Error("Service export revision does not match its manifest");
    const config = resolve(path), env = resolve(dirname(config), ".env");
    if (config === env)
        throw new Error("Configuration cannot overwrite the companion .env file");
    for (const target of [config, env])
        if (existsSync(target) && !lstatSync(target).isFile())
            throw new Error("Pull requires regular file destinations");
    if (existsSync(config) && !force)
        throw new Error("Configuration exists; pass --force to replace it");
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    const tag = randomUUID();
    const files = [env, config].map(target => ({ target, stage: `${target}.${tag}.tmp`, backup: `${target}.${tag}.bak`, saved: false, installed: false }));
    let committed = false;
    try {
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
        for (const file of files) {
            if (existsSync(file.target)) {
                renameSync(file.target, file.backup);
                file.saved = true;
            }
            renameSync(file.stage, file.target);
            file.installed = true;
        }
        committed = true;
    }
    catch (error) {
        const recovery: string[] = [];
        for (const file of [...files].reverse()) {
            try {
                if (file.installed)
                    rmSync(file.target, { force: true });
                if (file.saved) {
                    renameSync(file.backup, file.target);
                    file.saved = false;
                }
            }
            catch {
                recovery.push(file.backup);
            }
        }
        if (recovery.length)
            throw new Error(`Pull failed; original files retained for recovery: ${recovery.join(", ")}`);
        throw error;
    }
    finally {
        for (const file of files) {
            rmSync(file.stage, { force: true });
            if (committed || !file.saved)
                rmSync(file.backup, { force: true });
        }
    }
}
export async function pullDeploymentConfig(client: LogturaServiceClient, id: string, path: string, force = false): Promise<string> {
    const result = await client.pullDeploymentConfig(id, true);
    await writePulledConfig(result, path, force);
    return result.revision;
}
