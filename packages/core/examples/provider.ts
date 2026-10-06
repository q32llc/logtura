import type { ProviderDescriptor, ProviderDriver } from "@logtura/core";

/** A fixture-only provider illustrating extension, not a supported live host. */
export const descriptor: ProviderDescriptor = {
  id: "example-logs", family: "example", package: "@example/logtura-driver",
  displayName: "Example", aliases: ["example"],
  credentials: [{ config: "api_token", runtime: "apiToken", env: "EXAMPLE_API_TOKEN" }],
  selection: { field: "sites", aliases: ["include"], sourceKind: "example_site", mode: "list" },
  runtime: "vector",
};

export const driver: ProviderDriver<{ apiToken: string }> = {
  id: descriptor.id, displayName: descriptor.displayName, sourceLabel: "Site",
  capabilities: { selection: "list" },
  async verifyCredentials(credentials) {
    if (credentials.apiToken !== "fixture-token") throw new Error("Example fixture credential rejected");
    return [{ id: "example-account", name: "Example account" }];
  },
  async discoverSources({ credentials, accountId }) {
    await this.verifyCredentials(credentials);
    if (accountId !== "example-account") throw new Error("Example account is not accessible");
    return [{ externalId: "site-a", displayName: "Site A", sourceKind: "example_site", metadata: null }];
  },
  generatePipeline({ connection, selection }) {
    if (selection.kind === "all") throw new Error("Example requires explicit selections");
    if (!/^[a-zA-Z0-9_]+$/.test(connection.id)) throw new Error("Example requires an identifier-safe connection id");
    const key = `example_${connection.id}`;
    // The test fixture emits normalized JSON; a real driver must implement its
    // transport and conversion here, using connection-scoped component keys.
    return {
      components: [{ key, kind: "source", yaml: '    type: stdin\n    decoding:\n      codec: json\n' }],
      outputKey: key, envVars: [], dockerfileDeps: [],
      manifest: [{ id: key, role: "source", category: "primary", label: "Example fixture", links: { connectionId: connection.id } }],
    };
  },
};
