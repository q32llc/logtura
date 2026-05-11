/** Black-box `vector validate` for the supabase-edge-logs driver.
 *  Pinned by:
 *    - the wrapped-response unwrap (`records = array(.result.result)`)
 *      — would compile-error in VRL if we used `string()` or other
 *      wrong type-assertions
 *    - the for_each + push + `. = out` fan-out pattern — Vector
 *      validates the entire VRL ahead of runtime
 *    - the URL-encoded SQL — would surface as a config-load error
 *      if Vector's $VAR pre-pass collides with anything in the SQL
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
import { supabaseEdgeLogsDriver } from "../src/index";

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
  provider: "supabase-edge-logs",
  displayName: "askthe",
  externalAccountId: "edzvfyvdtvwrnaoyupqq",
};

const dummySources = [
  {
    id: "src_chat",
    externalId: "agent-chat",
    displayName: "agent-chat",
    sourceKind: "supabase_edge_fn",
    metadata: { function_id: "6eda78cc-fc80-40f0-bd85-05ab0388842c" },
  },
  {
    id: "src_thread",
    externalId: "agent-thread",
    displayName: "agent-thread",
    sourceKind: "supabase_edge_fn",
    metadata: { function_id: "0ab47137-d31d-45b6-a31a-bf3c90b85d9a" },
  },
];

const blackholeSink = {
  sink: { id: "snk_x", filterSteps: [] },
  destination: { id: "dst_blk", kind: "blackhole", displayName: "blackhole" },
  destinationConfig: {},
};

function bundleFor(input: Partial<GenerateInput>) {
  return generateBundle({
    providers: [supabaseEdgeLogsDriver],
    destinations: [blackholeDestination],
    connections: [
      {
        connection: dummyConnection,
        selectedSources: dummySources,
        credentials: { pat: "placeholder" },
      },
    ],
    monitors: [],
    ...input,
  });
}

function vectorValidate(yaml: string, envNames: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "logtura-vec-sb-"));
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

describe.skipIf(!dockerAvailable)(
  "vector validate — supabase-edge-logs",
  () => {
    it("two edge functions + errors+rollup monitor → blackhole", () => {
      const bundle = bundleFor({
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
      const { status, output } = vectorValidate(
        bundle.vectorYaml,
        bundle.envVars.map((v) => v.name),
      );
      expect(status, output).toBe(0);
    });

    it("zero selected functions → heartbeat-only", () => {
      const out = generateBundle({
        providers: [supabaseEdgeLogsDriver],
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
  },
);
