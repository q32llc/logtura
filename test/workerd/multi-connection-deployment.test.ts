import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encryptSecret, newId } from "../../src/crypto";
import { mockFetch, seedUser } from "./_setup";

/** Multi-connection deployments in the source-driven model. A
 *  deployment IS a set of source IDs; connections are derived from
 *  which connections own those sources. No join table, no
 *  primary-vs-additional split — pick sources from multiple
 *  connections and the bundle stitches them together. */

interface ConnSeed {
  connectionId: string;
}

async function seedConnection(
  userId: string,
  provider: "cloudflare-worker-tail" | "fly-log-tail",
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

describe("multi-connection deployments (source-derived)", () => {
  it("derives both connections from a sourceIds array spanning two providers", async () => {
    const { userId, sessionCookie } = await seedUser();
    const cf = await seedConnection(userId, "cloudflare-worker-tail", "acct_xyz", "cf_tok");
    const fly = await seedConnection(userId, "fly-log-tail", "personal", "fly_tok");
    const now = Date.now();

    // One CF worker + one Fly app. Each lives under its own
    // connection; the deployment's source_selection_json lists
    // both ids, which is the entirety of the wiring.
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

    // Deployment seeded with sourceIds spanning both providers.
    // No deployment_connections row needed — bundle assembly
    // computes the connection set from sources.
    const deploymentId = newId("dep");
    await env.DB.prepare(
      `INSERT INTO deployments
       (id, user_id, connection_id, display_name, target_kind, managed,
        source_selection_json, monitor_selection_json,
        heartbeat_target, metrics_target, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'other', 0, ?, NULL, 'none', 'none', 'pending', ?, ?)`,
    )
      .bind(
        deploymentId,
        userId,
        cf.connectionId, // anchor — used for app name + back-compat
        "multi-test",
        JSON.stringify([cfSourceId, flySourceId]),
        now,
        now,
      )
      .run();

    // Bundle assembly's freshness check hits each provider:
    // /user/tokens/verify (CF) and /graphql organizations (Fly).
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

    expect(bundle.selectedCount).toBe(2);
    const yaml = bundle.files.find((f) => f.name === "vector.yaml")!.content;
    expect(yaml).toContain("cf_worker_my_worker");
    expect(yaml).toContain("fly_app_my_app");
    expect(yaml).toContain("cf_worker_norm:");
    expect(yaml).toContain("fly_app_norm:");
    // Per-connection tag transforms exist for each derived
    // connection; tag_received fans them together.
    expect(yaml).toMatch(/tag_conn_con_[A-Za-z0-9_-]+:/g);
    expect(yaml).toContain("tag_received:");

    // Both providers' env vars are present and populated.
    const names = bundle.envVars.map((v) => v.name);
    expect(names).toContain("CLOUDFLARE_API_TOKEN");
    expect(names).toContain("FLY_API_TOKEN");
    expect(
      bundle.envVars.find((v) => v.name === "CLOUDFLARE_API_TOKEN")?.value,
    ).toBe("cf_tok");
    expect(bundle.envVars.find((v) => v.name === "FLY_API_TOKEN")?.value).toBe(
      "fly_tok",
    );

    const sources = bundle.componentManifest.filter((c) => c.role === "source");
    expect(sources.length).toBe(2);
    expect(sources.some((s) => s.label.startsWith("Worker"))).toBe(true);
    expect(sources.some((s) => s.label.startsWith("App"))).toBe(true);
  });

  it("GET /deployments/:id exposes derived connections matching the selected sources", async () => {
    const { userId, sessionCookie } = await seedUser();
    const cf = await seedConnection(userId, "cloudflare-worker-tail", "acct_x", "cf_tok");
    const fly = await seedConnection(userId, "fly-log-tail", "personal", "fly_tok");
    const now = Date.now();
    const cfSrc = newId("src");
    const flySrc = newId("src");
    await env.DB.prepare(
      `INSERT INTO log_sources
       (id, connection_id, source_kind, external_id, display_name, discovered_at)
       VALUES (?, ?, 'cf_worker', 'w', 'w', ?), (?, ?, 'fly_app', 'a', 'a', ?)`,
    )
      .bind(cfSrc, cf.connectionId, now, flySrc, fly.connectionId, now)
      .run();
    const depId = newId("dep");
    await env.DB.prepare(
      `INSERT INTO deployments
       (id, user_id, connection_id, display_name, target_kind, managed,
        source_selection_json, heartbeat_target, metrics_target, status,
        created_at, updated_at)
       VALUES (?, ?, ?, 'derived-conns', 'other', 0, ?, 'none', 'none', 'pending', ?, ?)`,
    )
      .bind(
        depId,
        userId,
        cf.connectionId,
        JSON.stringify([cfSrc, flySrc]),
        now,
        now,
      )
      .run();

    const res = await SELF.fetch(`http://localhost/api/deployments/${depId}`, {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      connections: Array<{ id: string; provider: string }>;
    };
    expect(json.connections.map((c) => c.provider).sort()).toEqual([
      "cloudflare-worker-tail",
      "fly-log-tail",
    ]);
  });

  it("bundle assembly fails when selected sources span two connections of the same provider", async () => {
    const { userId, sessionCookie } = await seedUser();
    const cf1 = await seedConnection(userId, "cloudflare-worker-tail", "acct_a", "tok_a");
    const cf2 = await seedConnection(userId, "cloudflare-worker-tail", "acct_b", "tok_b");
    const now = Date.now();
    const s1 = newId("src");
    const s2 = newId("src");
    await env.DB.prepare(
      `INSERT INTO log_sources
       (id, connection_id, source_kind, external_id, display_name, discovered_at)
       VALUES (?, ?, 'cf_worker', 'w1', 'w1', ?), (?, ?, 'cf_worker', 'w2', 'w2', ?)`,
    )
      .bind(s1, cf1.connectionId, now, s2, cf2.connectionId, now)
      .run();
    const depId = newId("dep");
    await env.DB.prepare(
      `INSERT INTO deployments
       (id, user_id, connection_id, display_name, target_kind, managed,
        source_selection_json, heartbeat_target, metrics_target, status,
        created_at, updated_at)
       VALUES (?, ?, ?, 'dup-test', 'other', 0, ?, 'none', 'none', 'pending', ?, ?)`,
    )
      .bind(
        depId,
        userId,
        cf1.connectionId,
        JSON.stringify([s1, s2]),
        now,
        now,
      )
      .run();

    // Freshness check still runs first. Mock CF /verify but expect
    // the bundle endpoint to throw at the same-provider check
    // before getting to source-block generation.
    mockFetch("https://api.cloudflare.com", async () =>
      Response.json({
        success: true,
        result: { id: "tok_abc", status: "active" },
      }),
    );
    const res = await SELF.fetch(
      `http://localhost/api/deployments/${depId}/bundle`,
      { headers: { cookie: sessionCookie } },
    );
    // Route translates the same-provider error to a 400 with a
    // structured body so the picker UI can show the user which
    // provider to narrow.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("duplicate_provider_sources");
    expect(body.message).toMatch(/cloudflare/i);

    // Now narrow the selection to a single CF connection's source
    // and re-fetch — the same deployment row now produces a clean
    // bundle. This proves the failure mode is specifically the
    // cross-conn duplicate-provider rule, not some other accident.
    await env.DB.prepare(
      "UPDATE deployments SET source_selection_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify([s1]), depId)
      .run();
    const okRes = await SELF.fetch(
      `http://localhost/api/deployments/${depId}/bundle`,
      { headers: { cookie: sessionCookie } },
    );
    expect(okRes.status).toBe(200);
    const okBundle = (await okRes.json()) as { selectedCount: number };
    expect(okBundle.selectedCount).toBe(1);
  });
});
