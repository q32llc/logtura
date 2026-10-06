/** Reusable public test harness. Provider-specific protocol tests remain required. */
import { describe, expect, it } from "vitest";
import { generateBundle, type ProviderDescriptor, type ProviderDriver, type SourceRef } from "@logtura/core";

export function providerContract(driver: ProviderDriver, descriptor: ProviderDescriptor, sources: SourceRef[]): void {
  describe(`${driver.id} public provider contract`, () => {
    const connection = { id: "con_contract_a", displayName: "Contract", externalAccountId: "fixture" };
    it("agrees with the public catalog", () => {
      expect(driver.id).toBe(descriptor.id);
      expect(driver.capabilities.selection).toBe(descriptor.selection.mode);
    });
    it("renders deterministically with valid output and manifest wiring", () => {
      const input = { connection, selection: { kind: "list" as const, sources } };
      const pipeline = driver.generatePipeline(input);
      expect(driver.generatePipeline(input)).toEqual(pipeline);
      const keys = pipeline.components.map(component => component.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toContain(pipeline.outputKey);
      for (const row of pipeline.manifest ?? []) expect(keys).toContain(row.id);
      for (const asset of pipeline.runtimeAssets ?? []) {
        expect(asset.path).not.toMatch(/(^\/|(?:^|\/)\.\.(?:\/|$)|\\)/);
        expect(asset.content.length).toBeGreaterThan(0);
      }
      expect(new Set(pipeline.envVars.map(field => field.name)).size).toBe(pipeline.envVars.length);
    });
    it("does not collide across independent connections", () => {
      const a = driver.generatePipeline({ connection, selection: { kind: "list", sources } });
      const b = driver.generatePipeline({ connection: { ...connection, id: "con_contract_b" }, selection: { kind: "list", sources } });
      expect(a.components.filter(row => b.components.some(other => other.key === row.key))).toEqual([]);
    });
    it("honors the documented all-selection capability", () => {
      const run = () => driver.generatePipeline({ connection, selection: { kind: "all" } });
      if (descriptor.selection.mode === "list") expect(run).toThrow();
      else expect(run().components.length).toBeGreaterThan(0);
    });
    it("renders an empty selection without a dangling provider output", () => {
      const bundle = generateBundle({ providers: [driver], destinations: [], connections: [{ connection: { ...connection, provider: driver.id }, selectedSources: [], credentials: {} }], monitors: [], heartbeat: { kind: "none", deploymentId: "fixture", appUrl: "http://localhost" } });
      expect(bundle.selectedCount).toBe(0);
      const pipeline = driver.generatePipeline({ connection, selection: { kind: "list", sources: [] } });
      if (pipeline.components.length) expect(bundle.vectorYaml).toContain(`  ${pipeline.outputKey}:`);
      else expect(bundle.vectorYaml).not.toContain(`  ${pipeline.outputKey}:`);
    });
  });
}
