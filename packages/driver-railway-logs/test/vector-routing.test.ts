/** Execute generated transforms with pinned Vector; provider traffic is fixture data. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { railwayLogsDriver } from "../src/index";

const dockerAvailable = spawnSync("docker", ["--version"], { encoding: "utf8" }).status === 0;
if (process.env.LOGT_REQUIRE_DOCKER === "1" && !dockerAvailable) throw new Error("Docker is required for Railway routing validation");
describe.skipIf(!dockerAvailable)("actual Vector Railway environment routing", () => {
  it("keeps production/staging isolated, rejects unselected services and normalizes provider errors", () => {
    const pipe = railwayLogsDriver.generatePipeline({ connection: { id: "con", externalAccountId: null, displayName: "Railway" }, selection: { kind: "list", sources: [
      { id: "production", sourceKind: "railway_service", externalId: "production:api", displayName: "Shop/Production/API", metadata: { environment_id: "production", service_id: "api" } },
      { id: "staging", sourceKind: "railway_service", externalId: "staging:api", displayName: "Shop/Staging/API", metadata: { environment_id: "staging", service_id: "api" } },
    ] } });
    const normalize = "railway_con_norm", production = "railway_con_production", staging = "railway_con_staging";
    const tests = [
      { name: "production only", inputs: [{ insert_at: normalize, type: "log", log_fields: { environmentId: "production", serviceId: "api", serviceName: "API", message: "production event", severity: "info" } }], no_outputs_from: [staging], outputs: [{ extract_from: production, conditions: [{ type: "vrl", source: 'assert_eq!(.message, "[API] production event")\nassert_eq!(.error, false)\nassert!(!exists(.exceptions))' }] }] },
      { name: "staging error only", inputs: [{ insert_at: normalize, type: "log", log_fields: { environmentId: "staging", serviceId: "api", message: "failure\nstack line", severity: "error" } }], no_outputs_from: [production], outputs: [{ extract_from: staging, conditions: [{ type: "vrl", source: 'assert_eq!(.message, "[api] failure\\nstack line")\nassert_eq!(.error, true)\nassert_eq!(.error_reason, "railway_log")\nassert_eq!(.exceptions[0].message, "failure")' }] }] },
      { name: "unselected service", inputs: [{ insert_at: normalize, type: "log", log_fields: { environmentId: "production", serviceId: "worker", message: "drop", severity: "info" } }], no_outputs_from: [production, staging] },
      { name: "missing environment", inputs: [{ insert_at: normalize, type: "log", log_fields: { serviceId: "api", message: "drop", severity: "info" } }], no_outputs_from: [production, staging] },
      { name: "warning attributes", inputs: [{ insert_at: normalize, type: "log", log_fields: { environmentId: "production", serviceId: "api", message: "", attrs: { level: "warning", event: "attribute event" }, exceptions: [{ message: "obsolete" }], error_reason: "obsolete" } }], no_outputs_from: [staging], outputs: [{ extract_from: production, conditions: [{ type: "vrl", source: 'assert_eq!(.level, "warn")\nassert_eq!(.message, "[api] attribute event")\nassert_eq!(.error, false)\nassert!(!exists(.exceptions))\nassert!(!exists(.error_reason))' }] }] },
    ];
    const sources = pipe.components.filter(c => c.kind === "source"), transforms = pipe.components.filter(c => c.kind === "transform");
    const config = ["sources:", ...sources.map(c => `  ${c.key}:\n${c.yaml}`), "transforms:", ...transforms.map(c => `  ${c.key}:\n${c.yaml}`), "sinks:", "  discard:", "    type: blackhole", `    inputs: [${JSON.stringify(pipe.outputKey)}]`, `tests: ${JSON.stringify(tests)}`].join("\n");
    const directory = mkdtempSync(join(tmpdir(), "logt-railway-vector-"));
    try {
      writeFileSync(join(directory, "vector.yaml"), config);
      const result = spawnSync("docker", ["run", "--rm", "--volume", `${directory}:/fixture:ro`, "--entrypoint", "/usr/bin/vector", "timberio/vector:0.55.0-debian", "test", "/fixture/vector.yaml"], { encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain("production only");
      expect(result.stdout + result.stderr).toContain("staging error only");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 40_000);
});
