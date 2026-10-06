import { describe, expect, it, vi, afterEach } from "vitest";
import { parseConfigDocument, generateBundle, providerDescriptor, PROVIDER_CATALOG, type ProviderDriver } from "@logtura/core";
import { driver, descriptor } from "../../core/examples/provider";
import { providerContract } from "../../core/test/provider-contract";
import { tokenProviderConnector } from "../src/provider-connectors";
import { listProviders, listDestinations } from "../src/registry";

const sources = [{ id: "src_example", externalId: "site-a", displayName: "Site A", sourceKind: "example_site", metadata: null }];
providerContract(driver as ProviderDriver, descriptor, sources);
for (const driver of listProviders().filter(driver => driver.id !== "custom-vector")) {
  const descriptor = providerDescriptor(driver.id)!;
  const source = { id: "src_contract", externalId: "resource", displayName: "Resource", sourceKind: descriptor.selection.sourceKind, metadata: { environment_id: "env", function_id: "fn" } };
  providerContract(driver, descriptor, [source]);
}
afterEach(() => vi.restoreAllMocks());
describe("a contributed provider without core host branches", () => {
  it("connects, resolves credentials and renders a complete bundle from a new descriptor", async () => {
    const connector = tokenProviderConnector(descriptor, driver as ProviderDriver);
    const connected = await connector.connect({ name: "example", env: { values: new Map([["EXAMPLE_API_TOKEN", "fixture-token"]]) }, options: { quiet: true } });
    expect(connected.accountId).toBe("example-account");
    expect(connected.sources[0]!.items[0]!.externalId).toBe("site-a");
    const parsed = parseConfigDocument({ providers: { example: { provider: "example", account_id: connected.accountId, credentials: { api_token: "env:EXAMPLE_API_TOKEN" } } }, sources: { example: { sites: ["site-a"] } } }, { providerDescriptors: [...PROVIDER_CATALOG, descriptor], providers: [driver as ProviderDriver], destinations: listDestinations(), env: { EXAMPLE_API_TOKEN: "fixture-token" } });
    expect(parsed.missingEnv).toEqual([]);
    expect(parsed.input.connections[0]!.credentials).toEqual({ apiToken: "fixture-token" });
    expect(parsed.input.connections[0]!.selectedSources[0]!.sourceKind).toBe("example_site");
    expect(generateBundle(parsed.input).vectorYaml).toContain("type: stdin");
  });
  it("rejects the wrong credential and account without accepting a fake discovery", async () => {
    await expect(driver.verifyCredentials({ apiToken: "wrong" })).rejects.toThrow("credential rejected");
    await expect(driver.discoverSources({ credentials: { apiToken: "fixture-token" }, accountId: "other" })).rejects.toThrow("not accessible");
    expect(() => driver.generatePipeline({ connection: { id: "bad-id", displayName: "Bad", externalAccountId: null }, selection: { kind: "list", sources } })).toThrow("identifier-safe");
  });
});
