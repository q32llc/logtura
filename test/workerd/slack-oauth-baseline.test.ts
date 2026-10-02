import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { decryptDestinationConfig, listDestinations } from "../../src/db";
import { signCookie, verifyCookie } from "../../src/crypto";
import { readConfigurationVersion } from "../../src/config-version";
import { exchangeSlackWebhook, readSlackOAuthState } from "../../src/destinations/slack-oauth";
import { mockFetch, seedUser } from "./_setup";

const settings = { ...env, APP_URL: "https://service.test", SLACK_CLIENT_ID: "fixture-client", SLACK_CLIENT_SECRET: "fixture-secret" } as Env;
const callback = "/api/destinations/slack/callback?code=fixture-code&state=fixture-state";
const hook = "https://hooks.slack.com/services/fixture/private/webhook";
async function request(path: string, cookie?: string, overrides: Partial<Env> = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://service.test${path}`, { headers: cookie ? { cookie } : {} }), { ...settings, ...overrides }, context);
  await waitOnExecutionContext(context);
  return response;
}
async function stateCookie(payload: unknown) {
  return `logtura_slack_state=${await signCookie(typeof payload === "string" ? payload : JSON.stringify(payload), env.SESSION_SECRET)}`;
}
function exchange(payload: unknown, status = 200) {
  mockFetch("https://slack.com/api/oauth.v2.access", async req => {
    expect(req.method).toBe("POST");
    expect(req.headers.get("accept")).toBe("application/json");
    expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(await req.text()))).toEqual({ client_id: "fixture-client", client_secret: "fixture-secret", code: "fixture-code", redirect_uri: "https://service.test/api/destinations/slack/callback" });
    return typeof payload === "string" ? new Response(payload, { status }) : Response.json(payload, { status });
  });
}

it("starts Slack OAuth for an active browser session with scoped secure state", async () => {
  const user = await seedUser();
  const response = await request("/api/destinations/slack/start", user.sessionCookie);
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
  expect(url.searchParams.get("client_id")).toBe("fixture-client");
  expect(url.searchParams.get("scope")).toBe("incoming-webhook");
  expect(url.searchParams.get("user_scope")).toBe("");
  expect(url.searchParams.get("redirect_uri")).toBe("https://service.test/api/destinations/slack/callback");
  const cookie = response.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=600", "Path=/"]) expect(cookie).toContain(flag);
  expect(JSON.parse((await verifyCookie(cookie.split(";")[0]!.split("=")[1], env.SESSION_SECRET))!)).toEqual({ state: url.searchParams.get("state"), userId: user.userId });
  expect(url.searchParams.get("state")).toBeTruthy();
  const insecure = await request("/api/destinations/slack/start", user.sessionCookie, { APP_URL: "http://localhost" });
  expect(insecure.headers.get("set-cookie")).not.toContain("Secure");
});
it("rejects missing/deleted sessions and either missing Slack credential", async () => {
  expect((await request("/api/destinations/slack/start")).headers.get("location")).toBe("/?error=auth_required");
  const user = await seedUser();
  for (const overrides of [{ SLACK_CLIENT_ID: undefined }, { SLACK_CLIENT_SECRET: undefined }]) {
    expect((await request("/api/destinations/slack/start", user.sessionCookie, overrides)).headers.get("location")).toBe("/app/destinations?error=slack_not_configured");
  }
  await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.userId).run();
  expect((await request("/api/destinations/slack/start", user.sessionCookie)).headers.get("location")).toBe("/?error=auth_required");
});
it.each([
  [{ incoming_webhook: { url: hook, channel: "#alerts" }, team: { name: "Fixture" } }, "Fixture #alerts", "Fixture", "#alerts"],
  [{ incoming_webhook: { url: hook, channel: "alerts" }, team: { name: "Fixture" } }, "Fixture #alerts", "Fixture", "alerts"],
  [{ incoming_webhook: { url: hook }, team: { name: "Fixture" } }, "Fixture", "Fixture", null],
  [{ incoming_webhook: { url: hook, channel: null }, team: { name: null } }, "Slack", null, null],
  [{ incoming_webhook: { url: hook } }, "Slack", null, null],
  [{ incoming_webhook: { url: hook, channel: "" }, team: { name: "" } }, "Slack", null, null],
])("stores only encrypted webhook configuration: %j", async (fields, displayName, teamName, channel) => {
  const user = await seedUser(), version = await readConfigurationVersion(env.DB, user.userId);
  exchange({ ok: true, ...fields as object, access_token: "fixture-unused-private-access" });
  // The signed state works without the browser session in the callback.
  const response = await request(callback, await stateCookie({ state: "fixture-state", userId: user.userId }));
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/app/destinations?notice=slack_connected");
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  const destinations = await listDestinations(env.DB, user.userId);
  expect(destinations).toHaveLength(1);
  expect(destinations[0]).toMatchObject({ display_name: displayName, kind: "slack" });
  expect(await decryptDestinationConfig(env, destinations[0]!)).toEqual({ webhookUrl: hook, teamName, channel, maxMessageChars: 12000 });
  expect(JSON.stringify(destinations)).not.toContain(hook);
  expect(await readConfigurationVersion(env.DB, user.userId)).toBeGreaterThan(version);
  const listing = await request("/api/destinations", user.sessionCookie);
  const body = await listing.text();
  expect(body).toContain(String(displayName));
  for (const secret of [hook, "fixture-unused-private-access", "config_encrypted"]) expect(body).not.toContain(secret);
});
it("rejects missing, malformed and mismatched state without calling Slack", async () => {
  const user = await seedUser();
  for (const path of ["/api/destinations/slack/callback", callback.replace("code=fixture-code&", ""), callback.replace("&state=fixture-state", "")]) {
    expect((await request(path, await stateCookie({ state: "fixture-state", userId: user.userId }))).headers.get("location")).toBe("/app/destinations?error=oauth_state");
  }
  for (const payload of [null, [], 42, "not-json", {}, { state: "wrong", userId: user.userId }, { state: "fixture-state" }, { state: "fixture-state", userId: "" }, { state: "fixture-state", userId: 42 }]) {
    expect((await request(callback, await stateCookie(payload))).headers.get("location")).toBe("/app/destinations?error=oauth_state");
  }
  expect((await request(callback)).headers.get("location")).toBe("/app/destinations?error=oauth_state");
  expect((await request(callback, "logtura_slack_state=tampered")).headers.get("location")).toBe("/app/destinations?error=oauth_state");
  expect(readSlackOAuthState('{"state":"fixture-state","userId":"owner"}', "fixture-state")).toEqual({ state: "fixture-state", userId: "owner" });
});
it("rejects a deleted state owner and missing callback credentials before exchange", async () => {
  const user = await seedUser(), cookie = await stateCookie({ state: "fixture-state", userId: user.userId });
  for (const overrides of [{ SLACK_CLIENT_ID: undefined }, { SLACK_CLIENT_SECRET: undefined }]) {
    expect((await request(callback, cookie, overrides)).headers.get("location")).toBe("/app/destinations?error=slack_not_configured");
  }
  await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.userId).run();
  expect((await request(callback, cookie)).headers.get("location")).toBe("/?error=auth_required");
});
it("rejects provider and transport failures without persisting or exposing a response body", async () => {
  const user = await seedUser(), cookie = await stateCookie({ state: "fixture-state", userId: user.userId });
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [payload, status] of [[{ ok: false, access_token: "fixture-private-provider-error" }, 200], ["fixture-private-provider-error", 500], ["fixture-private-provider-error", 200]] as const) {
    exchange(payload, status);
    expect((await request(callback, cookie)).headers.get("location")).toBe("/app/destinations?error=slack_exchange");
  }
  mockFetch("https://slack.com/api/oauth.v2.access", () => { throw new Error("fixture-private-provider-error"); });
  expect((await request(callback, cookie)).headers.get("location")).toBe("/app/destinations?error=slack_exchange");
  expect(await listDestinations(env.DB, user.userId)).toEqual([]);
  expect(JSON.stringify(logger.mock.calls)).not.toContain("fixture-private-provider-error");
  logger.mockRestore();
});
it("rejects successful JSON with invalid consumed fields using static exceptions", async () => {
  const payloads = [null, [], 42, {}, { ok: "true", incoming_webhook: { url: hook } }, { ok: true }, { ok: true, incoming_webhook: null },
    ...[undefined, "", "  ", 42].map(url => ({ ok: true, incoming_webhook: { url } })),
    { ok: true, incoming_webhook: { url: hook, channel: 42 } }, { ok: true, incoming_webhook: { url: hook }, team: { name: 42 } }];
  for (const payload of payloads) {
    exchange(payload);
    await expect(exchangeSlackWebhook({ clientId: "fixture-client", clientSecret: "fixture-secret", code: "fixture-code", redirectUri: "https://service.test/api/destinations/slack/callback" })).rejects.toThrow();
  }
});
