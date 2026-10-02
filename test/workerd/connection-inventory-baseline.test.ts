import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { createConnection, getConnection, upsertSources, updateConnectionCredentials, decryptConnectionCredentials } from "../../src/db";
import { verifyTailToken } from "../../src/providers/tail-token";
import { readConfigurationVersion } from "../../src/config-version";
import { mockFetch, seedUser } from "./_setup";
async function request(path: string, cookie?: string, method = "GET", body?: unknown, overrides: Partial<Env> = {}) {
 const context = createExecutionContext();
 const response = await worker.fetch(new Request(`http://localhost/api${path}`, {method, headers: {...(cookie ? {cookie} : {}), ...(body !== undefined ? {"content-type":"application/json"} : {})}, body: body === undefined ? undefined : JSON.stringify(body)}), {...env,...overrides}, context);
 await waitOnExecutionContext(context);return response;
}
async function fixture(provider = "supabase-edge-logs", credentials?: unknown, account: string | null = null) {
 const user = await seedUser();
 const created = await createConnection(env.DB, env, {userId:user.userId, provider, displayName:"Fixture", externalAccountId:account, credentials:credentials ?? (provider === "supabase-edge-logs" ? {pat:"fixture-token"} : {apiToken:"fixture-token"})});
 return {...user, connection:(await getConnection(env.DB,user.userId,created.id))!};
}
const pickers = [{provider:"supabase-edge-logs",path:"supabase-pick-project",body:{projectRef:"abcdefghijklmnopqrst"},account:"abcdefghijklmnopqrst",field:"pat"}, {provider:"railway-logs",path:"railway-pick-environment",body:{projectId:"project-fixture",environmentId:"environment-fixture"},account:"project-fixture:environment-fixture",field:"apiToken"}];
it("lists only owned connections/sources and scopes installation lookups", async () => {
 const own = await fixture("cloudflare-worker-tail", undefined, "account"), other = await fixture("cloudflare-worker-tail", undefined, "other-account");
 await env.DB.prepare("UPDATE connections SET provider_installation_id='fixture-installation' WHERE id IN (?,?)").bind(own.connection.id,other.connection.id).run();
 await upsertSources(env.DB,own.connection.id,[{sourceKind:"worker",externalId:"site",displayName:"Site",metadata:{label:"fixture-metadata"}}]);
 await upsertSources(env.DB,other.connection.id,[{sourceKind:"worker",externalId:"other-site",displayName:"Foreign Site",metadata:null}]);
 const connections = await request("/connections",own.sessionCookie);const json = await connections.text();
 expect(json).toContain(own.connection.id);for(const value of [other.connection.id,"fixture-token","credentials_encrypted"]) expect(json).not.toContain(value);
 const catalog = await (await request("/sources",own.sessionCookie)).json() as any;
 expect(catalog.connections).toHaveLength(1);expect(catalog.sources).toHaveLength(1);expect(catalog.sources[0]).toMatchObject({externalId:"site",connectionId:own.connection.id});expect(JSON.stringify(catalog)).not.toContain("fixture-metadata");
 for(const query of ["", "?provider=cloudflare-worker-tail", "?provider_installation_id=fixture-installation", "?provider=railway-logs&provider_installation_id=fixture-installation"]) expect(await (await request(`/connections/by-provider-installation${query}`,own.sessionCookie)).json()).toEqual({connection:null});
 const found = await (await request("/connections/by-provider-installation?provider=cloudflare-worker-tail&provider_installation_id=fixture-installation",own.sessionCookie)).json() as any;expect(found.connection.id).toBe(own.connection.id);
 const detail = await (await request(`/connections/${own.connection.id}`,own.sessionCookie)).json() as any;expect(detail.sources[0].metadata).toEqual({label:"fixture-metadata"});expect(detail.latestDiscoveryJob).toBeNull();
 for(const id of [other.connection.id,"con_missing"]) for(const method of ["GET","POST"]) expect((await request(`/connections/${id}${method === "POST" ? "/discover" : ""}`,own.sessionCookie,method)).status).toBe(404);
});
it("deduplicates real discovery jobs and exposes the latest job on owned details", async () => {
 const own = await fixture("cloudflare-worker-tail",undefined,"account");
 const first = await (await request(`/connections/${own.connection.id}/discover`,own.sessionCookie,"POST")).json() as any;expect(first.deduped).toBe(false);expect(first.job.status).toBe("queued");
 const second = await (await request(`/connections/${own.connection.id}/discover`,own.sessionCookie,"POST")).json() as any;expect(second.deduped).toBe(true);expect(second.job.id).toBe(first.job.id);
 const detail = await (await request(`/connections/${own.connection.id}`,own.sessionCookie)).json() as any;expect(detail.latestDiscoveryJob.id).toBe(first.job.id);
 const noAccount = await fixture();expect(await (await request(`/connections/${noAccount.connection.id}/discover`,noAccount.sessionCookie,"POST")).json()).toEqual({error:"no_account_id"});
 expect((await request(`/connections/${own.connection.id}`,own.sessionCookie,"DELETE")).status).toBe(200);expect(await getConnection(env.DB,own.userId,own.connection.id)).toBeNull();
});
it.each(pickers)("mints a private owner-scoped $provider token using its actual broker URL",async p => {
 const own = await fixture(p.provider),other = await fixture(p.provider);
 const response = await request(`/connections/${own.connection.id}/debug/tail-token`,own.sessionCookie,"POST");expect(response.headers.get("cache-control")).toBe("no-store");
 const body = await response.json() as any;expect(await verifyTailToken(body.tailToken,env.SESSION_SECRET)).toEqual({connectionId:own.connection.id,userId:own.userId});expect(body.tailTokenUrl).toBe(`${env.APP_URL}/api/tail/${p.provider === "railway-logs" ? "railway" : "supabase"}/token`);
 expect((await request(`/connections/${other.connection.id}/debug/tail-token`,own.sessionCookie,"POST")).status).toBe(404);
 const wrong = await fixture("cloudflare-worker-tail");expect((await request(`/connections/${wrong.connection.id}/debug/tail-token`,wrong.sessionCookie,"POST")).status).toBe(400);
});
it.each(pickers)("selects an owned $provider scope, keeps credentials and enqueues discovery",async p => {
 const own = await fixture(p.provider),version=await readConfigurationVersion(env.DB,own.userId);
 const response = await request(`/connections/${own.connection.id}/${p.path}`,own.sessionCookie,"POST",p.body);expect(response.status).toBe(200);
 const current = (await getConnection(env.DB,own.userId,own.connection.id))!;expect(current.external_account_id).toBe(p.account);expect(await decryptConnectionCredentials(env,current)).toMatchObject({[p.field]:"fixture-token"});expect(await readConfigurationVersion(env.DB,own.userId)).toBeGreaterThan(version);
 expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND kind='discovery'").bind(own.userId).first("n")).toBe(1);
});
it.each(pickers)("rejects foreign, wrong-provider and malformed $provider picker input without writes",async p => {
 const own=await fixture(p.provider),other=await fixture(p.provider),wrong=await fixture("cloudflare-worker-tail");
 expect((await request(`/connections/${other.connection.id}/${p.path}`,own.sessionCookie,"POST",p.body)).status).toBe(404);expect((await request(`/connections/${wrong.connection.id}/${p.path}`,wrong.sessionCookie,"POST",p.body)).status).toBe(400);
 const version=await readConfigurationVersion(env.DB,own.userId);
 for(const body of [null,[],42,{},...(p.field === "pat" ? [42,"","BAD","short"].map(projectRef=>({projectRef})) : [{projectId:42,environmentId:"valid"},{projectId:"valid",environmentId:42},{projectId:"",environmentId:"valid"},{projectId:"valid",environmentId:"invalid/path"}])]) expect((await request(`/connections/${own.connection.id}/${p.path}`,own.sessionCookie,"POST",body)).status).toBe(400);
 expect(await readConfigurationVersion(env.DB,own.userId)).toBe(version);expect((await getConnection(env.DB,own.userId,own.connection.id))!.external_account_id).toBeNull();
});
it.each(pickers)("does not replace a credential rotated immediately after the $provider picker read",async p => {
 const own=await fixture(p.provider);let raced=false;
 const database = new Proxy(env.DB,{get(target,key){if(key !== "prepare"){const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}return (sql:string)=>{const stmt=target.prepare(sql);if(!sql.includes("SELECT * FROM connections WHERE id = ? AND user_id = ?"))return stmt;return new Proxy(stmt,{get(statement,property){if(property !== "bind"){const value=Reflect.get(statement,property);return typeof value === "function" ? value.bind(statement) : value;}return (...values:any[])=>{const bound=statement.bind(...values);return new Proxy(bound,{get(prepared,field){if(field !== "first"){const value=Reflect.get(prepared,field);return typeof value === "function" ? value.bind(prepared) : value;}return async()=>{const row=await prepared.first();if(!raced){raced=true;await updateConnectionCredentials(env.DB,env,own.userId,own.connection.id,{credentials:{[p.field]:"rotated-token"}});}return row;};}});};}});};}}) as D1Database;
 expect((await request(`/connections/${own.connection.id}/${p.path}`,own.sessionCookie,"POST",p.body,{DB:database})).status).toBe(404);
 const current=(await getConnection(env.DB,own.userId,own.connection.id))!;expect(await decryptConnectionCredentials(env,current)).toEqual({[p.field]:"rotated-token"});expect(current.external_account_id).toBeNull();
 expect(await updateConnectionCredentials(env.DB,env,own.userId,"con_wrong",{credentials:{},expectedConnection:current})).toBeNull();expect(await updateConnectionCredentials(env.DB,env,"usr_wrong",current.id,{credentials:{},expectedConnection:current})).toBeNull();
});
it("enriches Supabase projects while allowing unavailable or malformed function counts",async()=>{
 const own=await fixture();const projects=["one","two","three","four","five"].map((ref,i)=>({ref,name:`Project ${i}`,...(i === 0 ? {organization_id:"org"} : {})}));
 mockFetch("https://api.supabase.com/v1/projects",req=>{expect(req.headers.get("authorization")).toBe("Bearer fixture-token");if(req.url.endsWith("/functions")){const ref=req.url.split("/").at(-2);return ref === "one" ? Response.json([{},{}]) : ref === "two" ? new Response("private-error",{status:403}) : ref === "three" ? Response.json({unexpected:true}) : ref === "four" ? new Response("not-json") : Response.json([]);}return Response.json(projects);});
 const response=await request(`/connections/${own.connection.id}/supabase-projects`,own.sessionCookie);expect(response.status).toBe(200);const body=await response.json() as any;expect(body.projects.map((p:any)=>p.functionCount)).toEqual([2,null,null,null,0]);expect(body.projects[0].organizationId).toBe("org");expect(body.projects[1].organizationId).toBeNull();
});
it("returns stable Supabase list and renewal failures without provider body disclosure",async()=>{
 const own=await fixture();const logger=vi.spyOn(console,"error").mockImplementation(()=>{});
 for(const payload of [null,{},[null],[{ref:42,name:"Name"}],[{ref:"ref",name:42}],"private-invalid-json"]){mockFetch("https://api.supabase.com/v1/projects",()=>typeof payload === "string" ? new Response(payload) : Response.json(payload));const response=await request(`/connections/${own.connection.id}/supabase-projects`,own.sessionCookie);expect(response.status).toBe(400);expect(await response.json()).toEqual({error:"list_failed",message:"Failed to list Supabase projects"});}
 mockFetch("https://api.supabase.com/v1/projects",()=>new Response("private-http-body",{status:403}));expect(await (await request(`/connections/${own.connection.id}/supabase-projects`,own.sessionCookie)).json()).toEqual({error:"list_failed",message:"HTTP 403"});
 const expired=await fixture("supabase-edge-logs",{pat:"expired",refreshToken:"refresh",expiresAt:1});expect((await request(`/connections/${expired.connection.id}/supabase-projects`,expired.sessionCookie)).status).toBe(400);expect(JSON.stringify(logger.mock.calls)).not.toContain("private");logger.mockRestore();
});
it.each([true,false])("lists Railway environments via scoped/account fallback (scoped=%s)",async scoped=>{
 const own=await fixture("railway-logs");mockFetch("https://backboard.railway.com/graphql/v2",async req=>{expect(req.headers.get("authorization")).toBe("Bearer fixture-token");const {query,variables}=await req.json() as any;
 if(query.includes("ExternalProjects"))return Response.json({data:{externalWorkspaces:scoped ? [{projects:[null,{id:"project",name:"Project"},{}]}] : []}});
 if(query.includes("query Projects"))return Response.json({data:{projects:{edges:[{node:{id:"project"}},{}, {node:{}}]}}});
 expect(variables).toEqual({projectId:"project"});return Response.json({data:{project:{environments:{edges:[{node:{id:"env",name:"Environment",serviceInstances:{edges:[{},{}]}}},{node:{id:"env2"}},{}, {node:{}}]}}}});});
 const response=await request(`/connections/${own.connection.id}/railway-environments`,own.sessionCookie);expect(response.status).toBe(200);expect(await response.json()).toEqual({projects:[{id:"project",name:scoped ? "Project" : "project",environments:[{id:"env",name:"Environment",serviceCount:2},{id:"env2",name:"env2",serviceCount:null}]}]});
});
it("handles Railway provider failures without exposing raw errors",async()=>{
 const own=await fixture("railway-logs");mockFetch("https://backboard.railway.com/graphql/v2",()=>new Response("private-provider-body",{status:403}));const logger=vi.spyOn(console,"error").mockImplementation(()=>{});
 const response=await request(`/connections/${own.connection.id}/railway-environments`,own.sessionCookie);expect(response.status).toBe(400);expect(await response.json()).toEqual({error:"list_failed",message:"Failed to list Railway environments"});expect(JSON.stringify(logger.mock.calls)).not.toContain("private-provider-body");
 const expired=await fixture("railway-logs",{apiToken:"expired",refreshToken:"refresh",expiresAt:1});expect((await request(`/connections/${expired.connection.id}/railway-environments`,expired.sessionCookie)).status).toBe(400);logger.mockRestore();
});
it("scopes both provider list routes and requires an authenticated user",async()=>{
 const own=await fixture(),foreign=await fixture();
 for(const route of ["supabase-projects","railway-environments"]){expect((await request(`/connections/${foreign.connection.id}/${route}`,own.sessionCookie)).status).toBe(404);const wrong=await fixture("cloudflare-worker-tail");expect((await request(`/connections/${wrong.connection.id}/${route}`,wrong.sessionCookie)).status).toBe(400);expect((await request(`/connections/${own.connection.id}/${route}`)).status).toBe(303);}
});
