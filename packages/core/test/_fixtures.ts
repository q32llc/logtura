/** Minimal in-test driver fixtures. Real drivers live in their own
 *  packages; here we just need *something* that satisfies the
 *  ProviderDriver / DestinationDriver contract so we can exercise
 *  the renderer with predictable output. */
import type {
  DestinationDriver,
  ProviderDriver,
} from "../src/index";

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
        `    type: exec`,
        `    command: ["echo", ${JSON.stringify(source.externalId)}]`,
        `    mode: streaming`,
        `    decoding:`,
        `      codec: json`,
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
        `      .message = string(.message) ?? ""`,
        `      .level = "info"`,
        `      .error = false`,
      ].join("\n"),
    };
  },
  runtimeSpec() {
    return {
      envVars: [
        {
          name: "MOCK_API_TOKEN",
          description: "test token",
          source: "credential",
          credentialPath: "apiToken",
        },
      ],
      dockerfileDeps: [],
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
