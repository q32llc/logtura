import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { exportDeploymentManifest, createSecretVersioner, hashConfigDocument, LogturaServiceClient } from "@logtura/core";
import { writePulledConfig, pullDeploymentConfig } from "../src/pull";
import { main } from "../src/main";
import { readDotEnvFile } from "../src/local-env";
import { readDeploymentLink } from "../src/deployment-link";
import { loadConfigFile } from "../src/config";
vi.mock("node:fs", { spy: true });
const dirs: string[] = [];
function dir() { const path = mkdtempSync(join(tmpdir(), "logtura-pull-")); dirs.push(path); return path; }
afterEach(() => { vi.mocked(fs.renameSync).mockReset(); vi.restoreAllMocks(); for (const path of dirs.splice(0))
    rmSync(path, { recursive: true, force: true }); });
async function result() { const exported = await exportDeploymentManifest({ providers: [], destinations: [], connections: [{ connection: { id: "con_site", displayName: "Site", provider: "cloudflare-worker-tail", externalAccountId: "account" }, selectedSources: [{ id: "src_site", externalId: "website", displayName: "Website", sourceKind: "cf_worker", metadata: null }], credentials: { apiToken: "secret\n$literal" } }], monitors: [] }, await createSecretVersioner("private")); return { ...exported, deployment: { id: "dep_site", displayName: "Forwarder" }, revision: await hashConfigDocument(exported.document) }; }
describe("account deployment pull", () => {
    it("writes a standalone config with private JSON secrets while preserving unrelated environment entries", async () => {
        const path = join(dir(), "logt.yaml"), env = join(path, "..", ".env");
        writeFileSync(env, "# existing\nUNRELATED=keep\n");
        const exported = await result();
        await writePulledConfig(exported, path);
        expect(statSync(env).mode & 0o777).toBe(0o600);
        expect(readFileSync(env, "utf8")).toContain("# existing");
        expect(readDotEnvFile(env).get("UNRELATED")).toBe("keep");
        expect(readFileSync(path, "utf8")).not.toContain("$literal");
        const loaded = loadConfigFile(path);
        expect(loaded.missingEnv).toEqual([]);
        expect(loaded.input.connections[0]!.credentials!.apiToken).toBe("secret\n$literal");
        expect(readdirSync(join(path, ".."))).toEqual([".env", "logt.yaml"]);
    });
    it("refuses config and secret conflicts before touching either destination, and allows explicit replacement", async () => {
        const root = dir(), path = join(root, "logt.yaml"), env = join(root, ".env"), exported = await result();
        writeFileSync(path, "old config");
        writeFileSync(env, "OLD=keep\n");
        await expect(writePulledConfig(exported, path)).rejects.toThrow("exists");
        expect(readFileSync(path, "utf8")).toBe("old config");
        await writePulledConfig(exported, path, true);
        expect(readDotEnvFile(env).get("OLD")).toBe("keep");
        rmSync(path);
        const key = Object.keys(exported.secretValues)[0]!;
        writeFileSync(env, `${key}=old\n`);
        await expect(writePulledConfig(exported, path)).rejects.toThrow("conflicting");
        expect(readFileSync(env, "utf8")).toBe(`${key}=old\n`);
        expect(readdirSync(root)).toEqual([".env"]);
        await writePulledConfig(exported, path, true);
        expect(readDotEnvFile(env).get(key)).toBe(exported.secretValues[key]);
    });
    it("rejects bad exports and unsafe destinations without creating files", async () => {
        const root = dir(), exported = await result(), path = join(root, "logt.yaml");
        await expect(writePulledConfig({ ...exported, secretValues: {} }, path)).rejects.toThrow("missing");
        await expect(writePulledConfig({ ...exported, revision: "sha256:wrong" }, path)).rejects.toThrow("revision");
        await expect(writePulledConfig(exported, join(root, ".env"))).rejects.toThrow("companion");
        mkdirSync(path);
        await expect(writePulledConfig(exported, path)).rejects.toThrow("regular");
        rmSync(path, { recursive: true });
        writeFileSync(join(root, "target"), "untouched");
        symlinkSync(join(root, "target"), path);
        await expect(writePulledConfig(exported, path, true)).rejects.toThrow("regular");
        expect(readFileSync(join(root, "target"), "utf8")).toBe("untouched");
    });
    it("rolls back both files if the second installation fails", async () => {
        const root = dir(), path = join(root, "logt.yaml"), env = join(root, ".env");
        writeFileSync(path, "original");
        writeFileSync(env, "ORIGINAL=keep\n");
        const { renameSync: rename } = await vi.importActual<typeof fs>("node:fs");
        vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(from).endsWith(".tmp") && to === path)
            throw new Error("simulated write failure"); return rename(from, to); });
        await expect(writePulledConfig(await result(), path, true)).rejects.toThrow("simulated");
        expect(readFileSync(path, "utf8")).toBe("original");
        expect(readFileSync(env, "utf8")).toBe("ORIGINAL=keep\n");
        expect(readdirSync(root)).toEqual([".env", "logt.yaml"]);
    });
    it("uses explicit account auth and opts into secret delivery", async () => {
        const exported = {...await result(),configurationVersion:3,desiredSequence:0}, fetch = vi.fn(async (url, init) => { expect(new Headers(init!.headers).get("authorization")).toBe(`Bearer lt_cli_${"A".repeat(43)}`); if(String(url)==="https://service.test/api/me")return Response.json({user:{id:"usr_site",githubLogin:"site"}});expect(String(url)).toBe("https://service.test/api/deployments/dep_site/config?includeSecrets=1"); return Response.json(exported); }) as unknown as typeof globalThis.fetch;
        const client = new LogturaServiceClient({ url: "https://service.test", token: `lt_cli_${"A".repeat(43)}`, fetch });
        const path = join(dir(), "nested", "logt.yaml");
        expect(await pullDeploymentConfig(client, "dep_site", path)).toBe(exported.revision);
        expect(readFileSync(path, "utf8")).toContain("logtura.deployment");
        expect(await readDeploymentLink(path)).toMatchObject({service:client.url,accountId:"usr_site",configurationVersion:3,desiredSequence:0});
    });
    it("keeps recoverable originals when rollback itself fails", async () => {
        const root = dir(), path = join(root, "logt.yaml"), env = join(root, ".env");
        writeFileSync(path, "original");
        writeFileSync(env, "ORIGINAL=keep\n");
        const { renameSync: rename } = await vi.importActual<typeof fs>("node:fs");
        vi.mocked(fs.renameSync).mockImplementation((from, to) => { if (to === path)
            throw new Error("unwritable config"); return rename(from, to); });
        await expect(writePulledConfig(await result(), path, true)).rejects.toThrow("recovery");
        const backup = readdirSync(root).find(file => file.startsWith("logt.yaml.") && file.endsWith(".bak"))!;
        expect(readFileSync(join(root, backup), "utf8")).toBe("original");
        expect(readFileSync(env, "utf8")).toBe("ORIGINAL=keep\n");
    });
    it("executes pull through the CLI and refuses shorthand mutations of exported graphs", async () => {
        const root = dir(), path = join(root, "logt.yaml"), exported = {...await result(),configurationVersion:3,desiredSequence:0};
        vi.stubEnv("LOGT_AUTH_FILE", join(root, "account.json"));
        vi.stubEnv("LOGT_SERVICE_TOKEN", `lt_cli_${"A".repeat(43)}`);
        vi.stubEnv("LOGT_SERVICE_URL", "https://service.test");
        vi.stubGlobal("fetch", vi.fn(async (url) => Response.json(String(url).endsWith("/me")?{user:{id:"usr_site",githubLogin:"site"}}:exported)));
        vi.spyOn(console, "log").mockImplementation(() => { });
        vi.spyOn(console, "error").mockImplementation(() => { });
        try {
            expect(await main(["pull", "dep_site", "-o", path, "--json"])).toBe(0);
            const original = readFileSync(path, "utf8");
            for (const args of [["connect", "cloudflare"], ["source", "add", "cloudflare-worker-tail"], ["sink", "add", "webhook", "new"], ["monitor", "add", "new"]]) {
                expect(await main(["-c", path, ...args])).toBe(1);
                expect(readFileSync(path, "utf8")).toBe(original);
            }
            expect(await main(["pull"])).toBe(1);
            expect(await main(["pull", "dep_site", "--local"])).toBe(1);
            expect(await main(["-c", path, "pull", "dep_site", "--force", "--service", "https://service.test"])).toBe(0);
        }
        finally {
            vi.unstubAllEnvs();
            vi.unstubAllGlobals();
        }
    });
});
