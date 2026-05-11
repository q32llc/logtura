/** Black-box `vector validate` for the cloudflare-ai-gateway driver.
 *  See packages/driver-cloudflare-worker-tail/test/vector-validate.test.ts
 *  for the rationale — same pattern, different driver. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DestinationDriver,
  type GenerateInput,
  generateBundle,
} from "@logtura/core";
import { describe, expect, it } from "vitest";
import { cloudflareAiGatewayDriver } from "../src/index";

const VECTOR_IMAGE = "timberio/vector:latest-debian";

const dockerAvailable = (() => {
  const r = spawnSync("docker", ["--version"], { encoding: "utf8" });
  return r.status === 0;
})();

const blackholeDestination: DestinationDriver<Record<string, never>> = {
  id: "blackhole",
  displayName: "Blackhole",
  description: "Test-only no-op sink",
  flows: ["logs"],
  generateSinkBundle({ inputs, sinkKey }) {
    return {
      sink: {
        key: sinkKey,
        yaml: [
          `    type: blackhole`,
          `    inputs: [${inputs.map((i) => `"${i}"`).join(", ")}]`,
          `    print_interval_secs: 0`,
        ].join("\n"),
      },
    };
  },
  runtimeEnvVars() {
    return [];
  },
  envVarValue() {
    return null;
  },
};

const dummyConnection = {
  id: "con_test",
  provider: "cloudflare-ai-gateway",
  displayName: "test ai gw",
  externalAccountId: "f0c6ed442ab8c6bf9d102678d9421dd8",
};

const dummySources = [
  {
    id: "src_g1",
    externalId: "my-gateway",
    displayName: "my-gateway",
    sourceKind: "cf_ai_gateway",
    metadata: null,
  },
];

const blackholeSink = {
  sink: { id: "snk_x", filterSteps: [] },
  destination: { id: "dst_blk", kind: "blackhole", displayName: "blackhole" },
  destinationConfig: {},
};

function bundleFor(input: Partial<GenerateInput>) {
  return generateBundle({
    providers: [cloudflareAiGatewayDriver],
    destinations: [blackholeDestination],
    connections: [
      {
        connection: dummyConnection,
        selectedSources: dummySources,
        credentials: { apiToken: "placeholder" },
      },
    ],
    monitors: [],
    ...input,
  });
}

function vectorValidate(yaml: string, envNames: string[]): {
  status: number | null;
  output: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "logtura-vec-aigw-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vector.yaml"), yaml);
  writeFileSync(
    join(dir, ".env"),
    envNames.map((n) => `${n}=placeholder`).join("\n"),
  );
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--env-file",
      join(dir, ".env"),
      "-v",
      `${join(dir, "vector.yaml")}:/etc/vector/vector.yaml:ro`,
      "--entrypoint",
      "/usr/bin/vector",
      VECTOR_IMAGE,
      "validate",
      "--skip-healthchecks",
      "/etc/vector/vector.yaml",
    ],
    { encoding: "utf8" },
  );
  return { status: r.status, output: (r.stderr ?? "") + (r.stdout ?? "") };
}

describe.skipIf(!dockerAvailable)("vector validate — cloudflare-ai-gateway", () => {
  it("errors-monitor → blackhole sink", () => {
    const bundle = bundleFor({
      monitors: [
        {
          monitor: {
            id: "mon_errors",
            connectionId: null,
            displayName: "errors",
            filterSteps: [{ kind: "errors" }],
            enabled: true,
          },
          sinks: [blackholeSink],
        },
      ],
    });
    const { status, output } = vectorValidate(
      bundle.vectorYaml,
      bundle.envVars.map((v) => v.name),
    );
    expect(status, output).toBe(0);
  });
});
