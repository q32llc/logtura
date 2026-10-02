import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { randomUUID } from "node:crypto";
import { signCookie } from "../../src/crypto";

/** Fresh real storage; only identity seeding bypasses public HTTP workflows. */
export async function startLocalService() {
  const secret = randomUUID();
  const compiled = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false,
    format: "esm", platform: "browser", external: ["node:*", "cloudflare:*"], logLevel: "silent" });
  const unexpected: string[] = [];
  const options = {
    modules: true, script: compiled.outputFiles![0]!.text, compatibilityDate: "2025-05-01",
    compatibilityFlags: ["nodejs_compat"], host: "127.0.0.1", port: 0,
    d1Databases: ["DB"], d1Persist: false, queuePersist: false, queueProducers: { JOBS_QUEUE: "e2e-jobs" }, queueConsumers: { "e2e-jobs": {} },
    bindings: { APP_URL: "http://localhost", SESSION_SECRET: secret,
      CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    outboundService(request: Request) {
      const url = new URL(request.url);
      if (url.origin === "https://api.cloudflare.com") {
        const path = url.pathname;
        if (path === "/client/v4/user/tokens/verify") return Response.json({ success: true, result: { status: "active" } });
        if (path === "/client/v4/accounts") return Response.json({ success: true, result: [{ id: "fixture-account", name: "Fixture" }] });
        if (path === "/client/v4/accounts/fixture-account/workers/scripts") return Response.json({ success: true, result: [] });
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
    return { service, url: (await service.ready).origin, userId, cookie, unexpected };
  } catch (error) { await service.dispose(); throw error; }
}
