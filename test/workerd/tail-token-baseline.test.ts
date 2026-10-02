import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { createConnection, getConnection, decryptConnectionCredentials } from "../../src/db";
import { mintTailToken, verifyTailToken, tailTokenCacheSeconds } from "../../src/providers/tail-token";
import { signCookie } from "../../src/crypto";
import { readConfigurationVersion } from "../../src/config-version";
import { mockFetch, seedUser } from "./_setup";
const settings = {...env, SUPABASE_CLIENT_ID: "fixture-client", SUPABASE_CLIENT_SECRET: "fixture-secret", RAILWAY_CLIENT_ID: "fixture-client", RAILWAY_CLIENT_SECRET: "fixture-secret"} as Env;
const cases = [{route: "supabase", provider: "supabase-edge-logs", field: "pat", endpoint: "https://api.supabase.com/v1/oauth/token", expires: 23 * 3600}, {route: "railway", provider: "railway-logs", field: "apiToken", endpoint: "https://backboard.railway.com/oauth/token", expires: 55 * 60}];
async function request(route: string, authorization?: string, overrides: Partial<Env> = {}) {const ctx = createExecutionContext(); const response = await worker.fetch(new Request(`http://localhost/api/tail/${route}/token`, {method: "POST", headers: authorization ? {authorization} : {}}), {...settings,...overrides}, ctx); await waitOnExecutionContext(ctx); return response;}
async function fixture(provider: string, credentials: Record<string,unknown>) {const user = await seedUser(); const created = await createConnection(env.DB, env, {userId: user.userId, provider, displayName: "Fixture", externalAccountId: null, credentials}); const connection = (await getConnection(env.DB, user.userId, created.id))!; const token = await mintTailToken({userId: user.userId, connectionId: connection.id}, env.SESSION_SECRET); return {...user, connection, token};}
it("accepts exactly the signed connection/user payload and rejects invalid, malformed and tampered tokens", async () => {
 const payload = {userId: "usr_fixture", connectionId: "con_fixture"}; const token = await mintTailToken(payload, env.SESSION_SECRET); expect(await verifyTailToken(token, env.SESSION_SECRET)).toEqual(payload);
 for(const value of [undefined, "", "unsigned", token + "tampered"]) expect(await verifyTailToken(value, env.SESSION_SECRET)).toBeNull();
 for(const json of ["{", "null", "{}", JSON.stringify({userId: 42, connectionId: "con_fixture"}), JSON.stringify({userId: "usr_fixture", connectionId: null})]) expect(await verifyTailToken(await signCookie(json, env.SESSION_SECRET), env.SESSION_SECRET)).toBeNull();
});
it.each(cases)("denies missing/malformed/wrong-scope authorization for $route without consulting providers", async ({route, provider, field}) => {
 for(const authorization of [undefined, "Basic fixture", "Bearer ", "Bearer invalid"]) {const response = await request(route, authorization); expect(response.status).toBe(401);}
 const f = await fixture(provider, {[field]: "private-token"}); const other = await seedUser(); const foreign = await mintTailToken({userId: other.userId, connectionId: f.connection.id}, env.SESSION_SECRET);
 expect((await request(route, `Bearer ${foreign}`)).status).toBe(404); const wrong = await fixture("cloudflare-worker-tail", {apiToken: "unrelated"}); expect((await request(route, `Bearer ${wrong.token}`)).status).toBe(400);
 await env.DB.prepare("DELETE FROM connections WHERE id=?").bind(f.connection.id).run(); expect((await request(route, `Bearer ${f.token}`)).status).toBe(404);
});
it.each(cases)("serves a PAT/cached OAuth token for $route and never caches the secret response", async ({route, provider, field, expires}) => {
 for(const credentials of [{[field]: "fixture-access"}, {[field]: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3600_000}]) {const f = await fixture(provider, credentials); const response = await request(route, `Bearer ${f.token}`); expect(response.status).toBe(200); const body = await response.json() as {access_token:string;expires_in:number}; expect(body.access_token).toBe("fixture-access"); expect(body.expires_in).toBeLessThanOrEqual("expiresAt" in credentials ? Math.min(3600,expires) : expires); expect(body.expires_in).toBeGreaterThan(0); expect(response.headers.get("cache-control")).toBe("no-store");}
});
it.each(cases)("rotates $route credentials in encrypted storage without changing configuration intent", async ({route, provider, field, endpoint, expires}) => {
 const f = await fixture(provider, {[field]: "old-access", refreshToken: "old-refresh", expiresAt: 1}); const beforeVersion = await readConfigurationVersion(env.DB, f.userId);
 mockFetch(endpoint, async req => {expect(req.method).toBe("POST"); expect(req.headers.get("authorization")).toBe(`Basic ${btoa("fixture-client:fixture-secret")}`); const body = new URLSearchParams(await req.text()); expect(body.get("grant_type")).toBe("refresh_token"); expect(body.get("refresh_token")).toBe("old-refresh"); return Response.json({access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer"});});
 const response = await request(route, `Bearer ${f.token}`); expect(response.status).toBe(200); const body = await response.json() as {access_token:string;expires_in:number}; expect(body.access_token).toBe("new-access"); expect(body.expires_in).toBeLessThanOrEqual(Math.min(3600,expires)); expect(body.expires_in).toBeGreaterThan(3500 < expires ? 3500 : 3200); const row = (await getConnection(env.DB, f.userId, f.connection.id))!;
 expect(await decryptConnectionCredentials(env, row)).toMatchObject({[field]: "new-access", refreshToken: "new-refresh"}); expect(row.credentials_encrypted).not.toEqual(f.connection.credentials_encrypted); expect(row.credential_version).toBe(f.connection.credential_version); expect(await readConfigurationVersion(env.DB, f.userId)).toBe(beforeVersion);
});
it.each(cases)("does not return or log upstream credential-bearing refresh failures for $route", async ({route, provider, field, endpoint}) => {
 const f = await fixture(provider, {[field]: "old-access", refreshToken: "old-refresh", expiresAt: 1}); const error = vi.spyOn(console, "error").mockImplementation(() => {});
 mockFetch(endpoint, () => new Response("fixture-private-upstream-token", {status: 503})); const response = await request(route, `Bearer ${f.token}`); expect(response.status).toBe(503); expect(await response.json()).toEqual({error: "refresh_failed", message: "could not refresh token"}); expect(JSON.stringify(error.mock.calls)).not.toContain("fixture-private-upstream-token"); expect(response.headers.get("cache-control")).toBe("no-store");
 expect((await getConnection(env.DB, f.userId, f.connection.id))!.credentials_encrypted).toEqual(f.connection.credentials_encrypted); error.mockRestore();
});
it.each(cases)("rejects malformed successful $route renewal responses without replacing stored credentials", async ({route, provider, field, endpoint}) => {
 const f = await fixture(provider, {[field]: "old-access", refreshToken: "old-refresh", expiresAt: 1}); const error = vi.spyOn(console, "error").mockImplementation(() => {});
 for(const body of ["fixture-private-invalid-json", JSON.stringify({access_token: "fixture-private-token", expires_in: 0, token_type: "Bearer"}), JSON.stringify({expires_in: 3600, token_type: "Bearer"})]) {
  mockFetch(endpoint, () => new Response(body, {headers: {"content-type": "application/json"}})); const response = await request(route, `Bearer ${f.token}`); expect(response.status).toBe(503); expect(await response.json()).toEqual({error: "refresh_failed", message: "could not refresh token"});
  expect((await getConnection(env.DB, f.userId, f.connection.id))!.credentials_encrypted).toEqual(f.connection.credentials_encrypted);
 }
 expect(JSON.stringify(error.mock.calls)).not.toContain("fixture-private"); error.mockRestore();
});

it("bounds broker caching by actual expiry and rejects expired/malformed expiry metadata", () => {
 expect(tailTokenCacheSeconds(3300)).toBe(3300); expect(tailTokenCacheSeconds(3300,Date.now()+3600_000)).toBe(3300);
 expect(tailTokenCacheSeconds(3300,Date.now()+500)).toBe(1); expect(tailTokenCacheSeconds(3300,Date.now()+60_000)).toBeLessThanOrEqual(60);
 for(const value of ["invalid",Infinity,Date.now()-1]) expect(() => tailTokenCacheSeconds(3300,value as number)).toThrow("no usable expiry");
});
it.each(cases)("does not serve empty or expired non-refreshable $route credentials", async ({route,provider,field}) => {
 const error = vi.spyOn(console,"error").mockImplementation(() => {});
 for(const credentials of [{[field]:""},{[field]:"expired-access",expiresAt:1}]) {const f=await fixture(provider,credentials); const response=await request(route,`Bearer ${f.token}`);expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"refresh_failed",message:"could not refresh token"});} error.mockRestore();
});

it.each(cases)("does not return a stale $route credential after concurrent connection replacement", async ({route,provider,field}) => {
 const {updateConnectionCredentials} = await import("../../src/db"); const error = vi.spyOn(console,"error").mockImplementation(() => {});
 for(const change of ["delete","provider","credential"]) {
  const f=await fixture(provider,{[field]:"old-access"}); let reads=0;
  const db=new Proxy(env.DB,{get(target,key){if(key!=="prepare")return Reflect.get(target,key);return(sql:string)=>{const statement=target.prepare(sql);if(!/SELECT\s+\*\s+FROM\s+connections/i.test(sql))return statement;return{bind(...values:unknown[]){const bound=statement.bind(...values);return{async first(){if(++reads===2){if(change==="delete")await env.DB.prepare("DELETE FROM connections WHERE id=?").bind(f.connection.id).run();else if(change==="provider")await env.DB.prepare("UPDATE connections SET provider='cloudflare-worker-tail' WHERE id=?").bind(f.connection.id).run();else await updateConnectionCredentials(env.DB,settings,f.userId,f.connection.id,{credentials:{[field]:"new-access"}});}return bound.first();}};}};};}});
  const response=await request(route,`Bearer ${f.token}`,{DB:db});expect(reads).toBe(2);expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"refresh_failed",message:"could not refresh token"});
 }
 error.mockRestore();
});
