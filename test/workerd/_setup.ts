import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, inject, vi } from "vitest";
import { signCookie, encryptSecret, newId } from "../../src/crypto";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    JOBS_QUEUE: Queue;
    SESSION_SECRET: string;
    CREDENTIAL_ENCRYPTION_KEY: string;
    APP_URL: string;
  }
}

beforeAll(async () => {
  // Migrations come from the globalSetup-provided list. Workerd has
  // no fs, so they're read host-side once and shipped over the
  // provide/inject channel.
  const migrations = inject("migrations");
  await applyD1Migrations(env.DB, migrations);
});

/** Per-test outbound HTTP interceptors. Tests register URL-prefix
 *  handlers via mockFetch(); anything unmocked throws so we never
 *  silently hit a real third-party API from a test. v0.16 of the
 *  pool doesn't expose `fetchMock`, so we install a wrapper around
 *  globalThis.fetch ourselves and tear it down each test. */
type FetchHandler = (req: Request) => Promise<Response> | Response;
let handlers: Array<{ prefix: string; handler: FetchHandler }> = [];

beforeEach(() => {
  handlers = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = req.url;
    for (const { prefix, handler } of handlers) {
      if (url.startsWith(prefix)) return handler(req);
    }
    throw new Error(
      `unmocked outbound fetch in test: ${req.method} ${url} — register a mockFetch() for the prefix`,
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  handlers = [];
});

/** Register a handler for outbound fetches whose URL starts with the
 *  given prefix. Last-registered wins on overlap so a test can layer
 *  a one-off response on top of a shared setup. */
export function mockFetch(prefix: string, handler: FetchHandler): void {
  handlers.unshift({ prefix, handler });
}

/** Insert a seeded user and return a signed session cookie + ids
 *  callers need to assert against. */
export async function seedUser(): Promise<{
  userId: string;
  sessionCookie: string;
}> {
  const userId = newId("usr");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, github_id, github_login, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(userId, `gh_${userId}`, "test-user", "test@example.com", "Test", now, now)
    .run();
  const session = await signCookie(userId, env.SESSION_SECRET);
  return { userId, sessionCookie: `logtura_session=${session}` };
}

/** Insert a deploy_target row with encrypted credentials. Caller
 *  passes the plaintext credential object; we encrypt with the test
 *  CREDENTIAL_ENCRYPTION_KEY exactly like the real code path does. */
export async function seedDeployTarget(input: {
  userId: string;
  kind: string;
  displayName: string;
  externalAccountId: string | null;
  credentials: unknown;
}): Promise<{ id: string }> {
  const id = newId("dt");
  const now = Date.now();
  const ct = await encryptSecret(
    JSON.stringify(input.credentials),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO deploy_targets
     (id, user_id, kind, display_name, external_account_id, credentials_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.userId,
      input.kind,
      input.displayName,
      input.externalAccountId,
      ct,
      now,
      now,
    )
    .run();
  return { id };
}
