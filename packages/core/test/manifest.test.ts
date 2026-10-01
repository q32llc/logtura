import { describe, it, expect } from "vitest";
import { createSecretVersioner, exportDeploymentManifest, parseDeploymentManifest, normalizeDeploymentManifest } from "../src/manifest";
import { hashConfigDocument, parseConfigDocument, normalizeConfigDocument } from "../src/config";
import { generateBundle } from "../src/render";
import { fixture } from "./graph-fixture";
async function exported(input = fixture()) { return exportDeploymentManifest(input, await createSecretVersioner("private-key")); }
describe("portable deployment graphs", () => {
    it("round trips the complete graph and exact generated artifacts through the standard config parser", async () => {
        const original = fixture(), result = await exported(original);
        const parsed = parseConfigDocument(result.document, { env: result.secretValues, providers: original.providers, destinations: original.destinations, filename: "portable.yaml" });
        expect(parsed.input).toEqual(original);
        expect(parsed.missingEnv).toEqual([]);
        expect(parsed.path).toBe("portable.yaml");
        expect(generateBundle(parsed.input)).toEqual(generateBundle(original));
        expect(normalizeConfigDocument(result.document)).toEqual(result.document);
        const json = JSON.stringify(result.document);
        for (const secret of ["metadata-secret", "credential-secret", "refresh-secret", "destination-secret", "report-secret", "secret.example"])
            expect(json).not.toContain(secret);
        expect(result.document.connections[0]!.selectedSources[0]!.id).toBe("src_original");
        expect(result.document.monitors[0]!.sinks[0]!.sink.filterSteps).toEqual(original.monitors[0]!.sinks[0]!.sink.filterSteps);
    });
    it("makes versions stable and sensitive to secret and topology changes", async () => {
        const first = await exported();
        const again = await exported();
        expect(again).toEqual(first);
        const hash = await hashConfigDocument(first.document);
        const changed = fixture();
        changed.connections[0]!.credentials!.apiToken = "changed";
        expect(await hashConfigDocument((await exported(changed)).document)).not.toBe(hash);
        const renamed = fixture();
        renamed.connections[0]!.selectedSources[0]!.displayName = "New site";
        expect(await hashConfigDocument((await exported(renamed)).document)).not.toBe(hash);
        expect((await exportDeploymentManifest(fixture(), await createSecretVersioner("different-key"))).document).not.toEqual(first.document);
        expect(await hashConfigDocument(first.document, { env: {} })).toBe(hash);
    });
    it("strips caller storage fields rather than accidentally publishing them", async () => {
        const input = fixture();
        Object.assign(input.connections[0]!.connection, { credentials_encrypted: "storage-secret" });
        Object.assign(input.connections[0]!.selectedSources[0]!, { extra: "storage-secret" });
        Object.assign(input.monitors[0]!.monitor, { audit: "storage-secret" });
        Object.assign(input.monitors[0]!.sinks[0]!.destination, { config_encrypted: "storage-secret" });
        expect(JSON.stringify((await exported(input)).document)).not.toContain("storage-secret");
    });
    it("handles absent credentials, metadata, reporting and optional all selection", async () => {
        const input = fixture();
        input.connections[0]!.credentials = undefined;
        input.connections[0]!.selectedSources[0]!.metadata = null;
        input.connections[0]!.selectAll = false;
        delete input.heartbeat;
        delete input.metrics;
        delete input.runtimeEnv;
        const result = await exported(input);
        expect(parseDeploymentManifest(result.document, { env: result.secretValues, providers: input.providers, destinations: input.destinations }).input).toEqual(input);
        expect(parseDeploymentManifest(result.document, { env: Object.create(result.secretValues) }).missingEnv).toEqual(Object.keys(result.secretValues));
        input.heartbeat = { kind: "none", deploymentId: "dep", appUrl: "https://example.test" };
        input.metrics = { kind: "none" };
        input.connections[0]!.selectAll = true;
        expect(parseDeploymentManifest((await exported(input)).document).input.connections[0]!.selectAll).toBe(true);
    });
    it("round trips destination metrics and missing secrets", async () => {
        const input = fixture();
        input.monitors[0]!.monitor.connectionId = null;
        input.metrics = { kind: "destination", destination: input.monitors[0]!.sinks[0]!.destination, destinationConfig: { key: "metrics-secret" } };
        const result = await exported(input);
        expect(parseDeploymentManifest(result.document, { env: result.secretValues, providers: input.providers, destinations: input.destinations }).input).toEqual(input);
        const unresolved = parseDeploymentManifest(result.document);
        expect(unresolved.missingEnv).toEqual(Object.keys(result.secretValues).sort());
        expect(unresolved.requiredEnv).toEqual(unresolved.missingEnv);
        expect(parseDeploymentManifest(result.document, { env: Object.fromEntries(Object.keys(result.secretValues).map(k => [k, ""])) }).missingEnv).toEqual(unresolved.missingEnv);
    });
    it("refuses missing version keys, empty versions and conflicting driver payload identities", async () => {
        await expect(createSecretVersioner("")).rejects.toThrow("private");
        await expect(exportDeploymentManifest(fixture(), async () => "")).rejects.toThrow("nonempty");
        const input = fixture();
        input.connections[0]!.selectedSources.push({ ...input.connections[0]!.selectedSources[0]!, metadata: { different: true } });
        await expect(exported(input)).rejects.toThrow("Conflicting");
    });
    it.each([
        (d: any) => { d.schema_version = 2; }, (d: any) => { d.kind = "other"; }, (d: any) => { d.extra = "secret"; }, (d: any) => { d.connections = null; }, (d: any) => { d.connections[0].selectAll = "true"; },
        (d: any) => { d.connections[0].connection.id = ""; }, (d: any) => { d.connections[0].connection.externalAccountId = 12; }, (d: any) => { d.connections[0].credentials.env = "bad-key"; }, (d: any) => { d.connections[0].credentials.version = ""; }, (d: any) => { d.connections[0].credentials.raw = "secret"; },
        (d: any) => { d.monitors[0].monitor.enabled = 1; }, (d: any) => { d.monitors[0].monitor.connectionId = "unknown"; }, (d: any) => { d.metrics.kind = "other"; }, (d: any) => { d.heartbeat.kind = "other"; }, (d: any) => { d.monitors[0].monitor.filterSteps = {}; },
        (d: any) => { d.connections.push(d.connections[0]); }, (d: any) => { d.connections[0].selectedSources.push(d.connections[0].selectedSources[0]); }, (d: any) => { d.monitors.push(d.monitors[0]); }, (d: any) => { d.monitors[0].sinks.push(d.monitors[0].sinks[0]); },
        (d: any) => { d.monitors[0].monitor.filterSteps = [{ kind: "unknown" }]; }, (d: any) => { d.monitors[0].monitor.filterSteps = [{ kind: "errors", token: "secret" }]; }, (d: any) => { d.monitors[0].monitor.filterSteps = [{ kind: "level", level: "x", mode: "bad" }]; }, (d: any) => { d.monitors[0].monitor.filterSteps = [{ kind: "match", pattern: "x", mode: "bad" }]; },
        ...["rate_limit", "sample", "dedup", "rollup"].map(kind => (d: any) => { d.monitors[0].monitor.filterSteps = [{ kind }]; }),
        ...["window_secs", "max_samples"].flatMap(key => [0, -1, "bad"].map(value => (d: any) => { d.monitors[0].monitor.filterSteps = [{ kind: "rollup", window_secs: 30, [key]: value }]; })),
        (d: any) => { d.monitors[0].monitor.filterSteps = [{ kind: "dedup", window_secs: 5, fields: [12] }]; }, (d: any) => { d.monitors[0].monitor.filterSteps = [{ kind: "match", pattern: "x", mode: "include", field: "" }]; },
    ])("rejects malformed graphs and unsupported fields (%#)", async (mutate) => { const { document } = await exported(); mutate(document); expect(() => normalizeDeploymentManifest(document)).toThrow(); });
    it("rejects malformed JSON payloads without including their contents in errors", async () => {
        const result = await exported();
        const name = result.document.connections[0]!.credentials!.env;
        result.secretValues[name] = "secret-not-json";
        expect(() => parseDeploymentManifest(result.document, { env: result.secretValues })).toThrow("invalid JSON secret");
        try {
            parseDeploymentManifest(result.document, { env: result.secretValues });
        }
        catch (error) {
            expect(String(error)).not.toContain("secret-not-json");
        }
        for (const payload of ["null", "[]", "12"]) {
            result.secretValues[name] = payload;
            expect(() => parseDeploymentManifest(result.document, { env: result.secretValues })).toThrow("credentials payload");
        }
        result.secretValues[name] = "{}";
        result.secretValues[result.document.runtimeEnv!.env] = '{"bad-key":"x"}';
        expect(() => parseDeploymentManifest(result.document, { env: result.secretValues })).toThrow("runtime");
        result.secretValues[result.document.runtimeEnv!.env] = '{"VALID":12}';
        expect(() => parseDeploymentManifest(result.document, { env: result.secretValues })).toThrow("runtime");
    });
    it.each(["connection","source","monitor","sink"])("rejects %s IDs that collide after Vector key normalization",async(entity)=>{
      const {document}=await exported();
      if(entity==="connection"){document.connections[0]!.connection.id="con-original";document.monitors[0]!.monitor.connectionId="con-original";document.connections.push({...document.connections[0]!,connection:{...document.connections[0]!.connection,id:"con_original"},selectedSources:[]});}
      if(entity==="source"){document.connections[0]!.selectedSources[0]!.id="src-original";document.connections[0]!.selectedSources.push({...document.connections[0]!.selectedSources[0]!,id:"src_original"});}
      if(entity==="monitor"){document.monitors[0]!.monitor.id="mon-original";document.monitors.push({...document.monitors[0]!,monitor:{...document.monitors[0]!.monitor,id:"mon_original"},sinks:[]});}
      if(entity==="sink"){document.monitors[0]!.sinks[0]!.sink.id="snk-original";document.monitors[0]!.sinks.push({...document.monitors[0]!.sinks[0]!,sink:{...document.monitors[0]!.sinks[0]!.sink,id:"snk_original"}});}
      expect(()=>normalizeDeploymentManifest(document)).toThrow(`Duplicate ${entity} identity`);
    });

});
