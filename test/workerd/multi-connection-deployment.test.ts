import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encryptSecret, newId } from "../../src/crypto";
import { mockFetch, seedUser } from "./_setup";

/** End-to-end coverage for multi-connection deployments: a single
 *  forwarder tailing both Cloudflare workers and Fly apps in one
 *  Vector config. Asserts that bundle assembly visits every joined
 *  connection (sources + creds + per-conn tag transforms) and that
 *  the one-per-provider constraint is enforced at the route. */

interface ConnSeed {
  connectionId: string;
}

async function seedConnection(
  userId: string,
  provider: "cloudflare" | "fly",
  externalAccountId: string,
  apiToken: string,
): Promise<ConnSeed> {
  const connectionId = newId("con");
  const now = Date.now();
  const ct = await encryptSecret(
    JSON.stringify({ apiToken }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO connections
     (id, user_id, provider, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      connectionId,
      userId,
      provider,
      `${provider} test`,
      externalAccountId,
      ct,
      now,
      now,
    )
    .run();
  return { connectionId };
}

describe("multi-connection deployments", () => {
  it("PUT /deployments/:id/connections accepts a second-provider connection and produces a merged bundle", async () => {
    const { userId, sessionCookie } = await seedUser();
    const cf = await seedConnection(userId, "cloudflare", "acct_xyz", "cf_tok");
    const fly = await seedConnection(userId, "fly", "personal", "fly_tok");
    const now = Date.now();

    // One worker on CF, one app on Fly. Each connection contributes
    // its own source(s) to the unified config.
    const cfSourceId = newId("src");
    const flySourceId = newId("src");
    await env.DB.prepare(
      `INSERT INTO log_sources
       (id, connection_id, source_kind, external_id, display_name, discovered_at)
       VALUES (?, ?, 'cf_worker', 'my-worker', 'my-worker', ?)`,
    )
      .bind(cfSourceId, cf.connectionId, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO log_sources
       (id, connection_id, source_kind, external_id, display_name, discovered_at)
       VALUES (?, ?, 'fly_app', 'my-app', 'my-app', ?)`,
    )
      .bind(flySourceId, fly.connectionId, now)
      .run();

    // Deployment + primary connection join row. CF is the primary;
    // Fly gets added via the PUT route below — same mechanic the UI
    // uses when you add a second connection from the Configure tab.
    const deploymentId = newId("dep");
    await env.DB.prepare(
      `INSERT INTO deployments
       (id, user_id, connection_id, display_name, target_kind, managed,
        heartbeat_target, metrics_target, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'other', 0, 'none', 'none', 'pending', ?, ?)`,
    )
      .bind(deploymentId, userId, cf.connectionId, "multi-test", now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO deployment_connections (deployment_id, connection_id, added_at)
       VALUES (?, ?, ?)`,
    )
      .bind(deploymentId, cf.connectionId, now)
      .run();

    // Route → add fly as a second connection.
    const putRes = await SELF.fetch(
      `http://localhost/api/deployments/${deploymentId}/connections`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: sessionCookie },
        body: JSON.stringify({
          connectionIds: [cf.connectionId, fly.connectionId],
        }),
      },
    );
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as {
      connections: Array<{ provider: string }>;
    };
    expect(putJson.connections.map((c) => c.provider).sort()).toEqual([
      "cloudflare",
      "fly",
    ]);

    // Bundle assembly's freshness check hits each provider:
    // /user/tokens/verify (CF) and /graphql organizations(...) (Fly).
    mockFetch("https://api.cloudflare.com", async () =>
      Response.json({
        success: true,
        result: { id: "tok_abc", status: "active" },
      }),
    );
    mockFetch("https://api.fly.io/graphql", async () =>
      Response.json({
        data: {
          organizations: {
            nodes: [{ id: "org_node_1", slug: "personal" }],
          },
        },
      }),
    );

    const bundleRes = await SELF.fetch(
      `http://localhost/api/deployments/${deploymentId}/bundle`,
      { headers: { cookie: sessionCookie } },
    );
    expect(bundleRes.status).toBe(200);
    const bundle = (await bundleRes.json()) as {
      files: Array<{ name: string; content: string }>;
      envVars: Array<{ name: string; value: string | null }>;
      componentManifest: Array<{
        id: string;
        role: string;
        label: string;
        links?: { connectionId?: string };
      }>;
      selectedCount: number;
    };

    // 2 sources total (1 per connection).
    expect(bundle.selectedCount).toBe(2);

    const yaml = bundle.files.find((f) => f.name === "vector.yaml")!.content;
    // Both provider-specific source blocks are present.
    expect(yaml).toContain("cf_worker_my_worker");
    expect(yaml).toContain("fly_app_my_app");
    // Both normalize transforms emitted (one per kind).
    expect(yaml).toContain("cf_worker_norm:");
    expect(yaml).toContain("fly_app_norm:");
    // Per-connection tag transforms — one per connection — both
    // exist and the unified tag_received fans them in.
    expect(yaml).toMatch(/tag_conn_con_[A-Za-z0-9_-]+:/g);
    expect(yaml).toContain("tag_received:");

    // Env vars from BOTH providers' runtimeSpec appear in the env
    // list — proves multi-connection accumulation is wired through.
    const names = bundle.envVars.map((v) => v.name);
    expect(names).toContain("CLOUDFLARE_API_TOKEN");
    expect(names).toContain("FLY_API_TOKEN");
    expect(
      bundle.envVars.find((v) => v.name === "CLOUDFLARE_API_TOKEN")?.value,
    ).toBe("cf_tok");
    expect(bundle.envVars.find((v) => v.name === "FLY_API_TOKEN")?.value).toBe(
      "fly_tok",
    );

    // Component manifest has primary sources for both providers.
    const sources = bundle.componentManifest.filter((c) => c.role === "source");
    expect(sources.length).toBe(2);
    expect(sources.some((s) => s.label.startsWith("Worker"))).toBe(true);
    expect(sources.some((s) => s.label.startsWith("App"))).toBe(true);
  });

  it("rejects adding a second connection of the same provider", async () => {
    const { userId, sessionCookie } = await seedUser();
    const cf1 = await seedConnection(userId, "cloudflare", "acct_a", "tok_a");
    const cf2 = await seedConnection(userId, "cloudflare", "acct_b", "tok_b");
    const now = Date.now();
    const deploymentId = newId("dep");
    await env.DB.prepare(
      `INSERT INTO deployments
       (id, user_id, connection_id, display_name, target_kind, managed,
        heartbeat_target, metrics_target, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'other', 0, 'none', 'none', 'pending', ?, ?)`,
    )
      .bind(deploymentId, userId, cf1.connectionId, "dup-test", now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO deployment_connections (deployment_id, connection_id, added_at)
       VALUES (?, ?, ?)`,
    )
      .bind(deploymentId, cf1.connectionId, now)
      .run();

    const res = await SELF.fetch(
      `http://localhost/api/deployments/${deploymentId}/connections`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: sessionCookie },
        body: JSON.stringify({
          connectionIds: [cf1.connectionId, cf2.connectionId],
        }),
      },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("duplicate_provider");
  });
});
