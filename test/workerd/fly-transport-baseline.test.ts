import {expect,it,vi} from "vitest";
import {FlyApiError,flyAuthHeader,getFlyApp,createFlyApp,listFlyMachines,startFlyMachine,resolveFlyOrgSlug,listFlyOrgs,createLimitedAccessToken} from "../../src/deploy-targets/fly-machines";
import {mockFetch} from "./_setup";
const auth="FlyV1 fm2_fixture-secret";
const app="fixture-app";
it("classifies Fly permission bundles without logging the authorization value",()=>{
 for(const token of ["fm1r_fixture","fm2_fixture","fo1_fixture, fm2_fixture"])expect(flyAuthHeader(token)).toBe(`FlyV1 ${token}`);
 expect(flyAuthHeader("fo1_fixture")).toBe("Bearer fo1_fixture");
});
it("reads present/absent apps and legacy machine inventory with the expected headers",async()=>{
 const logger=vi.spyOn(console,"log").mockImplementation(()=>{});
 mockFetch("https://api.machines.dev",req=>{expect(req.headers.get("authorization")).toBe(auth);expect(req.headers.get("accept")).toBe("application/json");expect(req.method).toBe("GET");return req.url.endsWith("/machines")?Response.json([{id:"legacy",state:"stopped",config:{image:"legacy"}}]):Response.json({name:app,organization:{slug:"personal"}});});
 expect(await getFlyApp(auth,app)).toEqual({name:app,organization:{slug:"personal"}});expect(await listFlyMachines(auth,app)).toEqual([{id:"legacy",state:"stopped",config:{image:"legacy"}}]);
 mockFetch("https://api.machines.dev",()=>new Response(null,{status:404}));expect(await getFlyApp(auth,app)).toBeNull();expect(JSON.stringify(logger.mock.calls)).not.toContain("fm2_fixture-secret");logger.mockRestore();
});
it.each([200,201,409,422])("creates an app or handles an already-created race (HTTP %s)",async status=>{
 mockFetch("https://api.machines.dev/v1/apps",async req=>{expect(req.method).toBe("POST");expect(req.headers.get("authorization")).toBe(auth);expect(req.headers.get("content-type")).toBe("application/json");expect(await req.json()).toEqual({app_name:app,org_slug:"personal"});return status<300?Response.json({}, {status}):new Response("Name already exists",{status});});
 await expect(createFlyApp(auth,{appName:app,orgSlug:"personal"})).resolves.toBeUndefined();
});
it("reports HTTP failures without retaining or logging the private body",async()=>{
 const logger=vi.spyOn(console,"warn").mockImplementation(()=>{});
 for(const status of [403,409,422]){mockFetch("https://api.machines.dev",()=>new Response("fixture-private-response-body",{status}));
 for(const operation of [()=>getFlyApp(auth,app),()=>listFlyMachines(auth,app),()=>createFlyApp(auth,{appName:app,orgSlug:"personal"}),()=>startFlyMachine(auth,{appName:app,machineId:"legacy"})]){
  try{await operation();throw new Error("Expected provider failure");}catch(error){expect(error).toBeInstanceOf(FlyApiError);expect(error).toMatchObject({status});expect(String(error)).not.toContain("fixture-private-response-body");expect(JSON.stringify(error)).not.toContain("fixture-private-response-body");}
 }}
 mockFetch("https://api.machines.dev",()=>new Response(null,{status:500}));await expect(getFlyApp(auth,app)).rejects.toMatchObject({status:500});expect(JSON.stringify(logger.mock.calls)).not.toContain("fixture-private-response-body");logger.mockRestore();
});
it("sanitizes malformed successful REST responses",async()=>{
 mockFetch("https://api.machines.dev",()=>new Response("fixture-private-invalid-json"));await expect(getFlyApp(auth,app)).rejects.toThrow("Invalid Fly response");await expect(listFlyMachines(auth,app)).rejects.toThrow("Invalid Fly response");
});
it.each([200,201,412])("retains the legacy machine-start result and soft precondition behavior (HTTP %s)",async status=>{
 const logger=vi.spyOn(console,"warn").mockImplementation(()=>{});
 mockFetch("https://api.machines.dev",req=>{expect(req.url).toBe(`https://api.machines.dev/v1/apps/${app}/machines/legacy/start`);expect(req.method).toBe("POST");expect(req.headers.has("content-type")).toBe(false);return new Response("fixture-start-body",{status});});
 expect(await startFlyMachine(auth,{appName:app,machineId:"legacy"})).toEqual({ok:status!==412,status,bodySnippet:"fixture-start-body"});expect(JSON.stringify(logger.mock.calls)).not.toContain("fixture-start-body");logger.mockRestore();
});
function graphql(payload:unknown,status=200){mockFetch("https://api.fly.io/graphql",async req=>{expect(req.headers.get("authorization")).toBe(auth);expect(req.method).toBe("POST");const body=await req.json() as any;if(body.query.includes("organizations"))expect(body.variables).toEqual({admin:false});return typeof payload === "string"?new Response(payload,{status}):Response.json(payload,{status});});}
it("selects a personal/fallback org and returns only valid IDs/slugs",async()=>{
 graphql({data:{organizations:{nodes:[null,{}, {slug:42},{slug:""},{slug:"team",id:"team-id"},{slug:"personal",id:"personal-id"},{slug:"bad-id",id:42},{slug:"empty-id",id:""},{slug:"",id:"missing-slug"}]}}});expect(await resolveFlyOrgSlug(auth)).toBe("personal");expect(await listFlyOrgs(auth)).toEqual([{id:"team-id",slug:"team"},{id:"personal-id",slug:"personal"}]);
 graphql({data:{organizations:{nodes:[{slug:"team",id:"team-id"}]}}});expect(await resolveFlyOrgSlug(auth)).toBe("team");
 for(const payload of [{},{data:null},{data:{}},{data:{organizations:{}}}]){graphql(payload);await expect(resolveFlyOrgSlug(auth)).rejects.toThrow("no usable org");expect(await listFlyOrgs(auth)).toEqual([]);}
 graphql({data:{organizations:{nodes:{private:"fixture"}}}});await expect(resolveFlyOrgSlug(auth)).rejects.toThrow("Invalid Fly organization inventory");await expect(listFlyOrgs(auth)).rejects.toThrow("Invalid Fly organization inventory");
});
it("mints using explicit/default profile parameters and rejects empty or non-string returned tokens",async()=>{
 for(const custom of [false,true]){mockFetch("https://api.fly.io/graphql",async req=>{const body=await req.json() as any;expect(body.variables.input).toEqual({name:"Fixture",organizationId:"org-id",profile:"deploy_organization",profileParams:custom?{app:"fixture"}:{},expiry:custom?"24h":"175200h"});return Response.json({data:{createLimitedAccessToken:{limitedAccessToken:{tokenHeader:"fm2_fixture-token"}}},errors:custom?[]:null});});expect(await createLimitedAccessToken(auth,{name:"Fixture",organizationId:"org-id",profile:"deploy_organization",...(custom?{profileParams:{app:"fixture"},expiry:"24h"}:{})})).toBe("fm2_fixture-token");}
 for(const payload of [{},{data:{}},{data:{createLimitedAccessToken:{}}},{data:{createLimitedAccessToken:{limitedAccessToken:{}}}},...["",42,null].map(tokenHeader=>({data:{createLimitedAccessToken:{limitedAccessToken:{tokenHeader}}}}))]){graphql(payload);await expect(createLimitedAccessToken(auth,{name:"Fixture",organizationId:"org-id",profile:"deploy"})).rejects.toThrow("no tokenHeader");}
});
it("returns static GraphQL errors for HTTP, parse, envelope and upstream failures",async()=>{
 const logger=vi.spyOn(console,"warn").mockImplementation(()=>{});const operations=[()=>resolveFlyOrgSlug(auth),()=>listFlyOrgs(auth),()=>createLimitedAccessToken(auth,{name:"Fixture",organizationId:"org",profile:"deploy"})];
 for(const [payload,status] of [["fixture-private-error",403],["fixture-private-error",200],[null,200],[[],200],[42,200],[{errors:[{message:"fixture-private-error"}]},200],[{errors:{private:"fixture-private-error"}},200],[{data:"fixture-private-error"},200],[{data:[]},200]] as const){graphql(payload,status);for(const operation of operations){const error=await operation().then(()=>undefined,error=>error);expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain("fixture-private-error");expect(JSON.stringify(error)).not.toContain("fixture-private-error");}}
 expect(JSON.stringify(logger.mock.calls)).not.toContain("fixture-private-error");logger.mockRestore();
});
