/** Black-box `vector validate` for the slack destination. Pinned
 *  by the historic 400 ("no_text") regression — without
 *  newline_delimited + max_events:1 Vector wraps the batch in a
 *  JSON array, which the Slack incoming-webhook endpoint rejects. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GenerateInput, generateBundle } from "@logtura/core";
import { describe, expect, it } from "vitest";
import { slackDriver } from "../src/index";
import { mockProvider } from "./_mock-provider";

const VECTOR_IMAGE = "timberio/vector:latest-debian";

const dockerAvailable = (() => {
  const r = spawnSync("docker", ["--version"], { encoding: "utf8" });
  return r.status === 0;
})();

const dummyConnection = {
  id: "con_test",
  provider: "mock-source",
  displayName: "test",
  externalAccountId: "acct_x",
};

const dummySources = [
  {
    id: "src_a",
    externalId: "thing",
    displayName: "thing",
    sourceKind: "mock",
    metadata: null,
  },
];

const slackSink = {
  sink: { id: "snk_slack", filterSteps: [] },
  destination: {
    id: "dst_slack",
    kind: "slack",
    displayName: "alerts",
  },
  destinationConfig: {
    webhookUrl: "https://hooks.slack.com/services/T00/B00/XXX",
    teamName: "q32",
    channel: "alerts",
  },
};

function bundleFor(input: Partial<GenerateInput>) {
  return generateBundle({
    providers: [mockProvider],
    destinations: [slackDriver],
    connections: [
      {
        connection: dummyConnection,
        selectedSources: dummySources,
      },
    ],
    monitors: [],
    ...input,
  });
}

function vectorValidate(yaml: string, envNames: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "logtura-vec-slack-"));
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

describe.skipIf(!dockerAvailable)("vector validate — slack destination", () => {
  it("errors+rollup monitor → slack sink", () => {
    const bundle = bundleFor({
      monitors: [
        {
          monitor: {
            id: "mon_x",
            connectionId: null,
            displayName: "errors",
            filterSteps: [
              { kind: "errors" },
              { kind: "rollup", window_secs: 30, group_by: [], max_samples: 5 },
            ],
            enabled: true,
          },
          sinks: [slackSink],
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
