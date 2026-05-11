/** Black-box `vector validate` for the fly-log-tail driver.
 *  Pinned by the historic $app pre-pass regression — Vector
 *  pre-substitutes $VAR before parsing, so the jq filter has to
 *  use $$app, and this test fails if anyone "fixes" that escape. */
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
import { flyLogTailDriver } from "../src/index";

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
  provider: "fly-log-tail",
  displayName: "test fly",
  externalAccountId: "personal",
};

const dummySources = [
  {
    id: "src_a",
    externalId: "my-app",
    displayName: "my-app",
    sourceKind: "fly_app",
    metadata: null,
  },
  {
    id: "src_b",
    externalId: "other-app",
    displayName: "other-app",
    sourceKind: "fly_app",
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
    providers: [flyLogTailDriver],
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

function vectorValidate(yaml: string, envNames: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "logtura-vec-fly-"));
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

describe.skipIf(!dockerAvailable)("vector validate — fly-log-tail", () => {
  it("two apps + errors monitor → blackhole", () => {
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

  it("$$app escape survives Vector's env-var pre-pass", () => {
    // Regression guard: a bare $app in the jq filter would be
    // substituted to "" at config-load time and crash Vector with
    // "Missing environment variable in config. name = app".
    const bundle = bundleFor({ monitors: [] });
    expect(bundle.vectorYaml).toContain("$$app");
    const { status, output } = vectorValidate(
      bundle.vectorYaml,
      bundle.envVars.map((v) => v.name),
    );
    expect(status, output).toBe(0);
  });
});
