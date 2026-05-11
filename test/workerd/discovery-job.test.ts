import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { JobDriver } from "../../src/jobs/driver";
import { runDiscovery } from "../../src/jobs/handlers/discovery";
import type { JobHandlerCtx } from "../../src/jobs/queue";
import type { JobRecord } from "../../src/jobs/types";
import { encryptSecret, newId } from "../../src/crypto";
import { mockFetch, seedUser } from "./_setup";

/** Discovery job: claims, calls provider.discoverSources, upserts
 *  rows, marks the connection discovered. Pins the contract the
 *  upcoming driver-rename will be reshuffling. */

async function seedConnection(
  userId: string,
  externalAccountId: string,
): Promise<string> {
  const id = newId("con");
  const now = Date.now();
  const ct = await encryptSecret(
    JSON.stringify({ apiToken: "cf_test_token" }),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO connections
     (id, user_id, provider, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
     VALUES (?, ?, 'cloudflare-worker-tail', 'CF', ?, ?, ?, ?)`,
  )
    .bind(id, userId, externalAccountId, ct, now, now)
    .run();
  return id;
}

/** Minimal stand-in for the queue's JobHandlerCtx. Discovery only
 *  uses ctx.env + ctx.job; the rest are no-ops we provide so the
 *  type checks. If the handler grows new ctx dependencies later,
 *  this stub will fail loudly which is the cheap-but-correct check. */
function makeCtx(env_: typeof env, job: JobRecord): JobHandlerCtx {
  return {
    env: env_ as unknown as JobHandlerCtx["env"],
    driver: new JobDriver(env_.DB, env_.JOBS_QUEUE as unknown as Queue),
    job,
    signal: new AbortController().signal,
    enqueueSibling: async () => {
      throw new Error("test ctx: enqueueSibling not implemented");
    },
    events: { record: async () => {} },
    progress: async () => {},
  };
}

describe("runDiscovery (cloudflare-worker-tail)", () => {
  it("upserts discovered workers + ai gateways and marks the connection", async () => {
    const { userId } = await seedUser();
    const connId = await seedConnection(userId, "acct_xyz");

    // Cloudflare's discoverSources hits:
    //   /accounts/<id>/workers/scripts
    //   /accounts/<id>/ai-gateway/gateways
    // cloudflare-worker-tail is now a single-transport driver — it
    // ONLY discovers workers. AI Gateway is a separate driver with
    // its own discovery path.
    mockFetch("https://api.cloudflare.com", async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/client/v4/accounts/acct_xyz/workers/scripts") {
        return Response.json({
          success: true,
          result: [
            { id: "worker-a", modified_on: "2026-01-01T00:00:00Z" },
            { id: "worker-b", modified_on: "2026-01-02T00:00:00Z" },
          ],
        });
      }
      throw new Error(`unexpected CF path: ${url.pathname}`);
    });

    // Synthesize a queued discovery job row + record. We don't need
    // the queue to claim it for us — the handler is pure given a
    // ctx, and this is what we want to test.
    const job: JobRecord = {
      id: newId("job"),
      userId,
      kind: "discovery",
      status: "running",
      parentJobId: null,
      attemptId: null,
      payload: { connectionId: connId } as Record<string, unknown>,
      result: null,
      lastError: null,
      uxProgress: null,
      lockKey: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
      lastHeartbeatAt: Date.now(),
      availableAt: null,
      attempts: 1,
    };

    const result = (await runDiscovery(makeCtx(env, job))) as {
      sourceCount: number;
    };
    expect(result.sourceCount).toBe(2);

    // log_sources rows: 2 cf_worker. AI Gateway lives in a separate
    // driver/connection now.
    const sources = await env.DB.prepare(
      "SELECT source_kind, external_id FROM log_sources WHERE connection_id = ? ORDER BY external_id",
    )
      .bind(connId)
      .all<{ source_kind: string; external_id: string }>();
    expect(sources.results).toEqual([
      { source_kind: "cf_worker", external_id: "worker-a" },
      { source_kind: "cf_worker", external_id: "worker-b" },
    ]);

    const conn = await env.DB.prepare(
      "SELECT last_discovered_at FROM connections WHERE id = ?",
    )
      .bind(connId)
      .first<{ last_discovered_at: number | null }>();
    expect(conn?.last_discovered_at).toBeGreaterThan(0);
  });

  it("dedups on re-run: same externalId stays one row", async () => {
    const { userId } = await seedUser();
    const connId = await seedConnection(userId, "acct_xyz");

    mockFetch("https://api.cloudflare.com", async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/client/v4/accounts/acct_xyz/workers/scripts") {
        return Response.json({
          success: true,
          result: [{ id: "worker-a", modified_on: null }],
        });
      }
      throw new Error(`unexpected: ${url.pathname}`);
    });

    const baseJob: JobRecord = {
      id: "j1",
      userId,
      kind: "discovery",
      status: "running",
      parentJobId: null,
      attemptId: null,
      payload: { connectionId: connId } as Record<string, unknown>,
      result: null,
      lastError: null,
      uxProgress: null,
      lockKey: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
      lastHeartbeatAt: Date.now(),
      availableAt: null,
      attempts: 1,
    };

    await runDiscovery(makeCtx(env, baseJob));
    await runDiscovery(makeCtx(env, { ...baseJob, id: "j2" }));

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM log_sources WHERE connection_id = ?",
    )
      .bind(connId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("fails loudly when the provider's API rejects the token", async () => {
    const { userId } = await seedUser();
    const connId = await seedConnection(userId, "acct_xyz");

    mockFetch("https://api.cloudflare.com", async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "token expired" }],
        },
        { status: 401 },
      ),
    );

    const job: JobRecord = {
      id: "jx",
      userId,
      kind: "discovery",
      status: "running",
      parentJobId: null,
      attemptId: null,
      payload: { connectionId: connId } as Record<string, unknown>,
      result: null,
      lastError: null,
      uxProgress: null,
      lockKey: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
      lastHeartbeatAt: Date.now(),
      availableAt: null,
      attempts: 1,
    };

    await expect(runDiscovery(makeCtx(env, job))).rejects.toThrow(
      /Cloudflare worker tail/,
    );
  });
});
