import {afterEach,expect,it,vi} from "vitest";
import {ProviderError} from "@logtura/core";
import {flyAuthHeader,flyLogTailDriver} from "../src/index";
afterEach(()=>vi.restoreAllMocks());
const credentials={apiToken:"fo1_fixture, fm2_fixture"};
const list=()=>flyLogTailDriver.discoverSources({credentials,accountId:"org /fixture"});
it("classifies permission bundles and sends the authenticated organization query",async()=>{
 expect(flyAuthHeader(credentials.apiToken)).toBe(`FlyV1 ${credentials.apiToken}`);
 const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  expect(String(input)).toBe("https://api.fly.io/graphql");expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("authorization")).toBe(`FlyV1 ${credentials.apiToken}`);
  expect(JSON.parse(String(init?.body))).toMatchObject({variables:{admin:false}});
  return Response.json({data:{organizations:{nodes:[null,{}, {slug:42},{slug:""},{slug:"personal"},{slug:"team"}]}},errors:[]});
 });
 expect(await flyLogTailDriver.verifyCredentials(credentials)).toEqual([{id:"personal",name:"personal"},{id:"team",name:"team"}]);expect(fetch).toHaveBeenCalledOnce();
});
it("rejects empty inventories while retaining missing/null organization response defaults",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch");
 for(const body of [{},{data:null},{data:{}},{data:{organizations:{}}},{data:{organizations:{nodes:[]}}}]){
  fetch.mockResolvedValueOnce(Response.json(body));await expect(flyLogTailDriver.verifyCredentials(credentials)).rejects.toMatchObject({status:403});
 }
 fetch.mockResolvedValueOnce(Response.json({data:{organizations:{nodes:42}}}));await expect(flyLogTailDriver.verifyCredentials(credentials)).rejects.toMatchObject({status:502});
});
it("sanitizes HTTP, malformed JSON/envelope and GraphQL error bodies",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch");
 for(const operation of [()=>flyLogTailDriver.verifyCredentials(credentials),list]){
  for(const response of [new Response("fixture-private",{status:403}),new Response(null,{status:503}),new Response("fixture-private"),Response.json(null),Response.json([]),Response.json(42)]){
   fetch.mockResolvedValueOnce(response);const error=await operation().then(()=>undefined,error=>error);expect(error).toBeInstanceOf(ProviderError);expect(String(error)).not.toContain("fixture-private");
  }
 }
 for(const errors of [[{message:"fixture-private"}],{message:"fixture-private"}]){
  fetch.mockResolvedValueOnce(Response.json({errors}));await expect(flyLogTailDriver.verifyCredentials(credentials)).rejects.toThrow("Fly GraphQL request failed");
 }
});
it("maps app IDs/names/counts, skips invalid identities and URL-encodes the selected org",async()=>{
 vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  expect(String(input)).toBe("https://api.machines.dev/v1/apps?org_slug=org%20%2Ffixture");expect(new Headers(init?.headers).get("authorization")).toBe(`FlyV1 ${credentials.apiToken}`);
  return Response.json({apps:[null,{}, {name:""},{name:42},{id:"legacy",machine_count:0},{name:"named",machine_count:3}]});
 });
 expect(await list()).toEqual([{sourceKind:"fly_app",externalId:"legacy",displayName:"legacy",metadata:{machine_count:0}},{sourceKind:"fly_app",externalId:"named",displayName:"named",metadata:{machine_count:3}}]);
});
it("accepts absent app inventories and rejects malformed collection shapes",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch");for(const body of [{},{apps:null}]){fetch.mockResolvedValueOnce(Response.json(body));expect(await list()).toEqual([]);}
 fetch.mockResolvedValueOnce(Response.json({apps:42}));await expect(list()).rejects.toMatchObject({status:502});
});
it("supports an empty pipeline and declares every executable dependency",()=>{
 const pipeline=flyLogTailDriver.generatePipeline({connection:{id:"con",externalAccountId:"personal",displayName:"Fly"},selection:{kind:"list",sources:[]}});
 expect(pipeline.components).toEqual([]);expect(pipeline.manifest).toEqual([]);expect(pipeline.dockerfileDeps[0]?.aptPackages).toContain("jq");
});
