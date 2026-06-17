import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encryptSecret, newId } from "../../src/crypto";
import { seedUser } from "./_setup";

async function seedIngestDeployment(): Promise<{
  deploymentId: string;
  token: string;
}> {
  const { userId } = await seedUser();
  const now = Date.now();
  const connectionId = newId("con");
  const deploymentId = newId("dep");
  const token = `tok_${deploymentId}`;
  const credsCt = await encryptSecret(
    JSON.stringify({ apiToken: "cf_test_token" }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO connections
     (id, user_id, provider, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
     VALUES (?, ?, 'cloudflare-worker-tail', 'CF', 'acct_xyz', ?, ?, ?)`,
  )
    .bind(connectionId, userId, credsCt, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO deployments
     (id, user_id, connection_id, display_name, target_kind, managed,
      heartbeat_target, heartbeat_token, metrics_target, status,
      created_at, updated_at)
     VALUES (?, ?, ?, 'test-deploy', 'other', 0, 'logtura', ?, 'logtura', 'running', ?, ?)`,
  )
    .bind(deploymentId, userId, connectionId, token, now, now)
    .run();
  return { deploymentId, token };
}

function metricBody(value: number, timestamp: string): string {
  return JSON.stringify([
    {
      name: "component_sent_events_total",
      namespace: "vector",
      timestamp,
      tags: {
        component_id: "sink_slack",
        component_kind: "sink",
        component_type: "http",
      },
      counter: { value },
    },
  ]);
}

describe("deployment ingest cache", () => {
  it("coalesces non-material metrics updates in isolate memory", async () => {
    const { deploymentId, token } = await seedIngestDeployment();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const first = await SELF.fetch(
      `http://localhost/api/metrics/${deploymentId}`,
      {
        method: "POST",
        headers,
        body: metricBody(1, "2026-06-01T00:00:00.000Z"),
      },
    );
    expect(first.status).toBe(204);

    const persistedFirst = await env.DB.prepare(
      "SELECT metrics_snapshot_json FROM deployments WHERE id = ?",
    )
      .bind(deploymentId)
      .first<{ metrics_snapshot_json: string | null }>();
    const firstSnap = JSON.parse(
      persistedFirst!.metrics_snapshot_json!,
    ) as { totals: { sent: number } };
    expect(firstSnap.totals.sent).toBe(1);

    const second = await SELF.fetch(
      `http://localhost/api/metrics/${deploymentId}`,
      {
        method: "POST",
        headers,
        body: metricBody(2, "2026-06-01T00:00:30.000Z"),
      },
    );
    expect(second.status).toBe(204);

    const persistedSecond = await env.DB.prepare(
      "SELECT metrics_snapshot_json FROM deployments WHERE id = ?",
    )
      .bind(deploymentId)
      .first<{ metrics_snapshot_json: string | null }>();
    const secondSnap = JSON.parse(
      persistedSecond!.metrics_snapshot_json!,
    ) as { totals: { sent: number } };
    expect(secondSnap.totals.sent).toBe(1);
  });

  it("still persists error counter increases immediately", async () => {
    const { deploymentId, token } = await seedIngestDeployment();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    await SELF.fetch(`http://localhost/api/metrics/${deploymentId}`, {
      method: "POST",
      headers,
      body: metricBody(1, "2026-06-01T00:00:00.000Z"),
    });
    const errorRes = await SELF.fetch(
      `http://localhost/api/metrics/${deploymentId}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify([
          {
            name: "component_errors_total",
            namespace: "vector",
            timestamp: "2026-06-01T00:00:30.000Z",
            tags: {
              component_id: "sink_slack",
              component_kind: "sink",
              component_type: "http",
              error_type: "request_failed",
            },
            counter: { value: 1 },
          },
        ]),
      },
    );
    expect(errorRes.status).toBe(204);

    const persisted = await env.DB.prepare(
      "SELECT metrics_snapshot_json FROM deployments WHERE id = ?",
    )
      .bind(deploymentId)
      .first<{ metrics_snapshot_json: string | null }>();
    const snap = JSON.parse(
      persisted!.metrics_snapshot_json!,
    ) as { totals: { errors: number } };
    expect(snap.totals.errors).toBe(1);
  });
});
