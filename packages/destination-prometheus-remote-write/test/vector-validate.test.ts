/** Black-box `vector validate` for the prometheus_remote_write
 *  destination. Both auth shapes (open + bearer) are exercised. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBundle } from "@logtura/core";
import { describe, expect, it } from "vitest";
import { prometheusRemoteWriteDriver } from "../src/index";
import { mockProvider } from "./_mock-provider";

const VECTOR_IMAGE = "timberio/vector:latest-debian";

const dockerAvailable = (() => {
  const r = spawnSync("docker", ["--version"], { encoding: "utf8" });
  return r.status === 0;
})();

function vectorValidate(yaml: string, envNames: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "logtura-vec-prom-"));
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

function bundleWith(destinationConfig: {
  endpoint: string;
  bearerToken: string | null;
}) {
  return generateBundle({
    providers: [mockProvider],
    destinations: [prometheusRemoteWriteDriver],
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
    monitors: [],
    metrics: {
      kind: "destination",
      destination: {
        id: "dst_prom",
        kind: "prometheus_remote_write",
        displayName: "prom",
      },
      destinationConfig,
    },
  });
}

describe.skipIf(!dockerAvailable)(
  "vector validate — prometheus_remote_write destination",
  () => {
    it("open endpoint (no bearer)", () => {
      const bundle = bundleWith({
        endpoint: "https://prom.example.com/api/v1/write",
        bearerToken: null,
      });
      const { status, output } = vectorValidate(
        bundle.vectorYaml,
        bundle.envVars.map((v) => v.name),
      );
      expect(status, output).toBe(0);
    });

    it("bearer auth + token env declared", () => {
      const bundle = bundleWith({
        endpoint: "https://prom.example.com/api/v1/write",
        bearerToken: "tok_abc",
      });
      const envs = bundle.envVars.map((v) => v.name);
      expect(envs.some((n) => n.endsWith("_TOKEN"))).toBe(true);
      const { status, output } = vectorValidate(bundle.vectorYaml, envs);
      expect(status, output).toBe(0);
    });
  },
);
