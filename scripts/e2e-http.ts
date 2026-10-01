import { runRoutingLifecycle } from "../test/e2e/lifecycle";

const baseUrl = process.env.LOGT_E2E_URL;
const sessionCookie = process.env.LOGT_E2E_SESSION_COOKIE;
const expectedUserId = process.env.LOGT_E2E_USER_ID;
if (!baseUrl || !sessionCookie || !expectedUserId) {
  throw new Error("Set LOGT_E2E_URL, LOGT_E2E_SESSION_COOKIE and LOGT_E2E_USER_ID for a disposable test account");
}
const url = new URL(baseUrl);
if (!['http:', 'https:'].includes(url.protocol)) throw new Error("E2E target must be an HTTP URL");
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.LOGT_E2E_ALLOW_REMOTE !== '1') {
  throw new Error("Set LOGT_E2E_ALLOW_REMOTE=1 to explicitly select a remote lifecycle target");
}
await runRoutingLifecycle({ baseUrl, sessionCookie, expectedUserId, runId: crypto.randomUUID(), fetch: (request) => fetch(request) });
console.log("Routing lifecycle passed; created resources removed.");
