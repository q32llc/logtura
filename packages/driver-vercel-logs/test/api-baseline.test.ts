import {afterEach,expect,it,vi} from "vitest";
import {ProviderError} from "@logtura/core";
import {vercelLogsDriver as driver} from "../src/index";
afterEach(()=>vi.restoreAllMocks());
const credentials={apiToken:"fixture-token"};
const connection={id:"con",externalAccountId:"team",displayName:"Vercel"};
const source=(id:string)=>({id,externalId:id,sourceKind:"vercel_project",displayName:id,metadata:null});
it("verifies authenticated personal profiles with username/name/id/default fallbacks",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch");
 for(const [body,expected] of [[{user:{uid:"uid",username:"user"}},[{id:"uid",name:"user"}]],[{user:{uid:"uid",name:"Name"}},[{id:"uid",name:"Name"}]],[{user:{uid:"uid"}},[{id:"uid",name:"uid"}]],[{},[{id:"vercel",name:"vercel"}]],[{user:null},[{id:"vercel",name:"vercel"}]]] as const){
  fetch.mockResolvedValueOnce(Response.json(body));expect(await driver.verifyCredentials(credentials)).toEqual(expected);
 }
 for(const [input,init] of fetch.mock.calls){expect(String(input)).toBe("https://api.vercel.com/v2/user");expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");expect(new Headers(init?.headers).get("accept")).toBe("application/json");}
});
it("scopes project requests to teams while preserving personal defaults and metadata",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch");
 fetch.mockResolvedValueOnce(Response.json({projects:[null,{}, {id:""},{id:42},{id:"prj",name:"Project",framework:"nextjs",updatedAt:0},{id:"fallback"}]}));
 expect(await driver.discoverSources({credentials,accountId:"team /fixture"})).toEqual([{sourceKind:"vercel_project",externalId:"prj",displayName:"Project",metadata:{framework:"nextjs",updated_at:0}},{sourceKind:"vercel_project",externalId:"fallback",displayName:"fallback",metadata:{framework:null,updated_at:null}}]);
 const url=new URL(String(fetch.mock.calls[0]![0]));expect(url.searchParams.get("teamId")).toBe("team /fixture");expect(url.searchParams.get("limit")).toBe("100");
 for(const body of [{},{projects:null}]){fetch.mockResolvedValueOnce(Response.json(body));expect(await driver.discoverSources({credentials,accountId:""})).toEqual([]);expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.has("teamId")).toBe(false);}
 fetch.mockResolvedValueOnce(Response.json({projects:42}));await expect(driver.discoverSources({credentials,accountId:""})).rejects.toMatchObject({status:502});
});
it("rejects HTTP/JSON/envelope failures without echoing private provider bodies",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch");
 for(const operation of [()=>driver.verifyCredentials(credentials),()=>driver.discoverSources({credentials,accountId:"team"})]){
  for(const response of [new Response("fixture-private",{status:403}),new Response(null,{status:503}),new Response("fixture-private"),Response.json(null),Response.json([]),Response.json(42)]){
   fetch.mockResolvedValueOnce(response);const error=await operation().then(()=>undefined,error=>error);expect(error).toBeInstanceOf(ProviderError);expect(String(error)).not.toContain("fixture-private");
  }
 }
});
it("renders empty and multiple project selections and rejects unsupported kinds",()=>{
 const empty=driver.generatePipeline({connection,selection:{kind:"list",sources:[]}});expect(empty.components).toEqual([]);expect(empty.manifest).toEqual([]);expect(empty.runtimeAssets).toHaveLength(1);
 const multiple=driver.generatePipeline({connection,selection:{kind:"list",sources:[source("one"),source("two")]}});expect(multiple.manifest?.find(row=>row.id==="vercel_con_by_project")?.detail).toBe("2 projects");
 expect(()=>driver.generatePipeline({connection,selection:{kind:"list",sources:[{...source("one"),sourceKind:"invalid"}]}})).toThrow("Unknown Vercel source kind");
});
