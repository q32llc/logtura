import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encryptSecret, newId } from "../../src/crypto";
import { mockFetch, seedUser } from "./_setup";

/** End-to-end bundle generation: seed a deep fixture (user →
 *  connection → sources → monitor with rollup → sink → slack
 *  destination → deployment), GET the bundle, assert it has the
 *  pieces the UI expects. Hits a large surface — `generator.ts`,
 *  every selected provider/destination driver, bundle assembly,
 *  manifest construction — so a regression in any of them lights up
 *  here. */

interface SeededDeployment {
  userId: string;
  sessionCookie: string;
  connectionId: string;
  deploymentId: string;
}

async function seedFullDeployment(): Promise<SeededDeployment> {
  const { userId, sessionCookie } = await seedUser();
  const now = Date.now();
  const connectionId = newId("con");
  const sourceA = newId("src");
  const sourceB = newId("src");
  const destinationId = newId("dst");
  const monitorId = newId("mon");
  const sinkId = newId("snk");
  const deploymentId = newId("dep");

  const credsCt = await encryptSecret(
    JSON.stringify({ apiToken: "cf_test_token" }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO connections
     (id, user_id, provider, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
     VALUES (?, ?, 'cloudflare', 'CF', 'acct_xyz', ?, ?, ?)`,
  )
    .bind(connectionId, userId, credsCt, now, now)
    .run();

  // Two workers — exercises the consolidated cf_worker_norm path
  // (per-kind normalize fans in N inputs, not N copies of identical
  // VRL). Without two sources we wouldn't see the consolidation.
  for (const [id, externalId] of [
    [sourceA, "worker-one"],
    [sourceB, "worker-two"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO log_sources
       (id, connection_id, source_kind, external_id, display_name, discovered_at)
       VALUES (?, ?, 'cf_worker', ?, ?, ?)`,
    )
      .bind(id, connectionId, externalId, externalId, now)
      .run();
  }

  // Slack destination — the encrypted config holds the webhook URL.
  // We never actually POST to it in this test (the bundle endpoint
  // doesn't send anything; it just renders config), so the URL just
  // needs to round-trip through encryption.
  const destCt = await encryptSecret(
    JSON.stringify({
      webhookUrl: "https://hooks.slack.com/services/T00/B00/XXX",
      teamName: "test-team",
      channel: "alerts",
    }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO destinations
     (id, user_id, kind, display_name, config_encrypted, created_at, updated_at)
     VALUES (?, ?, 'slack', 'alerts', ?, ?, ?)`,
  )
    .bind(destinationId, userId, destCt, now, now)
    .run();

  // Monitor: errors + rollup. The rollup_fmt VRL was the regression
  // surface we shipped twice — covering it via generated yaml here
  // means a future `string(int)` slip would fail before deploy.
  const filterSteps = [
    { kind: "errors" },
    { kind: "rollup", window_secs: 30, group_by: ["script"], max_samples: 5 },
  ];
  await env.DB.prepare(
    `INSERT INTO monitors
     (id, user_id, connection_id, display_name, filter_steps_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      monitorId,
      userId,
      connectionId,
      "errors-rollup",
      JSON.stringify(filterSteps),
      now,
      now,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO sinks
     (id, monitor_id, destination_id, filter_steps_json, created_at)
     VALUES (?, ?, ?, '[]', ?)`,
  )
    .bind(sinkId, monitorId, destinationId, now)
    .run();

  // Deployment row. source_selection_json = NULL exercises the
  // back-compat path: bundle assembly falls back to "all sources
  // from deployment.connection_id" when no explicit selection is
  // recorded. The connection set is then derived from those rows.
  await env.DB.prepare(
    `INSERT INTO deployments
     (id, user_id, connection_id, display_name, target_kind, managed,
      source_selection_json, monitor_selection_json,
      heartbeat_target, metrics_target, status,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', 0, NULL, NULL, 'none', 'none', 'pending', ?, ?)`,
  )
    .bind(deploymentId, userId, connectionId, "test-deploy", now, now)
    .run();

  return { userId, sessionCookie, connectionId, deploymentId };
}

describe("GET /api/deployments/:id/bundle", () => {
  it("assembles a valid bundle: vector.yaml + envVars + componentManifest", async () => {
    const seed = await seedFullDeployment();

    // bundle assembly runs Cloudflare's checkCredentialFreshness,
    // which calls /user/tokens/verify. Return a healthy "active"
    // status — that's the only Cloudflare call the bundle path makes
    // (discovery is a separate job).
    mockFetch("https://api.cloudflare.com", async () =>
      Response.json({
        success: true,
        result: { id: "tok_abc", status: "active" },
      }),
    );

    const res = await SELF.fetch(
      `http://localhost/api/deployments/${seed.deploymentId}/bundle`,
      { headers: { cookie: seed.sessionCookie } },
    );
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as {
      target: { id: string; displayName: string };
      files: Array<{ name: string; content: string }>;
      envVars: Array<{ name: string; value: string | null }>;
      selectedCount: number;
      monitorSummary: string;
      componentManifest: Array<{
        id: string;
        role: string;
        category: string;
        label: string;
      }>;
    };

    // Target hints — the Other driver was selected by deployment.target_kind.
    expect(bundle.target.id).toBe("other");
    expect(bundle.selectedCount).toBe(2);
    expect(bundle.monitorSummary).toMatch(/1 monitor.*1 sink/);

    // vector.yaml is in the file list and looks like vector config.
    const vectorYaml = bundle.files.find((f) => f.name === "vector.yaml");
    expect(vectorYaml).toBeDefined();
    expect(vectorYaml!.content).toContain("sources:");
    expect(vectorYaml!.content).toContain("transforms:");
    expect(vectorYaml!.content).toContain("sinks:");

    // The consolidated normalize transform — 50 workers should give
    // ONE cf_worker_norm with multiple inputs (we shipped this
    // refactor recently; the test pins it).
    expect(vectorYaml!.content).toContain("cf_worker_norm:");

    // The rollup_fmt VRL is what tripped E103 twice in prod. Make
    // sure it's actually being emitted and uses to_string (not
    // string) on the int → string conversions.
    expect(vectorYaml!.content).toContain("rollup_fmt");
    expect(vectorYaml!.content).toContain("to_string(n)");

    // EnvVars include the Cloudflare API token + account id at
    // minimum. The token value is auto-populated from the stored
    // connection cred.
    const tokenEnv = bundle.envVars.find((v) => v.name === "CLOUDFLARE_API_TOKEN");
    expect(tokenEnv?.value).toBe("cf_test_token");

    // Component manifest: two primary sources, one primary sink,
    // some plumbing rows. UI groups by category/role; this pins the
    // shape future tests + the metrics card depend on.
    const sources = bundle.componentManifest.filter((c) => c.role === "source");
    expect(sources.length).toBe(2);
    expect(sources.every((s) => s.category === "primary")).toBe(true);
    const sinks = bundle.componentManifest.filter((c) => c.role === "sink");
    expect(sinks.length).toBe(1);
    expect(sinks[0]!.label).toMatch(/Slack.*alerts/);
    expect(
      bundle.componentManifest.some((c) => c.role === "normalize"),
    ).toBe(true);
  });

  it("returns 404 for a deployment that doesn't exist", async () => {
    const { sessionCookie } = await seedUser();
    const res = await SELF.fetch(
      "http://localhost/api/deployments/dep_nope/bundle",
      { headers: { cookie: sessionCookie } },
    );
    expect(res.status).toBe(404);
  });
});
