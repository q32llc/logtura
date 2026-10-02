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
 await api.updateDeployment("dep",{displayName:"Website update",sourceIds:["src_site"]});expect(fetch.mock.calls[0]).toEqual(["/api/deployments/dep",{credentials:"include",headers:{accept:"application/json","content-type":"application/json"},method:"PUT",body:JSON.stringify({displayName:"Website update",sourceIds:["src_site"]})}]);
 const form=new FormData();form.set("api_token","private-test-token");await api.createConnection(form);expect(fetch.mock.calls[1]).toEqual(["/api/connections",{credentials:"include",headers:{accept:"application/json"},method:"POST",body:form}]);
});
