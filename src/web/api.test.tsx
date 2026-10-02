import { afterEach,expect,it,vi } from "vitest";
import { hashConfigDocument } from "@logtura/core";
import { api,ApiError } from "./api";
afterEach(()=>vi.unstubAllGlobals());
async function fixture(){const document={kind:"logtura.deployment" as const,schema_version:1 as const,connections:[],monitors:[],runtimeEnv:null},revision=await hashConfigDocument(document);return {desired:{sequence:1,document,revision,configurationVersion:4},applied:null,activeInstanceId:null,lastReportSequence:0,stale:false};}
it("reads validated public deployment revisions with session auth and an encoded deployment ID",async()=>{
 const state=await fixture(),fetch=vi.fn(async()=>Response.json({state}));vi.stubGlobal("fetch",fetch);expect(await api.getDeploymentConfigurationState("dep id/?")).toEqual(state);const [url,init]=fetch.mock.calls[0]! as unknown as [string,RequestInit];expect(url).toBe("/api/deployments/dep%20id%2F%3F/config/state");expect(init).toMatchObject({credentials:"include",headers:{accept:"application/json"}});expect(init.signal).toBeInstanceOf(AbortSignal);
 fetch.mockResolvedValueOnce(Response.json({state:null}));expect(await api.getDeploymentConfigurationState("dep")).toBeNull();
});
it("rejects malformed or private-bearing status replies without exposing response values",async()=>{
 const state=await fixture();
 for(const body of [null,0,2,[],{}, {state:null,private:"private-payload"},{state:{}},{state:{...state,desired:{...state.desired,revision:`sha256:${"b".repeat(64)}`}}},{state:{...state,private:"private-payload"}}]){
  vi.stubGlobal("fetch",async()=>Response.json(body));await expect(api.getDeploymentConfigurationState("dep")).rejects.toMatchObject({status:200,code:"invalid_config_state",message:"Invalid configuration status"});
 }
 vi.stubGlobal("fetch",async()=>new Response("private-non-json"));await expect(api.getDeploymentConfigurationState("dep")).rejects.toBeInstanceOf(ApiError);
});
it("distinguishes expired sessions, missing deployments and service outages from valid legacy status",async()=>{
 for(const [status,body,message,code] of [[401,{error:"auth_required"},"auth_required","auth_required"],[404,{error:"not_found",message:"Deployment not found"},"Deployment not found","not_found"],[503,{},"HTTP 503",undefined]] as const){
  vi.stubGlobal("fetch",async()=>Response.json(body,{status}));await expect(api.getDeploymentConfigurationState("dep")).rejects.toMatchObject({status,message,code});
 }
 vi.stubGlobal("fetch",async()=>new Response("broken-error-response",{status:503}));await expect(api.getDeploymentConfigurationState("dep")).rejects.toMatchObject({status:503,message:"HTTP 503"});
 vi.stubGlobal("fetch",async()=>{throw new Error("Network unavailable");});await expect(api.getDeploymentConfigurationState("dep")).rejects.toThrow("Network unavailable");
});
it("preserves JSON and multipart mutation transport when the shared reader changes",async()=>{
 const fetch=vi.fn(async()=>Response.json({ok:true}));vi.stubGlobal("fetch",fetch);
 await api.updateDeployment("dep",{displayName:"Website update",sourceIds:["src_site"]});expect(fetch.mock.calls[0]).toEqual(["/api/deployments/dep",{credentials:"include",signal:expect.any(AbortSignal),headers:{accept:"application/json","content-type":"application/json"},method:"PUT",body:JSON.stringify({displayName:"Website update",sourceIds:["src_site"]})}]);
 const form=new FormData();form.set("api_token","private-test-token");await api.createConnection(form);expect(fetch.mock.calls[1]).toEqual(["/api/connections",{credentials:"include",signal:expect.any(AbortSignal),headers:{accept:"application/json"},method:"POST",body:form}]);
});
it("rejects successful non-JSON mutation responses instead of declaring them complete",async()=>{
 vi.stubGlobal("fetch",async()=>new Response("private-html-response",{status:200}));
 await expect(api.deleteDeployment("dep")).rejects.toMatchObject({message:"Invalid response from Logtura",status:200,code:"invalid_response"});
});
it("keeps path identifiers as single URL segments rather than allowing them to select another endpoint",async()=>{
 const fetch=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({ok:true}));vi.stubGlobal("fetch",fetch);
 await api.deleteDeployment("dep /?secret=#fragment");expect(fetch.mock.calls[0]?.[0]).toBe("/api/deployments/dep%20%2F%3Fsecret%3D%23fragment");
 expect(api.installBundleUrl("dep /?secret=#fragment")).toBe("/api/deployments/dep%20%2F%3Fsecret%3D%23fragment/install-bundle.tgz");
});
it("bounds mutation requests and preserves an aborted fetch without retrying it",async()=>{
 const controller=new AbortController(),reason=new DOMException("Operation timed out","TimeoutError");
 const timeout=vi.spyOn(AbortSignal,"timeout").mockReturnValue(controller.signal);
 const fetch=vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener("abort",()=>reject(init!.signal!.reason),{once:true})));
 vi.stubGlobal("fetch",fetch);
 const pending=api.createMonitor({displayName:"Timed out monitor"});const rejected=expect(pending).rejects.toBe(reason);
 controller.abort(reason);await rejected;expect(fetch).toHaveBeenCalledTimes(1);expect(timeout).toHaveBeenCalledWith(20_000);
});
it("preserves an abort during response-body reading instead of misclassifying it as malformed JSON",async()=>{
 const controller=new AbortController(),reason=new DOMException("Operation timed out","TimeoutError");
 vi.spyOn(AbortSignal,"timeout").mockReturnValue(controller.signal);
 const response=Response.json({deployment:{}});vi.spyOn(response,"json").mockImplementation(async()=>{controller.abort(reason);throw reason;});
 vi.stubGlobal("fetch",async()=>response);
 await expect(api.updateDeployment("dep",{displayName:"Uncertain mutation"})).rejects.toBe(reason);
});
