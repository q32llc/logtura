import { describe,expect,it,vi } from "vitest";
import { authorizeCliDevice,LogturaServiceClient,normalizeServiceUrl,ServiceError } from "../src/service-client";
const device={deviceCode:"D".repeat(43),userCode:"ABCD-EFGH",verificationUri:"https://fixture.test/app/cli?code=ABCD-EFGH",expiresIn:600,interval:5};
const credential={token:"lt_cli_"+"T".repeat(43),expiresAt:Date.now()+90_000,scope:"account:read account:write"};
function client(responses:Response[],token?:string) {const fetchImpl=vi.fn(async()=>{const response=responses.shift();if(!response)throw new Error("unexpected request");return response;});return {client:new LogturaServiceClient({url:"https://fixture.test",token,fetch:fetchImpl}),fetch:fetchImpl};}
describe("optional service transport",()=>{
 it("sends credentials only to the configured origin with redirects and cookies disabled",async()=>{
  const transport=client([Response.json({user:{id:"usr_fixture",githubLogin:"fixture"}})],credential.token);expect((await transport.client.whoami()).id).toBe("usr_fixture");
  const [url,init]=transport.fetch.mock.calls[0]! as unknown as [string,RequestInit];expect(url).toBe("https://fixture.test/api/me");expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${credential.token}`);expect(init.credentials).toBe("omit");expect(init.redirect).toBe("manual");expect(init.signal).toBeInstanceOf(AbortSignal);
 });
 it.each(["https://user:pass@fixture.test","http://remote.test","https://fixture.test/path","https://fixture.test?x=1","https://fixture.test#fragment","ftp://fixture.test"])("rejects unsafe service URL %s",url=>{expect(()=>normalizeServiceUrl(url)).toThrow();});
 it.each(["http://localhost:8787","http://127.0.0.1","http://[::1]:8787","https://fixture.test/"])("accepts service origin %s",url=>{expect(normalizeServiceUrl(url)).toBe(new URL(url).origin);});
 it.each(["https://evil.test","//evil.test","/../outside"])("rejects paths outside the API: %s",async path=>{const transport=client([]);await expect(transport.client.request(path)).rejects.toThrow("Invalid service API path");expect(transport.fetch).not.toHaveBeenCalled();});
 it("handles pending, backoff and successful delivery without leaking tokens",async()=>{
  const transport=client([Response.json(device),Response.json({error:"authorization_pending"},{status:202}),Response.json({error:"slow_down"},{status:429}),Response.json(credential)]);
  let now=0;const delays:number[]=[];const show=vi.fn();const issued=await authorizeCliDevice(transport.client,"My terminal",{show,now:()=>now,sleep:async ms=>{delays.push(ms);now+=ms;}});
  expect(issued).toEqual(credential);expect(show).toHaveBeenCalledWith(device);expect(delays).toEqual([5000,10000]);
 });
 it("stops expired authorization and accounts for time spent opening the browser",async()=>{
  const transport=client([Response.json({...device,expiresIn:1}),Response.json({error:"authorization_pending"},{status:202})]);let now=0;
  await expect(authorizeCliDevice(transport.client,"terminal",{show:()=>{},now:()=>now,sleep:async ms=>{now+=ms;}})).rejects.toMatchObject({code:"authorization_expired",status:410});
  const delayed=client([Response.json({...device,expiresIn:1})]);now=0;
  await expect(authorizeCliDevice(delayed.client,"terminal",{show:()=>{now=1001;},now:()=>now,sleep:async()=>{}})).rejects.toBeInstanceOf(ServiceError);
  expect(delayed.fetch).toHaveBeenCalledTimes(1);
 });
 it.each([400,403,410,500])("reports authorization failure %s",async status=>{const transport=client([Response.json({error:"denied"},{status})]);await expect(transport.client.pollDevice(device.deviceCode)).rejects.toMatchObject({status,code:"denied"});});
 it("fails closed on malformed response bodies and missing identities",async()=>{
  await expect(client([new Response("not-json",{status:500})]).client.request("/me")).rejects.toMatchObject({code:"request_failed"});
  await expect(client([new Response("not-json")]).client.request("/me")).rejects.toMatchObject({code:"invalid_response"});
  await expect(client([Response.json({user:null})]).client.whoami()).rejects.toMatchObject({status:401});
  await expect(client([Response.json({user:{id:42}})]).client.whoami()).rejects.toMatchObject({status:401});
  await expect(client([Response.json({token:"bad"})]).client.pollDevice(device.deviceCode)).rejects.toMatchObject({code:"invalid_credential_response"});
  await expect(client([new Response("broken")]).client.pollDevice(device.deviceCode)).rejects.toMatchObject({code:"invalid_credential_response"});
 });
 it.each([{deviceCode:"bad"},{userCode:"bad"},{expiresIn:0},{expiresIn:4000},{interval:0},{verificationUri:"https://other.test/app/cli"}])("rejects malformed device responses %#",async patch=>{await expect(client([Response.json({...device,...patch})]).client.startDevice("terminal")).rejects.toMatchObject({code:"invalid_device_response"});});
 it("revokes the active credential with an authenticated POST",async()=>{const transport=client([Response.json({ok:true})],credential.token);await transport.client.logout();const [,init]=transport.fetch.mock.calls[0]! as unknown as [string,RequestInit];expect(init.method).toBe("POST");expect(init.body).toBe("{}");});
});

it("rejects non-account credentials before any request",()=>{
 const fetchImpl=vi.fn();expect(()=>new LogturaServiceClient({url:"https://fixture.test",token:"provider-or-reporting-token",fetch:fetchImpl})).toThrow("invalid_account_token");expect(fetchImpl).not.toHaveBeenCalled();
});


it("validates deployment export identity and secret responses",async()=>{
  const document={kind:"logtura.deployment",schema_version:1,connections:[],monitors:[],runtimeEnv:null};
  const base={document,revision:`sha256:${"a".repeat(64)}`,deployment:{id:"dep id",displayName:"Deployment"}};
  const client=(body:unknown)=>new LogturaServiceClient({url:"https://service.test",fetch:async(url)=>{expect(String(url)).toContain("/deployments/dep%20id/config");return Response.json(body);}});
  await expect(client(base).pullDeploymentConfig("dep id")).resolves.toEqual(base);
  await expect(client({...base,secretValues:{KEY:"value"}}).pullDeploymentConfig("dep id",true)).resolves.toHaveProperty("secretValues.KEY","value");
  await expect(client(base).pullDeploymentConfig("")).rejects.toThrow("identity");
  for(const body of [{...base,revision:"bad"},{...base,deployment:null},{...base,deployment:{id:"wrong",displayName:"Name"}},{...base,deployment:{id:"dep id",displayName:12}},base,{...base,secretValues:[]},{...base,secretValues:"bad"},{...base,secretValues:{KEY:12}}])await expect(client(body).pullDeploymentConfig("dep id",true)).rejects.toThrow("invalid_config_response");
});
