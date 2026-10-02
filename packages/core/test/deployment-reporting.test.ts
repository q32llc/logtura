import { expect,it,vi } from "vitest";
import { DeploymentReportingClient } from "../src/deployment-reporting";
const report={instanceId:"00000000-0000-4000-8000-000000000001",sequence:1,revision:`sha256:${"a".repeat(64)}`,reportSequence:1};
it("sends validated applied reports only to its configured service with redirects/cookies disabled",async()=>{
 const fetch=vi.fn(async()=>Response.json({accepted:true})),client=new DeploymentReportingClient({url:"https://service.test/",token:"report-token",fetch});expect(await client.reportApplied("dep id",report)).toBe(true);
 const [url,init]=fetch.mock.calls[0]! as unknown as [string,RequestInit];expect(url).toBe("https://service.test/api/applied/dep%20id");expect(init).toMatchObject({method:"POST",redirect:"manual",credentials:"omit"});expect(new Headers(init.headers).get("authorization")).toBe("Bearer report-token");expect(JSON.parse(init.body as string)).toEqual(report);expect(init.signal).toBeInstanceOf(AbortSignal);
 await expect(client.reportApplied("",report)).rejects.toThrow("identity");await expect(client.reportApplied("dep",{...report,reportSequence:0})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects account/unsafe tokens and malformed replies, distinguishes ignored reports and transport errors",async()=>{
 const fetch=vi.fn();for(const token of ["","bad token","bad\0token","lt_cli_"+"T".repeat(43)])expect(()=>new DeploymentReportingClient({url:"https://service.test",token,fetch})).toThrow("reporting token");
 const client=(response:Response)=>new DeploymentReportingClient({url:"https://service.test",token:"report-token",fetch:async()=>response});
 expect(await client(Response.json({accepted:false})).reportApplied("dep",report)).toBe(false);
 for(const body of [null,[],2,{}, {accepted:"yes"},{accepted:true,private:"secret"}])await expect(client(Response.json(body)).reportApplied("dep",report)).rejects.toMatchObject({code:"invalid_applied_response"});
 await expect(client(new Response("bad-json")).reportApplied("dep",report)).rejects.toMatchObject({code:"invalid_applied_response"});
 await expect(client(Response.json({error:"invalid_token"},{status:401})).reportApplied("dep",report)).rejects.toMatchObject({status:401,code:"invalid_token"});
 await expect(client(new Response("bad-json",{status:503})).reportApplied("dep",report)).rejects.toMatchObject({status:503,code:"request_failed"});
});

it("binds a native reporting transport to its global receiver", async () => {
 const transport = vi.fn<typeof fetch>(async function(this: unknown) {
  expect(this).toBe(globalThis); return Response.json({accepted: true});
 });
 const client = new DeploymentReportingClient({url: "https://service.test", token: "report-token", fetch: transport});
 await expect(client.reportApplied("dep", report)).resolves.toBe(true);
 expect(transport).toHaveBeenCalledOnce();
});
