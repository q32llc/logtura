import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { createConnection, getConnection, decryptConnectionCredentials } from "../../src/db";
import { signCookie, verifyCookie } from "../../src/crypto";
import { readConfigurationVersion } from "../../src/config-version";
import { parseOAuthTokens } from "../../src/providers/oauth-token";
import { mockFetch, seedUser } from "./_setup";
const settings = {...env, APP_URL: "https://service.test", VERCEL_CLIENT_ID: "fixture-client", VERCEL_CLIENT_SECRET: "fixture-secret", SUPABASE_CLIENT_ID: "fixture-client", SUPABASE_CLIENT_SECRET: "fixture-secret", RAILWAY_CLIENT_ID: "fixture-client", RAILWAY_CLIENT_SECRET: "fixture-secret"} as Env;
const cases = [{route: "supabase-edge-logs", provider: "supabase-edge-logs", cookie: "logtura_supabase_state", token: "https://api.supabase.com/v1/oauth/token", verify: "https://api.supabase.com/v1/projects", field: "pat", stateError: "oauth_state", client: "SUPABASE_CLIENT_ID"}, {route: "railway", provider: "railway-logs", cookie: "logtura_railway_state", token: "https://backboard.railway.com/oauth/token", verify: "https://backboard.railway.com/graphql/v2", field: "apiToken", stateError: "railway_oauth_state", client: "RAILWAY_CLIENT_ID"}];
async function request(path: string, cookie?: string, overrides: Partial<Env> = {}) {const ctx = createExecutionContext(); const response = await worker.fetch(new Request(`https://service.test/api${path}`, {headers: cookie ? {cookie} : {}, redirect: "manual"}), {...settings, ...overrides}, ctx); await waitOnExecutionContext(ctx); return response;}
async function signed(c: typeof cases[number], payload: unknown) {return `${c.cookie}=${await signCookie(typeof payload === "string" ? payload : JSON.stringify(payload), env.SESSION_SECRET)}`;}
function tokens(c: typeof cases[number], verifier: string, response: unknown = {access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, token_type: "Bearer"}, status = 200) {
 mockFetch(c.token, async req => {expect(req.headers.get("authorization")).toBe(`Basic ${btoa("fixture-client:fixture-secret")}`); const body = new URLSearchParams(await req.text()); expect(body.get("grant_type")).toBe("authorization_code"); expect(body.get("code")).toBe("fixture-code"); expect(body.get("code_verifier")).toBe(verifier); expect(body.get("redirect_uri")).toBe(`https://service.test/api/providers/${c.route}/callback`); return Response.json(response, {status});});
}
function verification(c: typeof cases[number], fail = false) {mockFetch(c.verify, req => {expect(req.headers.get("authorization")).toBe("Bearer fixture-access"); if(fail) return new Response("fixture-private-verification-body", {status: 403}); return Response.json(c.field === "pat" ? [{id: "project-fixture", ref: "project-fixture", name: "Fixture Project"}] : {data: {projectToken: {project: {id: "project-fixture", name: "Fixture Project"}}}});});}
async function begin(c: typeof cases[number], cookie: string, query = "display_name=Fixture%20Connection") {
 const response = await request(`/providers/${c.route}/start?${query}`, cookie); expect(response.status).toBe(303); const location = new URL(response.headers.get("location")!); const stateCookie = response.headers.get("set-cookie")!.split(";")[0]!; const payload = JSON.parse((await verifyCookie(stateCookie.split("=")[1], env.SESSION_SECRET))!); return {response, location, stateCookie, payload};
}
it.each(cases)("starts $route with PKCE and creates encrypted credentials without auto-selecting a project", async c => {
 const user = await seedUser(), start = await begin(c, user.sessionCookie); expect(start.location.searchParams.get("client_id")).toBe("fixture-client"); expect(start.location.searchParams.get("code_challenge_method")).toBe("S256"); expect(start.payload.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
 const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(start.payload.verifier))); let binary = ""; for(const byte of digest) binary += String.fromCharCode(byte);
 expect(start.location.searchParams.get("code_challenge")).toBe(btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")); expect(start.location.searchParams.get("state")).toBe(start.payload.state);
 expect(start.response.headers.get("set-cookie")).toContain("HttpOnly"); expect(start.response.headers.get("set-cookie")).toContain("Secure"); expect(start.response.headers.get("set-cookie")).toContain("Max-Age=600");
 tokens(c, start.payload.verifier); verification(c); const response = await request(`/providers/${c.route}/callback?code=fixture-code&state=${start.payload.state}`, start.stateCookie); expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Max-Age=0"); const id = response.headers.get("location")!.split("/").at(-1)!; const row = (await getConnection(env.DB, user.userId, id))!;
 expect(row.provider).toBe(c.provider); expect(row.display_name).toBe("Fixture Connection"); expect(row.external_account_id).toBeNull(); expect(await decryptConnectionCredentials(env, row)).toMatchObject({[c.field]: "fixture-access", refreshToken: "fixture-refresh"}); expect(JSON.stringify(row)).not.toContain("fixture-access");
 expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM monitors WHERE user_id=?").bind(user.userId).first())!.count).toBe(1); expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE user_id=?").bind(user.userId).first())!.count).toBe(0);
});
it.each(cases)("rejects unauthenticated, deleted-session, unconfigured and nameless $route starts", async c => {
 expect((await request(`/providers/${c.route}/start?display_name=Fixture`)).headers.get("location")).toBe("/?error=auth_required"); const user = await seedUser();
 expect((await request(`/providers/${c.route}/start`, user.sessionCookie)).headers.get("location")).toContain("missing_display_name"); expect((await request(`/providers/${c.route}/start?display_name=Fixture`, user.sessionCookie, {[c.client]: undefined})).headers.get("location")).toContain("oauth_not_configured");
 await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.userId).run(); expect((await request(`/providers/${c.route}/start?display_name=Fixture`, user.sessionCookie)).headers.get("location")).toBe("/?error=auth_required");
});
it.each(cases)("reconnects only the owned matching $route provider and preserves existing source selection", async c => {
 const user = await seedUser(); const created = await createConnection(env.DB, env, {userId: user.userId, provider: c.provider, displayName: "Existing", externalAccountId: "project-fixture", credentials: {[c.field]: "old-access"}}); const before = (await getConnection(env.DB, user.userId, created.id))!; const version = await readConfigurationVersion(env.DB, user.userId);
 const start = await begin(c, user.sessionCookie, `reconnect_id=${created.id}`); expect(start.payload.displayName).toBe("Existing"); tokens(c, start.payload.verifier); verification(c); const response = await request(`/providers/${c.route}/callback?code=fixture-code&state=${start.payload.state}`, start.stateCookie); expect(response.headers.get("location")).toBe(`/app/connections/${created.id}`);
 const after = (await getConnection(env.DB, user.userId, created.id))!; expect(after.display_name).toBe("Existing"); expect(after.external_account_id).toBe("project-fixture"); expect(after.credential_version).not.toBe(before.credential_version); expect(await readConfigurationVersion(env.DB, user.userId)).toBeGreaterThan(version); expect(await decryptConnectionCredentials(env, after)).toMatchObject({[c.field]: "fixture-access"});
 const foreign = await seedUser(); const wrong = await createConnection(env.DB, env, {userId: user.userId, provider: "cloudflare-worker-tail", displayName: "Wrong provider", externalAccountId: null, credentials: {apiToken: "untouched"}});
 for(const [cookie, id] of [[foreign.sessionCookie, created.id], [user.sessionCookie, wrong.id], [user.sessionCookie, "con_missing"]]) {
  for(const suffix of ["", "&display_name=Explicit"]) expect((await request(`/providers/${c.route}/start?reconnect_id=${id}${suffix}`, cookie)).headers.get("location")).toBe("/app?error=bad_reconnect");
 }
 // A previously signed state must be scope-checked again at callback time.
 for(const id of [wrong.id, "con_missing"]) {const state = {state: "fixture-state", userId: user.userId, displayName: "Fixture", verifier: "fixture-verifier", reconnectId: id}; expect((await request(`/providers/${c.route}/callback?code=fixture-code&state=fixture-state`, await signed(c, state))).headers.get("location")).toBe("/app?error=bad_reconnect");}
 expect(await decryptConnectionCredentials(env, (await getConnection(env.DB, user.userId, wrong.id))!)).toEqual({apiToken: "untouched"});
});
it.each(cases)("rejects malformed $route state before any provider request", async c => {
 const user = await seedUser(); const base = {state: "fixture-state", userId: user.userId, displayName: "Fixture", verifier: "fixture-verifier"};
 const invalid = ["{", "null", "42", "[]", JSON.stringify({...base, state: "wrong"}), ...["userId","displayName","verifier"].flatMap(key => [JSON.stringify({...base,[key]: null}), JSON.stringify({...base,[key]: ""})]), JSON.stringify({...base, reconnectId: 42}), JSON.stringify({...base, reconnectId: ""})];
 for(const payload of invalid) {const response = await request(`/providers/${c.route}/callback?code=fixture-code&state=fixture-state`, await signed(c, payload)); expect(response.headers.get("location")).toBe(`/app/connections/new?error=${c.stateError}`); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");}
 for(const query of ["", "?code=fixture-code", "?state=fixture-state", "?code=fixture-code&state=fixture-state"]) expect((await request(`/providers/${c.route}/callback${query}`)).headers.get("location")).toBe(`/app/connections/new?error=${c.stateError}`);
 const response = await request(`/providers/${c.route}/callback?code=fixture-code&state=fixture-state`, await signed(c, base), {[c.client]: undefined}); expect(response.headers.get("location")).toContain("oauth_not_configured");
});
it.each(cases)("leaves storage untouched on $route exchange and verification failures", async c => {
 const user = await seedUser(); const state = {state: "fixture-state", userId: user.userId, displayName: "Fixture", verifier: "fixture-verifier", reconnectId: null}; const cookie = await signed(c, state); const error = vi.spyOn(console, "error").mockImplementation(() => {});
 tokens(c, state.verifier, {error: "fixture-private-upstream-token"}, 503); const denied = await request(`/providers/${c.route}/callback?code=fixture-code&state=fixture-state`, cookie); expect(denied.headers.get("location")).toContain("oauth_exchange"); expect(JSON.stringify(error.mock.calls)).not.toContain("fixture-private-upstream-token");
 tokens(c, state.verifier); verification(c, true); const verify = await request(`/providers/${c.route}/callback?code=fixture-code&state=fixture-state`, cookie); expect(verify.headers.get("location")).toContain("oauth_verify"); expect(JSON.stringify(error.mock.calls)).not.toContain("fixture-private-verification-body");
 expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM connections WHERE user_id=?").bind(user.userId).first())!.count).toBe(0); error.mockRestore();
});
it("validates all consumed OAuth token fields without echoing body data", () => {
 const valid = {access_token: "fixture-private-token", expires_in: 3600, token_type: "Bearer"}; expect(parseOAuthTokens(JSON.stringify(valid), "Fixture")).toEqual(valid); expect(parseOAuthTokens(JSON.stringify({access_token: "token", expires_in: 3600}), "Fixture", false)).toEqual({access_token: "token", expires_in: 3600});
 for(const bad of [null, 42, [], {...valid, access_token: 42}, {...valid, access_token: ""}, {...valid, expires_in: "3600"}, {...valid, expires_in: null}, {...valid, expires_in: 0}, {...valid, expires_in: -1}, {...valid, refresh_token: null}, {...valid, refresh_token: ""}, {...valid, token_type: 42}, {...valid, token_type: ""}]) expect(() => parseOAuthTokens(JSON.stringify(bad), "Fixture")).toThrow("missing or invalid token fields");
 expect(() => parseOAuthTokens("fixture-private-token", "Fixture")).toThrow("not valid JSON");
 expect(() => parseOAuthTokens('{"access_token":"token","expires_in":1e999,"token_type":"Bearer"}', "Fixture")).toThrow("missing or invalid token fields");
});
it.each(cases)("cannot overwrite a $route connection reassigned during provider verification", async c => {
 const user = await seedUser(); const created = await createConnection(env.DB, env, {userId: user.userId, provider: c.provider, displayName: "Changing", externalAccountId: null, credentials: {[c.field]: "old-access"}});
 const start = await begin(c, user.sessionCookie, `reconnect_id=${created.id}`); tokens(c, start.payload.verifier); const before = (await getConnection(env.DB, user.userId, created.id))!;
 mockFetch(c.verify, async () => {await env.DB.prepare("UPDATE connections SET provider='cloudflare-worker-tail' WHERE id=?").bind(created.id).run(); return Response.json(c.field === "pat" ? [{id: "project-fixture", ref: "project-fixture", name: "Fixture"}] : {data: {projectToken: {project: {id: "project-fixture"}}}});});
 const response = await request(`/providers/${c.route}/callback?code=fixture-code&state=${start.payload.state}`, start.stateCookie); expect(response.headers.get("location")).toBe("/app?error=bad_reconnect");
 expect((await getConnection(env.DB, user.userId, created.id))!.credentials_encrypted).toEqual(before.credentials_encrypted);
});
it("credential replacement atomically preserves a website edit committed after its snapshot read", async () => {
 const {updateConnectionCredentials} = await import("../../src/db"); const user = await seedUser(); const created = await createConnection(env.DB, env, {userId: user.userId, provider: "supabase-edge-logs", displayName: "Original", externalAccountId: null, credentials: {pat: "old-access"}}); const before = (await getConnection(env.DB, user.userId, created.id))!;
 let paused = false;
 // Pause at the write boundary; both the competing edit and guarded replacement
 // execute real D1 SQL, so this checks storage atomicity rather than a mock CAS.
 const db = new Proxy(env.DB, {get(target, key) {
  if(key !== "prepare") return Reflect.get(target, key);
  return (sql: string) => {const statement = target.prepare(sql); if(!sql.trim().startsWith("UPDATE connections")) return statement;
   return {bind(...values: unknown[]) {const bound = statement.bind(...values); return {async first() {paused = true; await env.DB.prepare("UPDATE connections SET display_name='Concurrent website edit' WHERE id=?").bind(created.id).run(); return bound.first();}};}};
  };
 }});
 const result = await updateConnectionCredentials(db, settings, user.userId, created.id, {credentials: {pat: "oauth-access"}, expectedProvider: "supabase-edge-logs"}); expect(paused).toBe(true); expect(result).toBeNull();
 const after = (await getConnection(env.DB, user.userId, created.id))!; expect(after.display_name).toBe("Concurrent website edit"); expect(after.credentials_encrypted).toEqual(before.credentials_encrypted); expect(after.credential_version).toBe(before.credential_version);
});

it("Vercel reconnect scopes cannot bypass provider/ownership checks with an explicit name or old signed state", async () => {
 const user = await seedUser(); const wrong = await createConnection(env.DB, env, {userId: user.userId, provider: "cloudflare-worker-tail", displayName: "Wrong provider", externalAccountId: null, credentials: {apiToken: "unchanged"}});
 for(const suffix of ["", "&display_name=Explicit"]) expect((await request(`/providers/vercel/start?reconnect_id=${wrong.id}${suffix}`, user.sessionCookie)).headers.get("location")).toBe("/app?error=bad_reconnect");
 const foreign = await seedUser(); const owned = await createConnection(env.DB, env, {userId: user.userId, provider: "vercel-logs", displayName: "Vercel", externalAccountId: null, credentials: {apiToken: "unchanged"}});
 expect((await request(`/providers/vercel/start?reconnect_id=${owned.id}&display_name=Explicit`, foreign.sessionCookie)).headers.get("location")).toBe("/app?error=bad_reconnect");
 const state = await signCookie(JSON.stringify({state: "fixture-state", userId: user.userId, displayName: "Vercel", reconnectId: wrong.id}), env.SESSION_SECRET);
 expect((await request("/providers/vercel/callback?code=fixture-code&state=fixture-state", `logtura_vercel_state=${state}`)).headers.get("location")).toBe("/app?error=bad_reconnect");
 expect(await decryptConnectionCredentials(env, (await getConnection(env.DB, user.userId, wrong.id))!)).toEqual({apiToken: "unchanged"});
 await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.userId).run(); expect((await request("/providers/vercel/start?display_name=Fixture", user.sessionCookie)).headers.get("location")).toBe("/?error=auth_required");
});
it("Vercel OAuth rejects invalid responses without echoing provider bodies", async () => {
 const {exchangeVercelCode} = await import("../../src/providers/vercel-oauth");
 for(const [body,status] of [["fixture-private-provider-response",503],["fixture-private-provider-response",200],["null",200],[JSON.stringify({access_token:42}),200]] as const) {
  mockFetch("https://api.vercel.com/v2/oauth/access_token", () => new Response(body,{status,headers:{"content-type":"application/json"}}));
  try {await exchangeVercelCode({clientId:"fixture",clientSecret:"fixture-secret",code:"fixture",redirectUri:"https://service.test/callback"});throw new Error("Expected invalid OAuth response to fail");} catch(error) {expect(String(error)).not.toContain("fixture-private-provider-response");expect(String(error)).toMatch(/Vercel OAuth/);}
 }
});

it("Vercel token account fields are typed and optional fields retain their null defaults", async () => {
 const {exchangeVercelCode} = await import("../../src/providers/vercel-oauth"); const run=()=>exchangeVercelCode({clientId:"fixture",clientSecret:"fixture-secret",code:"fixture",redirectUri:"https://service.test/callback"});
 for(const fields of [{},{installation_id:null,team_id:null,user_id:null},{installation_id:"install",team_id:"team",user_id:"user"}]) {
  mockFetch("https://api.vercel.com/v2/oauth/access_token",()=>Response.json({access_token:"fixture",...fields})); expect(await run()).toEqual({access_token:"fixture",installation_id:null,team_id:null,user_id:null,...fields});
 }
 for(const value of [42,""]) {mockFetch("https://api.vercel.com/v2/oauth/access_token",()=>Response.json({access_token:"fixture",team_id:value}));await expect(run()).rejects.toThrow("invalid account fields");}
});
