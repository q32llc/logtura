import {expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {validateFlyBindingRequest,validateFlyBindingReceipt,type FlyBindingRequest} from "../src/fly-binding";
import {LogturaServiceClient} from "../src/service-client";
const digest=`sha256:${"a".repeat(64)}`;
function request():FlyBindingRequest{return {requestId:randomUUID(),instanceId:randomUUID(),expectedConfigurationVersion:7,expectedSequence:2,revision:digest,appName:"app",orgSlug:"personal",region:"iad",previousMachineId:"abc",expectedImageDigest:null,previousImageDigest:digest,previousConfigDigest:digest,machineId:"def",imageDigest:digest};}
function transport(responses:Response[]){const fetch=vi.fn<typeof globalThis.fetch>(async()=>{const response=responses.shift();if(!response)throw new Error("Unexpected request");return response;});return {fetch,client:new LogturaServiceClient({url:"https://service.test",token:`lt_cli_${"a".repeat(43)}`,fetch})};}
it("validates and clones public retained-machine identities with bounded fences",()=>{
 const r=request();expect(validateFlyBindingRequest(r)).toEqual(r);expect(validateFlyBindingRequest(r)).not.toBe(r);
 expect(validateFlyBindingRequest({...r,expectedImageDigest:digest})).toEqual({...r,expectedImageDigest:digest});
 expect(validateFlyBindingReceipt({request:{...r,machineId:r.previousMachineId},configurationVersion:7})).toEqual({request:{...r,machineId:r.previousMachineId},configurationVersion:7});
 expect(validateFlyBindingReceipt({request:r,configurationVersion:8})).toEqual({request:r,configurationVersion:8});
 for(const bad of [null,[],{}, {...r,extra:"secret"},...Object.keys(r).map(k=>({...r,[k]:undefined})),{...r,expectedConfigurationVersion:-1},{...r,expectedConfigurationVersion:0.5},{...r,expectedConfigurationVersion:Number.MAX_SAFE_INTEGER},{...r,expectedSequence:0},{...r,expectedSequence:0.5},{...r,expectedImageDigest:"secret"},{...r,appName:"../../other"},{...r,orgSlug:""},{...r,region:"wrong"},{...r,requestId:"wrong"},{...r,previousMachineId:"machine-with-dashes"}])expect(()=>validateFlyBindingRequest(bad)).toThrow("Invalid Fly binding request");
 for(const bad of [null,[],{}, {request:r,configurationVersion:7},{request:r,configurationVersion:9},{request:r,configurationVersion:8,extra:"secret"}])expect(()=>validateFlyBindingReceipt(bad)).toThrow();
});
it("uses the supplied account transport, encodes identities, and checks exact binding receipts",async()=>{
 const r=request(),receipt={request:r,configurationVersion:8},f=transport([Response.json(receipt),Response.json(receipt),Response.json({binding:receipt}),Response.json({binding:null}),Response.json({error:"receipt_not_found"},{status:404})]);
 expect(await f.client.bindFlyReplacement("dep/one",r)).toEqual(receipt);expect(await f.client.getFlyBindingReceipt("dep/one",r.requestId)).toEqual(receipt);expect(await f.client.getFlyBinding("dep/one")).toEqual(receipt);expect(await f.client.getFlyBinding("dep/one")).toBeNull();expect(await f.client.getFlyBindingReceipt("dep/one",r.requestId)).toBeNull();
 const [url,init]=f.fetch.mock.calls[0]!;expect(url).toBe("https://service.test/api/deployments/dep%2Fone/config/fly-bindings");expect(init).toMatchObject({method:"POST",credentials:"omit",redirect:"manual"});expect(JSON.parse(init!.body as string)).toEqual(r);
 const reordered=Object.fromEntries(Object.entries(r).reverse()),g=transport([Response.json({request:reordered,configurationVersion:8})]);expect(await g.client.bindFlyReplacement("dep",r)).toEqual(receipt);
});
it("rejects missing input before fetch and malformed, mismatched, or failed server replies",async()=>{
 const r=request(),empty=transport([]);
 for(const operation of [()=>empty.client.bindFlyReplacement("",r),()=>empty.client.bindFlyReplacement("dep",{} as FlyBindingRequest),()=>empty.client.getFlyBindingReceipt("",r.requestId),()=>empty.client.getFlyBindingReceipt("dep","bad"),()=>empty.client.getFlyBinding("")])await expect(operation()).rejects.toThrow();expect(empty.fetch).not.toHaveBeenCalled();
 for(const response of [{}, {request:{...r,machineId:"aaaa"},configurationVersion:8}])await expect(transport([Response.json(response)]).client.bindFlyReplacement("dep",r)).rejects.toMatchObject({code:"invalid_binding_receipt"});
 for(const response of [{},{request:{...r,requestId:randomUUID()},configurationVersion:8}])await expect(transport([Response.json(response)]).client.getFlyBindingReceipt("dep",r.requestId)).rejects.toMatchObject({code:"invalid_binding_receipt"});
 for(const response of [null,[],{}, {binding:null,extra:true},{binding:{}}])await expect(transport([Response.json(response)]).client.getFlyBinding("dep")).rejects.toMatchObject({code:response===null?"invalid_response":"invalid_binding_receipt"});
 await expect(transport([Response.json({error:"not_found"},{status:404})]).client.getFlyBindingReceipt("dep",r.requestId)).rejects.toMatchObject({status:404,code:"not_found"});
});
