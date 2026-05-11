/** Black-box `vector validate` for the webhook destination. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBundle } from "@logtura/core";
import { describe, expect, it } from "vitest";
import { webhookDriver } from "../src/index";
import { mockProvider } from "./_mock-provider";

const VECTOR_IMAGE = "timberio/vector:latest-debian";

const dockerAvailable = (() => {
  const r = spawnSync("docker", ["--version"], { encoding: "utf8" });
  return r.status === 0;
})();

function vectorValidate(yaml: string, envNames: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "logtura-vec-webhook-"));
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

describe.skipIf(!dockerAvailable)("vector validate — webhook destination", () => {
  it("errors monitor → https webhook", () => {
    const bundle = generateBundle({
      providers: [mockProvider],
      destinations: [webhookDriver],
      connections: [
        {
          connection: {
            id: "con_test",
            provider: "mock-source",
            displayName: "test",
            externalAccountId: "acct_x",
          },
          selectedSources: [
            {
              id: "src_a",
              externalId: "thing",
              displayName: "thing",
              sourceKind: "mock",
              metadata: null,
            },
          ],
        },
      ],
      monitors: [
        {
          monitor: {
            id: "mon_x",
            connectionId: null,
            displayName: "errors",
            filterSteps: [{ kind: "errors" }],
            enabled: true,
          },
          sinks: [
            {
              sink: { id: "snk_w", filterSteps: [] },
              destination: { id: "dst_w", kind: "webhook", displayName: "wb" },
              destinationConfig: { url: "https://example.com/hook" },
            },
          ],
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
