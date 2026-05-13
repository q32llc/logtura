import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mockFetch, seedUser } from "./_setup";

/**
 * Coarse happy-path coverage. These tests intentionally don't dig
 * deep into any one flow — they hit a wide surface so the cheap
 * lines (route registration, serializers, db SELECTs) get exercised
 * by *some* test. Future failures here usually mean a route was
 * wired wrong, not that the business logic broke; pair with
 * targeted unit tests when assertions need to get specific.
 */

describe("read endpoints — unauthenticated", () => {
  it("GET /api/me returns null when unauthenticated", async () => {
    const res = await SELF.fetch("http://localhost/api/me");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { user: unknown };
    expect(json.user).toBeNull();
  });

  it("GET /api/providers lists registered providers without auth", async () => {
    const res = await SELF.fetch("http://localhost/api/providers");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      providers: Array<{ id: string; displayName: string }>;
    };
    expect(json.providers.length).toBeGreaterThan(0);
    const ids = json.providers.map((p) => p.id);
    expect(ids).toContain("cloudflare-worker-tail");
  });
});

describe("read endpoints — authenticated, empty state", () => {
  it("returns empty lists for a freshly seeded user across every list endpoint", async () => {
    const { sessionCookie } = await seedUser();
    const headers = { cookie: sessionCookie };

    const meRes = await SELF.fetch("http://localhost/api/me", { headers });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as {
      user: { id: string; email: string };
    };
    expect(me.user.email).toBe("test@example.com");

    // Empty-state list endpoints. Each should respond 200 with an
    // empty array — proves the route is registered, auth is wired,
    // and the SQL doesn't throw on no-rows.
    const empties: Array<[string, string]> = [
      ["/api/connections", "connections"],
      ["/api/destinations", "destinations"],
      ["/api/deploy-targets", "deployTargets"],
      ["/api/deployments", "deployments"],
    ];
    for (const [path, key] of empties) {
      const r = await SELF.fetch(`http://localhost${path}`, { headers });
      expect(r.status, `${path} should 200`).toBe(200);
      const body = (await r.json()) as Record<string, unknown[]>;
      expect(body[key], `${path} body.${key} should be array`).toEqual([]);
    }

    // Driver-registry endpoints — static lists, just want a non-zero
    // response so the registrations actually run.
    const driverRes = await SELF.fetch(
      "http://localhost/api/destinations/drivers",
      { headers },
    );
    const drivers = (await driverRes.json()) as {
      drivers: Array<{ id: string }>;
    };
    expect(drivers.drivers.map((d) => d.id)).toContain("slack");

    const targetRes = await SELF.fetch(
      "http://localhost/api/deploy-targets/drivers",
      { headers },
    );
    expect(targetRes.status).toBe(200);
  });
});

describe("POST /api/connections — Cloudflare paste-token happy path", () => {
  it("verifies the token, encrypts it, and enqueues discovery", async () => {
    const { userId, sessionCookie } = await seedUser();

    // Cloudflare's verifyCredentials calls:
    //   POST /user/tokens/verify   — returns { result: { status: "active" } }
    //   GET  /accounts?per_page=50 — returns { result: [...] }
    mockFetch("https://api.cloudflare.com", async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/client/v4/user/tokens/verify") {
        return Response.json({
          success: true,
          result: { id: "tok_abc", status: "active" },
        });
      }
      if (url.pathname === "/client/v4/accounts") {
        return Response.json({
          success: true,
          result: [{ id: "acct_xyz", name: "Test Account" }],
        });
      }
      throw new Error(`unexpected Cloudflare path: ${url.pathname}`);
    });

    const form = new FormData();
    form.set("provider", "cloudflare-worker-tail");
    form.set("display_name", "Test CF");
    form.set("api_token", "cf_test_token");
    const res = await SELF.fetch("http://localhost/api/connections", {
      method: "POST",
      headers: { cookie: sessionCookie },
      body: form,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      connection: { id: string; provider: string; externalAccountId: string };
    };
    expect(json.connection.provider).toBe("cloudflare-worker-tail");
    expect(json.connection.externalAccountId).toBe("acct_xyz");

    // Connection row really landed in D1 and is scoped to this user.
    const row = await env.DB.prepare(
      "SELECT user_id, provider, external_account_id FROM connections WHERE id = ?",
    )
      .bind(json.connection.id)
      .first<{
        user_id: string;
        provider: string;
        external_account_id: string;
      }>();
    expect(row?.user_id).toBe(userId);
    expect(row?.provider).toBe("cloudflare-worker-tail");
    expect(row?.external_account_id).toBe("acct_xyz");

    // Discovery job was enqueued — there should be a queued/running
    // row with the right lock_key. Side-effect-as-assertion: proves
    // we wired the queue producer call and didn't swallow the
    // enqueue.
    const job = await env.DB.prepare(
      "SELECT status, kind FROM jobs WHERE lock_key = ?",
    )
      .bind(`discovery:${json.connection.id}`)
      .first<{ status: string; kind: string }>();
    expect(job?.kind).toBe("discovery");
    expect(["queued", "running", "succeeded", "failed"]).toContain(job?.status);
  });

  it("rejects an invalid token with verify_failed before touching the DB", async () => {
    const { userId, sessionCookie } = await seedUser();

    mockFetch("https://api.cloudflare.com", async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "invalid token" }],
        },
        { status: 403 },
      ),
    );

    const form = new FormData();
    form.set("provider", "cloudflare-worker-tail");
    form.set("display_name", "Bad CF");
    form.set("api_token", "cf_bad_token");
    const res = await SELF.fetch("http://localhost/api/connections", {
      method: "POST",
      headers: { cookie: sessionCookie },
      body: form,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("verify_failed");

    // Nothing leaked into D1.
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM connections WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe("Vercel OAuth", () => {
  it("uses platform-level /providers/vercel routes and stores vercel-logs credentials", async () => {
    const { userId, sessionCookie } = await seedUser();

    const start = await SELF.fetch(
      "http://localhost/api/providers/vercel/start?display_name=Prod%20Vercel",
      { headers: { cookie: sessionCookie }, redirect: "manual" },
    );
    expect(start.status).toBe(303);
    const location = start.headers.get("location")!;
    expect(location).toMatch(/^https:\/\/vercel\.com\/oauth\/authorize/);
    const authorizeUrl = new URL(location);
    expect(authorizeUrl.searchParams.get("client_id")).toBe(
      "test_vercel_client",
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `${env.APP_URL}/api/providers/vercel/callback`,
    );
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "openid offline_access",
    );
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorizeUrl.searchParams.get("state")!;
    const stateCookie = start.headers.get("set-cookie")!;

    mockFetch("https://api.vercel.com", async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/login/oauth/token") {
        const body = await req.formData();
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("oauth_code");
        expect(body.get("client_id")).toBe("test_vercel_client");
        expect(body.get("code_verifier")).toBeTruthy();
        expect(body.get("redirect_uri")).toBe(
          `${env.APP_URL}/api/providers/vercel/callback`,
        );
        return Response.json({
          access_token: "vercel_oauth_token",
          refresh_token: "vercel_refresh_token",
        });
      }
      if (url.pathname === "/v2/user") {
        expect(req.headers.get("authorization")).toBe(
          "Bearer vercel_oauth_token",
        );
        return Response.json({ user: { uid: "usr_vercel", username: "vc" } });
      }
      throw new Error(`unexpected Vercel path: ${url.pathname}`);
    });

    const callback = await SELF.fetch(
      `http://localhost/api/providers/vercel/callback?code=oauth_code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    expect(callback.status).toBe(303);
    const callbackLocation = callback.headers.get("location")!;
    expect(callbackLocation).toMatch(/^\/app\/connections\/con_/);
    const connectionId = callbackLocation.split("/").pop()!;

    const row = await env.DB.prepare(
      "SELECT user_id, provider, display_name, external_account_id FROM connections WHERE id = ?",
    )
      .bind(connectionId)
      .first<{
        user_id: string;
        provider: string;
        display_name: string;
        external_account_id: string;
      }>();
    expect(row).toEqual({
      user_id: userId,
      provider: "vercel-logs",
      display_name: "Prod Vercel",
      external_account_id: null,
    });

    const job = await env.DB.prepare(
      "SELECT kind FROM jobs WHERE lock_key = ?",
    )
      .bind(`discovery:${connectionId}`)
      .first<{ kind: string }>();
    expect(job?.kind).toBe("discovery");
  });
});
