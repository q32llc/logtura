/** Black-box validate test for the cloudflare-worker-tail driver.
 *
 * Compose representative bundles through @logtura/core, hand the
 * generated YAML to `vector validate` running in
 * timberio/vector:latest, and assert the binary accepts it. This is
 * where E103/E651/E701 VRL bugs surface — the unit tests above only
 * exercise the renderer, not Vector's own VRL compiler.
 *
 * Each driver self-validates from its own package: contributors
 * adding a driver don't update any central fixture file, they add
 * one of these per package.
 *
 * Test is skipped when docker is not available so it doesn't break
 * environments without docker access (cf-workers CI, sandboxed
 * containers). The CI workflow runs this in a docker-enabled
 * runner; running locally with `docker pull timberio/vector:latest`
 * is enough.
 */
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
import { cloudflareWorkerTailDriver } from "../src/index";

// `latest` alone doesn't exist on docker.io/timberio/vector — Vector
// switched to distribution-suffixed tags (`latest-debian`,
// `latest-alpine`, `latest-distroless-libc`). debian is the largest
// but the most forgiving for our exec command (sh + jq are
// preinstalled on debian only by virtue of having a shell at all).
const VECTOR_IMAGE = "timberio/vector:latest-debian";

const dockerAvailable = (() => {
  const result = spawnSync("docker", ["--version"], { encoding: "utf8" });
  return result.status === 0;
})();

/** Smallest possible DestinationDriver — a `blackhole` sink. Vector
 *  ships it; it has no required config, no network surface. Lets us
 *  validate "the source + normalize + monitor + sink chain compiles"
 *  without inflating the test with a real Slack/webhook driver. */
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
  provider: "cloudflare-worker-tail",
  displayName: "test cf",
  externalAccountId: "f0c6ed442ab8c6bf9d102678d9421dd8",
};

const dummySources = [
  {
    id: "src_w1",
    externalId: "my-worker",
    displayName: "my-worker",
    sourceKind: "cf_worker",
    metadata: null,
  },
  {
    id: "src_w2",
    externalId: "other-worker",
    displayName: "other-worker",
    sourceKind: "cf_worker",
    metadata: null,
  },
];

const blackholeSink = {
  sink: { id: "snk_x", filterSteps: [] },
  destination: {
    id: "dst_blk",
    kind: "blackhole",
    displayName: "blackhole",
  },
  destinationConfig: {},
};

function bundleFor(input: Partial<GenerateInput>): {
  yaml: string;
  envNames: string[];
} {
  const out = generateBundle({
    providers: [cloudflareWorkerTailDriver],
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
  return { yaml: out.vectorYaml, envNames: out.envVars.map((v) => v.name) };
}

function vectorValidate(yaml: string, envNames: string[]): {
  status: number | null;
  output: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "logtura-vec-cf-"));
  mkdirSync(dir, { recursive: true });
  const yamlPath = join(dir, "vector.yaml");
  writeFileSync(yamlPath, yaml);
  const envPath = join(dir, ".env");
  writeFileSync(envPath, envNames.map((n) => `${n}=placeholder`).join("\n"));

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--env-file",
      envPath,
      "-v",
      `${yamlPath}:/etc/vector/vector.yaml:ro`,
      "--entrypoint",
      "/usr/bin/vector",
      VECTOR_IMAGE,
      "validate",
      // --skip-healthchecks disables outbound probes (we don't want
      // CI hitting Cloudflare/Slack). Crucially: we do NOT pass
      // --no-environment, which would skip the VRL compile pass —
      // that's the entire point of this test.
      "--skip-healthchecks",
      "/etc/vector/vector.yaml",
    ],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    output: (result.stderr ?? "") + (result.stdout ?? ""),
  };
}

describe.skipIf(!dockerAvailable)("vector validate — cloudflare-worker-tail", () => {
  it("default errors+rollup monitor → blackhole sink", () => {
    const { yaml, envNames } = bundleFor({
      monitors: [
        {
          monitor: {
            id: "mon_errors",
            connectionId: null,
            displayName: "errors",
            filterSteps: [
              { kind: "errors" },
              {
                kind: "rollup",
                window_secs: 30,
                group_by: ["script"],
                max_samples: 5,
              },
            ],
            enabled: true,
          },
          sinks: [blackholeSink],
        },
      ],
    });
    const { status, output } = vectorValidate(yaml, envNames);
    expect(status, output).toBe(0);
  });

  it("every filter step kind in one monitor", () => {
    const { yaml, envNames } = bundleFor({
      monitors: [
        {
          monitor: {
            id: "mon_kitchen",
            connectionId: null,
            displayName: "kitchen",
            filterSteps: [
              { kind: "errors" },
              {
                kind: "match",
                pattern: "timeout|refused",
                mode: "include",
                field: "message",
              },
              { kind: "level", level: "warn", mode: "include" },
              { kind: "rate_limit", per_minute: 120 },
              { kind: "sample", rate: 0.5 },
              { kind: "dedup", window_secs: 60, fields: ["message", "script"] },
              { kind: "rollup", window_secs: 10, group_by: [], max_samples: 3 },
            ],
            enabled: true,
          },
          sinks: [blackholeSink],
        },
      ],
    });
    const { status, output } = vectorValidate(yaml, envNames);
    expect(status, output).toBe(0);
  });

  it("zero selected sources → heartbeat-only pipeline", () => {
    const out = generateBundle({
      providers: [cloudflareWorkerTailDriver],
      destinations: [blackholeDestination],
      connections: [
        {
          connection: dummyConnection,
          selectedSources: [],
        },
      ],
      monitors: [],
      heartbeat: {
        kind: "logtura",
        deploymentId: "dep_test",
        appUrl: "https://logtura.example.com",
      },
    });
    const { status, output } = vectorValidate(
      out.vectorYaml,
      out.envVars.map((v) => v.name),
    );
    expect(status, output).toBe(0);
  });
});
