/** Throwaway provider used by destination tests. Emits a `demo_logs`
 *  Vector source so the pipeline has something to feed. Each
 *  destination package carries one of these so tests stay
 *  self-contained (no cross-package test fixtures). */
import type { ProviderDriver, VectorComponent } from "@logtura/core";

export const mockProvider: ProviderDriver<{ apiToken: string }> = {
  id: "mock-source",
  displayName: "Mock source",
  sourceLabel: "Thing",
  capabilities: { selection: "list" },
  async verifyCredentials() {
    return [{ id: "acct_x", name: "Test" }];
  },
  async discoverSources() {
    return [];
  },
  generatePipeline({ connection, selection }) {
    if (selection.kind === "all") {
      throw new Error("mock-source does not support \"all\"");
    }
    const safeConn = connection.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const components: VectorComponent[] = [];
    const sourceKeys: string[] = [];
    for (const source of selection.sources) {
      const key = `mock_${safeConn}_${source.externalId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      sourceKeys.push(key);
      components.push({
        key,
        kind: "source",
        yaml: [
          `    type: demo_logs`,
          `    format: shuffle`,
          `    lines: ["hello"]`,
          `    interval: 1`,
        ].join("\n"),
      });
    }
    const normalizeKey = `mock_${safeConn}_norm`;
    if (sourceKeys.length > 0) {
      components.push({
        key: normalizeKey,
        kind: "transform",
        yaml: [
          `    type: remap`,
          `    inputs: [${sourceKeys.map((k) => `"${k}"`).join(", ")}]`,
          `    source: |-`,
          `      .script = "mock"`,
          `      .message = string(.message) ?? "hi"`,
          `      .level = "info"`,
          `      .error = false`,
        ].join("\n"),
      });
    }
    return {
      components,
      outputKey: normalizeKey,
      envVars: [],
      dockerfileDeps: [],
    };
  },
};
