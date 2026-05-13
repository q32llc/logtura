/** Minimal in-test driver fixtures. Real drivers live in their own
 *  packages; here we just need *something* that satisfies the
 *  ProviderDriver / DestinationDriver contract so we can exercise
 *  the renderer with predictable output. */
import type {
  ComponentManifestEntry,
  DestinationDriver,
  ProviderDriver,
  VectorComponent,
} from "../src/index";

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
    const manifest: ComponentManifestEntry[] = [];
    const sourceKeys: string[] = [];
    for (const source of selection.sources) {
      const key = `mock_${safeConn}_${source.externalId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      sourceKeys.push(key);
      components.push({
        key,
        kind: "source",
        yaml: [
          `    type: exec`,
          `    command: ["echo", ${JSON.stringify(source.externalId)}]`,
          `    mode: streaming`,
          `    decoding:`,
          `      codec: json`,
        ].join("\n"),
      });
      manifest.push({
        id: key,
        role: "source",
        category: "primary",
        label: `Thing · ${source.displayName}`,
        links: { connectionId: connection.id, sourceId: source.id },
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
          `      .message = string(.message) ?? ""`,
          `      .level = "info"`,
          `      .error = false`,
        ].join("\n"),
      });
    }
    return {
      components,
      outputKey: normalizeKey,
      envVars: [
        {
          name: "MOCK_API_TOKEN",
          description: "test token",
          source: "credential",
          credentialPath: "apiToken",
        },
      ],
      dockerfileDeps: [],
      manifest,
    };
  },
};

export const mockProviderWithAsset: ProviderDriver<{ apiToken: string }> = {
  ...mockProvider,
  id: "mock-source-with-asset",
  generatePipeline(input) {
    const pipe = mockProvider.generatePipeline(input);
    return {
      ...pipe,
      runtimeAssets: [
        {
          path: "bin/mock-helper.sh",
          content: "#!/bin/sh\necho mock\n",
          mode: 0o755,
        },
      ],
    };
  },
};


export const mockDestination: DestinationDriver<{ url: string }> = {
  id: "mock-sink",
  displayName: "Mock sink",
  description: "test",
  flows: ["logs"],
  generateSinkBundle({ inputs, sinkKey, envVarName }) {
    const remapKey = `${sinkKey}_format`;
    return {
      preSinkTransforms: [
        {
          key: remapKey,
          yaml: [
            `    type: remap`,
            `    inputs: [${inputs.map((i) => `"${i}"`).join(", ")}]`,
            `    source: |-`,
            `      .text = string(.message) ?? ""`,
          ].join("\n"),
        },
      ],
      sink: {
        key: sinkKey,
        yaml: [
          `    type: http`,
          `    inputs: ["${remapKey}"]`,
          `    uri: "\${${envVarName}}"`,
          `    method: post`,
          `    encoding:`,
          `      codec: json`,
          `    framing:`,
          `      method: newline_delimited`,
          `    healthcheck:`,
          `      enabled: false`,
        ].join("\n"),
      },
    };
  },
  runtimeEnvVars({ envVarName }) {
    return [
      {
        name: envVarName,
        description: "test URL",
        source: "destination",
      },
    ];
  },
  envVarValue(config) {
    return config.url;
  },
};
