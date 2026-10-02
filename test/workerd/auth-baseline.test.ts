import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { expect, it } from "vitest";
import worker from "../../src/index";
import { requireAuth } from "../../src/auth";
import { signCookie, verifyCookie } from "../../src/crypto";
import type { AppContext, Env } from "../../src/env";
import { mockFetch, seedUser } from "./_setup";
const settings = {...env, GITHUB_CLIENT_ID: "fixture-client", GITHUB_CLIENT_SECRET: "fixture-client-secret", APP_URL: "https://service.test"} as Env;
async function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
 const ctx = createExecutionContext(); const response = await worker.fetch(new Request(`https://service.test${path}`, {...init, redirect: "manual"}), {...settings, ...overrides}, ctx); await waitOnExecutionContext(ctx); return response;
}
function tokenExchange(body: unknown = {access_token: "fixture-access"}, status = 200) {
 mockFetch("https://github.com/login/oauth/access_token", async req => {expect(req.method).toBe("POST"); expect(await req.json()).toMatchObject({client_id: "fixture-client", client_secret: "fixture-client-secret", code: "fixture-code"}); return Response.json(body, {status});});
}
async function callback(profile: unknown, emails: unknown = [], emailStatus = 200) {
 tokenExchange(); mockFetch("https://api.github.com/user", req => {expect(req.headers.get("authorization")).toBe("Bearer fixture-access"); return Response.json(profile);});
 mockFetch("https://api.github.com/user/emails", req => {expect(req.headers.get("authorization")).toBe("Bearer fixture-access"); return Response.json(emails, {status: emailStatus});});
 const state = await signCookie(JSON.stringify({nonce: "fixture-state", returnTo: "/app/cli?code=ABCD-EFGH"}), env.SESSION_SECRET);
 return request("/auth/github/callback?code=fixture-code&state=fixture-state", {headers: {cookie: `logtura_oauth_state=${state}`}});
}
it.each(["", undefined])("rejects login when a GitHub client setting is absent: %j", async value => {
 for(const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {const response = await request("/login/github", {}, {[key]: value} as Partial<Env>); expect(response.status).toBe(500); expect(await response.text()).toBe("GitHub OAuth not configured");}
});
it("sets secure OAuth/session cookies, uses the configured redirect and persists the real profile", async () => {
 const start = await request("/login/github?return_to=%2Fapp%2Fcli%3Fcode%3DABCD-EFGH%23ignored"); const location = new URL(start.headers.get("location")!);
 expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize"); expect(location.searchParams.get("redirect_uri")).toBe("https://service.test/auth/github/callback"); expect(location.searchParams.get("scope")).toBe("read:user user:email");
 const cookie = start.headers.get("set-cookie")!; expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Lax"); expect(cookie).toContain("Max-Age=600");
 tokenExchange(); mockFetch("https://api.github.com/user", () => Response.json({id: 7331, login: "native-auth", email: "public@example.test", name: "Native Auth", avatar_url: "https://avatar.test/native"}));
 const finish = await request(`/auth/github/callback?code=fixture-code&state=${location.searchParams.get("state")}`, {headers: {cookie: cookie.split(";")[0]!}});
 expect(finish.status).toBe(303); expect(finish.headers.get("location")).toBe("/app/cli?code=ABCD-EFGH");
 const set = finish.headers.get("set-cookie")!; expect(set).toContain("logtura_oauth_state="); expect(set).toContain("Max-Age=0"); expect(set).toContain("Max-Age=2592000"); expect(set).toContain("Secure");
 const session = /logtura_session=([^;,]+)/.exec(set)![1]!; const id = await verifyCookie(session, env.SESSION_SECRET); const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first(); expect(row).toMatchObject({github_id: "7331", github_login: "native-auth", email: "public@example.test", name: "Native Auth"});
 const me = await request("/api/me", {headers: {cookie: `logtura_session=${session}`}}); expect((await me.json() as any).user.id).toBe(id);
});
it.each([
 {emails: [{email: "fallback@example.test", verified: true}, {email: "primary@example.test", verified: true, primary: true}], expected: "primary@example.test", status: 200},
 {emails: [{email: "unverified@example.test", primary: true}, {email: "verified@example.test", verified: true}], expected: "verified@example.test", status: 200},
 {emails: [{email: "unverified@example.test"}], expected: null, status: 200},
 {emails: [{verified: true, primary: true}], expected: null, status: 200},
 {emails: [], expected: null, status: 403},
])("uses only the available verified email: $expected ($status)", async ({emails, expected, status}) => {
 const finish = await callback({id: 7332, login: "email-auth", email: null, name: null, avatar_url: null}, emails, status); expect(finish.status).toBe(303);
 expect((await env.DB.prepare("SELECT email FROM users WHERE github_id='7332'").first())!.email).toBe(expected);
});
it.each([{}, {nonce: 42}, {nonce: "wrong"}, null, "malformed-json"])("rejects malformed/mismatched callback state before outbound exchange: %j", async payload => {
 const signed = await signCookie(payload === "malformed-json" ? "{" : JSON.stringify(payload), env.SESSION_SECRET);
 const response = await request("/auth/github/callback?code=fixture-code&state=fixture-state", {headers: {cookie: `logtura_oauth_state=${signed}`}}); expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("/?error=oauth_state"); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});
it.each(["", "?code=fixture-code", "?state=fixture-state", "?code=fixture-code&state=fixture-state"])("rejects missing callback inputs or cookie: %s", async query => {const response = await request(`/auth/github/callback${query}`); expect(response.headers.get("location")).toBe("/?error=oauth_state");});
it.each([undefined, "/app" + "x".repeat(513), "/application", "/app/../outside", "/app\\outside", "/app?ok=1#drop"])("limits login continuation to an application path: %j", async value => {
 const path = value === undefined ? "/login/github" : `/login/github?return_to=${encodeURIComponent(value)}`; const start = await request(path); const raw = start.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
 const saved = JSON.parse((await verifyCookie(raw, env.SESSION_SECRET))!); expect(saved.returnTo).toBe(value === "/app?ok=1#drop" ? "/app?ok=1" : value === "/app\\outside" ? "/app/outside" : "/app");
});
it.each([{body: {}, status: 200}, {body: {error: "fixture-denied"}, status: 200}, {body: {}, status: 503}])("does not create sessions after failed token exchange: %j", async ({body, status}) => {
 tokenExchange(body, status); const signed = await signCookie("fixture-state", env.SESSION_SECRET); const response = await request("/auth/github/callback?code=fixture-code&state=fixture-state", {headers: {cookie: `logtura_oauth_state=${signed}`}}); expect(response.status).toBe(500); expect(response.headers.get("set-cookie")).not.toContain("logtura_session=");
});
it.each([null, {id: 0, login: "invalid"}, {id: 1.5, login: "invalid"}, {id: "7333", login: "invalid"}, {id: 7333, login: 42}, {id: 7333, login: ""}, {id: 7333}, {}])("does not create sessions for a malformed GitHub identity: %j", async profile => {const response = await callback(profile); expect(response.status).toBe(500); expect(response.headers.get("set-cookie")).not.toContain("logtura_session=");});
it("handles profile HTTP failure and logout without retaining a session", async () => {
 tokenExchange(); mockFetch("https://api.github.com/user", () => new Response("failure", {status: 502})); const state = await signCookie("fixture-state", env.SESSION_SECRET); expect((await request("/auth/github/callback?code=fixture-code&state=fixture-state", {headers: {cookie: `logtura_oauth_state=${state}`}})).status).toBe(500);
 const logout = await request("/logout"); expect(logout.status).toBe(303); expect(logout.headers.get("location")).toBe("/"); expect(logout.headers.get("set-cookie")).toContain("logtura_session="); expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
});
it("the auth middleware resolves valid cookies independently and denies stale identities and account-token misuse", async () => {
 const app = new Hono<AppContext>(); app.use("*", requireAuth); app.get("/protected", c => c.json({id: c.get("user")!.id})); const user = await seedUser();
 const invoke = (headers: Record<string,string>) => app.request("https://service.test/protected", {headers}, settings);
 expect(await (await invoke({cookie: user.sessionCookie})).json()).toEqual({id: user.userId}); expect((await invoke({authorization: "Bearer invalid", cookie: user.sessionCookie})).status).toBe(401);
 expect((await invoke({cookie: "logtura_session=invalid"})).headers.get("location")).toBe("/?error=auth_required");
 await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.userId).run(); const stale = await invoke({cookie: user.sessionCookie}); expect(stale.headers.get("location")).toBe("/?error=auth_required"); expect(stale.headers.get("set-cookie")).toContain("Max-Age=0");
 expect((await SELF.fetch("http://localhost/api/me", {headers: {cookie: user.sessionCookie}})).status).toBe(200);
});

it("handles omitted optional GitHub profile fields without preventing authenticated login", async () => {
 const response = await callback({id: 7334, login: "minimal-profile"}); expect(response.status).toBe(303);
 expect(await env.DB.prepare("SELECT email,name,avatar_url FROM users WHERE github_id='7334'").first()).toEqual({email: null, name: null, avatar_url: null});
});
it.each(["token", "profile"])("does not log private malformed GitHub %s responses", async endpoint => {
 const {vi} = await import("vitest"); const errors = vi.spyOn(console,"error").mockImplementation(() => {}); tokenExchange();
 mockFetch("https://api.github.com/user", () => Response.json({id: 7335, login: "fixture", email: "public@example.test", name: null, avatar_url: null}));
 mockFetch(endpoint === "token" ? "https://github.com/login/oauth/access_token" : "https://api.github.com/user", () => new Response("fixture-private-provider-response", {headers: {"content-type": "application/json"}}));
 const state = await signCookie("fixture-state", env.SESSION_SECRET); const response = await request("/auth/github/callback?code=fixture-code&state=fixture-state", {headers: {cookie: `logtura_oauth_state=${state}`}}); expect(response.status).toBe(500); expect(JSON.stringify(errors.mock.calls)).not.toContain("fixture-private-provider-response"); errors.mockRestore();
});
it.each([null, {access_token: ""}, {access_token: 42}, {error: "fixture-private-provider-error"}])("rejects malformed GitHub token fields without logging response data: %j", async body => {
 const {vi} = await import("vitest"); const errors = vi.spyOn(console,"error").mockImplementation(() => {}); tokenExchange(body);
 const state = await signCookie("fixture-state", env.SESSION_SECRET); const response = await request("/auth/github/callback?code=fixture-code&state=fixture-state", {headers: {cookie: `logtura_oauth_state=${state}`}}); expect(response.status).toBe(500); expect(JSON.stringify(errors.mock.calls)).not.toContain("fixture-private-provider-error"); errors.mockRestore();
});
