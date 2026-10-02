import {afterEach,expect,it,vi} from "vitest";
import {ProviderError} from "@logtura/core";
import {cloudflareAiGatewayDriver} from "../src/index";
afterEach(()=>vi.restoreAllMocks());
const input={credentials:{apiToken:"fixture-token"},accountId:"fixture-account"};
it("retains actionable scope hints and status for provider failures",async()=>{
 vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({success:false,errors:[{message:"Missing fixture scope"}]},{status:403}));
 await expect(cloudflareAiGatewayDriver.discoverSources(input)).rejects.toMatchObject({status:403,message:expect.stringContaining("AI Gateway:Read")});
});
it("propagates transport failures without converting them into provider-scope errors",async()=>{
 const error=new Error("Fixture network failure");vi.spyOn(globalThis,"fetch").mockRejectedValueOnce(error);
 await expect(cloudflareAiGatewayDriver.discoverSources(input)).rejects.toBe(error);
});
it("handles empty inventories and empty selections",async()=>{
 vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({success:true,result:[]}));
 expect(await cloudflareAiGatewayDriver.discoverSources(input)).toEqual([]);
 const pipeline=cloudflareAiGatewayDriver.generatePipeline({connection:{id:"con",externalAccountId:"fixture-account",displayName:"CF"},selection:{kind:"list",sources:[]}});
 expect(pipeline.components).toEqual([]);expect(pipeline.manifest).toEqual([]);
});
it("renders multiple selected gateways with linked source manifests",()=>{
 const sources=["primary","secondary"].map(id=>({id,externalId:id,displayName:id,sourceKind:"cf_ai_gateway",metadata:null}));
 const pipeline=cloudflareAiGatewayDriver.generatePipeline({connection:{id:"con",externalAccountId:"fixture-account",displayName:"CF"},selection:{kind:"list",sources}});
 expect(pipeline.components.filter(component=>component.kind==="source")).toHaveLength(2);
 expect(pipeline.manifest?.find(component=>component.role==="normalize")?.detail).toBe("2 sources");
 expect(pipeline.manifest?.filter(component=>component.role==="source").map(component=>component.links?.sourceId)).toEqual(["primary","secondary"]);
});
