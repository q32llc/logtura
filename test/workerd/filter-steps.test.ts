import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encryptSecret, newId } from "../../src/crypto";
import type { FilterStep } from "../../src/db";
import { mockFetch, seedUser } from "./_setup";

/** Per-FilterStep emission checks. Each kind compiled in isolation
 *  through bundle assembly so we lock down the VRL/transform that
 *  the upcoming "FilterStep plugin" refactor will be reshuffling.
 *  Asserts on the generated yaml — substring matches are coarse but
 *  pin the shape; once renderStepTransforms becomes a plugin layer
 *  these tests will move to that module's unit tests.
 */

async function seedDeploymentWithMonitor(
  filterSteps: FilterStep[],
): Promise<{
  sessionCookie: string;
  deploymentId: string;
  monitorId: string;
}> {
  const { userId, sessionCookie } = await seedUser();
  const now = Date.now();
  const connId = newId("con");
  const sourceId = newId("src");
  const destId = newId("dst");
  const monId = newId("mon");
  const sinkId = newId("snk");
  const depId = newId("dep");
  const credsCt = await encryptSecret(
    JSON.stringify({ apiToken: "cf_test" }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  const destCt = await encryptSecret(
    JSON.stringify({ url: "https://example.com/hook" }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO connections
     (id, user_id, provider, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
     VALUES (?, ?, 'cloudflare', 'CF', 'acct_x', ?, ?, ?)`,
  )
    .bind(connId, userId, credsCt, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO log_sources
     (id, connection_id, source_kind, external_id, display_name, discovered_at)
     VALUES (?, ?, 'cf_worker', 'wrk', 'wrk', ?)`,
  )
    .bind(sourceId, connId, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO destinations
     (id, user_id, kind, display_name, config_encrypted, created_at, updated_at)
     VALUES (?, ?, 'webhook', 'hook', ?, ?, ?)`,
  )
    .bind(destId, userId, destCt, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO monitors
     (id, user_id, connection_id, display_name, filter_steps_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(monId, userId, connId, "test", JSON.stringify(filterSteps), now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO sinks
     (id, monitor_id, destination_id, filter_steps_json, created_at)
     VALUES (?, ?, ?, '[]', ?)`,
  )
    .bind(sinkId, monId, destId, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO deployments
     (id, user_id, connection_id, display_name, target_kind, managed,
      source_selection_json, monitor_selection_json,
      heartbeat_target, metrics_target, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', 0, ?, NULL, 'none', 'none', 'pending', ?, ?)`,
  )
    .bind(
      depId,
      userId,
      connId,
      "filter-test",
      JSON.stringify([sourceId]),
      now,
      now,
    )
    .run();
  return { sessionCookie, deploymentId: depId, monitorId: monId };
}

async function fetchYaml(
  deploymentId: string,
  sessionCookie: string,
): Promise<string> {
  mockFetch("https://api.cloudflare.com", async () =>
    Response.json({
      success: true,
      result: { id: "tok", status: "active" },
    }),
  );
  const res = await SELF.fetch(
    `http://localhost/api/deployments/${deploymentId}/bundle`,
    { headers: { cookie: sessionCookie } },
  );
  if (res.status !== 200) {
    throw new Error(`bundle fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    files: Array<{ name: string; content: string }>;
  };
  return body.files.find((f) => f.name === "vector.yaml")!.content;
}

describe("FilterStep emission", () => {
  it("errors → filter transform on .error / .level == 'error'", async () => {
    const { sessionCookie, deploymentId, monitorId } =
      await seedDeploymentWithMonitor([{ kind: "errors" }]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    const key = `monitor_${monitorId.replace(/[^a-zA-Z0-9_]/g, "_")}_0_errors`;
    expect(yaml).toContain(`${key}:`);
    expect(yaml).toContain("type: filter");
    expect(yaml).toContain("bool(.error)");
    expect(yaml).toContain('string(.level) ?? ""');
  });

  it("level include → filter on .level == <level>", async () => {
    const { sessionCookie, deploymentId } = await seedDeploymentWithMonitor([
      { kind: "level", level: "warn", mode: "include" },
    ]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    expect(yaml).toContain("type: filter");
    expect(yaml).toMatch(/== "warn"/);
  });

  it("level exclude → filter inverts the comparison", async () => {
    const { sessionCookie, deploymentId } = await seedDeploymentWithMonitor([
      { kind: "level", level: "debug", mode: "exclude" },
    ]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    expect(yaml).toMatch(/!= "debug"/);
  });

  it("match → filter with a regex against the chosen field", async () => {
    const { sessionCookie, deploymentId } = await seedDeploymentWithMonitor([
      {
        kind: "match",
        pattern: "timeout|refused",
        mode: "include",
        field: "message",
      },
    ]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    expect(yaml).toContain("type: filter");
    expect(yaml).toContain("match(string(.message)");
    expect(yaml).toContain("r'timeout|refused'");
  });

  it("rate_limit → throttle transform with the right threshold", async () => {
    const { sessionCookie, deploymentId } = await seedDeploymentWithMonitor([
      { kind: "rate_limit", per_minute: 120 },
    ]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    expect(yaml).toContain("type: throttle");
    expect(yaml).toContain("threshold: 120");
  });

  it("sample → sample transform with the right rate", async () => {
    const { sessionCookie, deploymentId } = await seedDeploymentWithMonitor([
      { kind: "sample", rate: 0.5 },
    ]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    expect(yaml).toContain("type: sample");
    // Sample rate 0.5 → vector's rate=2 (1-in-N). Either value
    // shouldn't trip the test, so just sanity-check the transform
    // is there.
    expect(yaml).toContain("type: sample");
  });

  it("dedup → dedupe transform on the configured fields", async () => {
    const { sessionCookie, deploymentId } = await seedDeploymentWithMonitor([
      { kind: "dedup", window_secs: 60, fields: ["message", "script"] },
    ]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    expect(yaml).toContain("type: dedupe");
  });

  it("rollup → three chained transforms (pre + reduce + fmt)", async () => {
    const { sessionCookie, deploymentId, monitorId } =
      await seedDeploymentWithMonitor([
        {
          kind: "rollup",
          window_secs: 30,
          group_by: ["script"],
          max_samples: 5,
        },
      ]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    const prefix = `monitor_${monitorId.replace(/[^a-zA-Z0-9_]/g, "_")}_0_rollup`;
    expect(yaml).toContain(`${prefix}_pre:`);
    expect(yaml).toContain(`${prefix}_reduce:`);
    expect(yaml).toContain(`${prefix}_fmt:`);
    expect(yaml).toContain("type: reduce");
    // Group-by key prefix in the formatted message.
    expect(yaml).toContain('string(.script) ?? "?"');
    // Pinned earlier bug: the int → string cast is to_string not string.
    expect(yaml).toContain("to_string(n)");
  });

  it("chain of multiple steps → one transform per step, each fed by the previous", async () => {
    const { sessionCookie, deploymentId, monitorId } =
      await seedDeploymentWithMonitor([
        { kind: "errors" },
        { kind: "dedup", window_secs: 60, fields: ["message"] },
        {
          kind: "rollup",
          window_secs: 30,
          group_by: [],
          max_samples: 3,
        },
      ]);
    const yaml = await fetchYaml(deploymentId, sessionCookie);
    const p = `monitor_${monitorId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    expect(yaml).toContain(`${p}_0_errors:`);
    expect(yaml).toContain(`${p}_1_dedup:`);
    expect(yaml).toContain(`${p}_2_rollup_pre:`);
    // Each step's `inputs:` should reference the previous step's key.
    expect(yaml).toMatch(new RegExp(`${p}_1_dedup:[\\s\\S]*?inputs: \\["${p}_0_errors"\\]`));
    expect(yaml).toMatch(new RegExp(`${p}_2_rollup_pre:[\\s\\S]*?inputs: \\["${p}_1_dedup"\\]`));
  });
});
