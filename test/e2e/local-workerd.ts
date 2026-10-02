import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { randomUUID } from "node:crypto";
import { signCookie } from "../../src/crypto";

/** Fresh real storage; only identity seeding bypasses public HTTP workflows. */
export async function startLocalService(optionsForFixture: { flyAuthorization?: boolean } = {}) {
  const secret = randomUUID();
  const compiled = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false,
    format: "esm", platform: "browser", external: ["node:*", "cloudflare:*"], logLevel: "silent" });
  const unexpected: string[] = [];
  let providerToken = "fixture-private-provider-token";
  let rotatedVerifications = 0;
  let discoveryHold: Promise<void> | undefined;
  function holdDiscovery() {
    if (discoveryHold) throw new Error("Discovery fixture is already held");
    let release!: () => void;
    discoveryHold = new Promise<void>(resolve => { release = resolve; });
    const timeout = setTimeout(() => {
      unexpected.push("discovery_fixture_hold_timeout"); resume();
    }, 20_000);
    function resume() { clearTimeout(timeout); discoveryHold = undefined; release(); }
    return resume;
  }
  const options = {
    modules: true, script: compiled.outputFiles![0]!.text, compatibilityDate: "2025-05-01",
    compatibilityFlags: ["nodejs_compat"], host: "127.0.0.1", port: 0,
    assets: { directory: "dist", binding: "ASSETS",
      routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true },
      assetConfig: { not_found_handling: "single-page-application" as const } },
    d1Databases: ["DB"], d1Persist: false, queuePersist: false, queueProducers: { JOBS_QUEUE: "e2e-jobs" }, queueConsumers: { "e2e-jobs": {} },
    bindings: { APP_URL: "http://localhost", SESSION_SECRET: secret,
      CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    async outboundService(request: Request) {
      const url = new URL(request.url);
      if (optionsForFixture.flyAuthorization && url.origin === "https://api.fly.io" && url.pathname === "/api/v1/cli_sessions" && request.method === "POST" && !request.headers.has("authorization")) {
        return Response.json({ id: "fixture-fly-session", auth_url: "https://fly.io/authorize/fixture-fly-session" });
      }
      if (url.origin === "https://api.cloudflare.com") {
        if (request.headers.get("authorization") !== `Bearer ${providerToken}`) {
          unexpected.push("invalid_cloudflare_fixture_credential");
          return Response.json({ success: false, errors: [{ message: "Invalid fixture credential" }] }, { status: 401 });
        }
        const path = url.pathname;
        if (path === "/client/v4/user/tokens/verify") {
          if (providerToken !== "fixture-private-provider-token") rotatedVerifications++;
          return Response.json({ success: true, result: { status: "active" } });
        }
        if (path === "/client/v4/accounts") return Response.json({ success: true, result: [{ id: "fixture-account", name: "Fixture" }] });
        if (path === "/client/v4/accounts/fixture-account/workers/scripts") {
          if (discoveryHold) await discoveryHold;
          return Response.json({ success: true, result: [] });
        }
      }
      unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
      return Response.json({ error: "unconfigured_e2e_provider_request" }, { status: 502 });
    },
  };
  const service = new Miniflare(options);
  try {
    const url = (await service.ready).origin;
    // Device approval is fenced to the actual local website origin.
    await service.setOptions({ ...options, bindings: { ...options.bindings, APP_URL: url } });
    await service.ready;
    const db = await service.getD1Database("DB");
    for (const migration of await readD1Migrations("./migrations")) {
      await db.batch(migration.queries.map(sql => db.prepare(sql)));
    }
    const userId = `usr_e2e_${randomUUID()}`, now = Date.now();
    await db.prepare("INSERT INTO users(id,github_id,github_login,name,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(userId, userId, "local-e2e", "Local E2E", now, now).run();
    const cookie = `logtura_session=${await signCookie(userId, secret)}`;
    return { service, url: (await service.ready).origin, userId, cookie, unexpected, holdDiscovery,
      rotateProviderFixtureCredential() { providerToken = "fixture-private-provider-token-rotated"; return providerToken; },
      rotatedVerificationCount() { return rotatedVerifications; },
    };
  } catch (error) { await service.dispose(); throw error; }
}
