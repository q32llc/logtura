import {afterEach,expect,it,vi} from "vitest";
import {ProviderError} from "@logtura/core";
import {cloudflareWorkerTailDriver} from "../src/index";
afterEach(()=>vi.restoreAllMocks());
const input={credentials:{apiToken:"fixture-token"},accountId:"fixture-account"};
it("retains actionable scope hints and status for provider failures",async()=>{
 vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({success:false,errors:[{message:"Missing fixture scope"}]},{status:403}));
 await expect(cloudflareWorkerTailDriver.discoverSources(input)).rejects.toMatchObject({status:403,message:expect.stringContaining("Workers Scripts:Read")});
});
it("propagates transport failures without converting them into provider-scope errors",async()=>{
 const error=new Error("Fixture network failure");vi.spyOn(globalThis,"fetch").mockRejectedValueOnce(error);
 await expect(cloudflareWorkerTailDriver.discoverSources(input)).rejects.toBe(error);
});
it("handles empty inventories and empty selections",async()=>{
 vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({success:true,result:[]}));
 expect(await cloudflareWorkerTailDriver.discoverSources(input)).toEqual([]);
 const pipeline=cloudflareWorkerTailDriver.generatePipeline({connection:{id:"con",externalAccountId:"fixture-account",displayName:"CF"},selection:{kind:"list",sources:[]}});
 expect(pipeline.components).toEqual([]);expect(pipeline.manifest).toEqual([]);
});
