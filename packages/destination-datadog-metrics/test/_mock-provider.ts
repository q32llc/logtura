/** See packages/destination-slack/test/_mock-provider.ts. */
import type { ProviderDriver } from "@logtura/core";

export const mockProvider: ProviderDriver<{ apiToken: string }> = {
  id: "mock-source",
  displayName: "Mock source",
  sourceLabel: "Thing",
  async verifyCredentials() {
    return [{ id: "acct_x", name: "Test" }];
  },
  async discoverSources() {
    return [];
  },
  generateSourceBlock({ source }) {
    return {
      key: `mock_${source.externalId.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      yaml: [
        `    type: demo_logs`,
        `    format: shuffle`,
        `    lines: ["hello"]`,
        `    interval: 1`,
      ].join("\n"),
    };
  },
  generateNormalize({ inputKeys }) {
    if (inputKeys.length === 0) return null;
    return {
      key: "mock_norm",
      yaml: [
        `    type: remap`,
        `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
        `    source: |-`,
        `      .script = "mock"`,
        `      .message = string(.message) ?? "hi"`,
        `      .level = "info"`,
        `      .error = false`,
      ].join("\n"),
    };
  },
  runtimeSpec() {
    return { envVars: [], dockerfileDeps: [] };
  },
};
