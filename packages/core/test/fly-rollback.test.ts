import {expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {validateFlyRollbackRequest,validateFlyRollbackReceipt,type FlyRollbackRequest} from "../src/fly-rollback";
import {LogturaServiceClient,ServiceError} from "../src/service-client";
const hash=(c:string)=>`sha256:${c.repeat(64)}`;
function fixture(){
 const binding={request:{requestId:randomUUID(),instanceId:randomUUID(),expectedConfigurationVersion:2,expectedSequence:1,revision:hash("a"),appName:"app",orgSlug:"personal",region:"iad",previousMachineId:"abc123",expectedImageDigest:null,previousImageDigest:hash("b"),previousConfigDigest:hash("c"),machineId:"def456",imageDigest:hash("d")},configurationVersion:3};
 const request:FlyRollbackRequest={requestId:randomUUID(),bindingRequestId:binding.request.requestId,expectedConfigurationVersion:3,expectedSequence:1,revision:hash("a"),expectedInstanceId:binding.request.instanceId,expectedImageDigest:hash("d"),candidateConfigDigest:hash("e")};
 return {binding,request,prepared:{request,binding,fence:{configurationVersion:3,sequence:1,revision:hash("a")},status:"prepared" as const,configurationVersion:3},completed:{request,binding,fence:{configurationVersion:3,sequence:1,revision:hash("a")},status:"completed" as const,configurationVersion:4}};
}
it("validates bounded public rollback fences and completed graph clocks without private payloads",()=>{
 const f=fixture();expect(validateFlyRollbackRequest(f.request)).toEqual(f.request);expect(validateFlyRollbackRequest({...f.request,expectedInstanceId:null}).expectedInstanceId).toBeNull();expect(validateFlyRollbackReceipt(f.prepared)).toEqual(f.prepared);expect(validateFlyRollbackReceipt(f.completed)).toEqual(f.completed);
 for(const value of [null,[],{}, {...f.request,extra:"private"},{...f.request,requestId:"bad"},{...f.request,bindingRequestId:"bad"},{...f.request,expectedInstanceId:"bad"},{...f.request,expectedConfigurationVersion:-1},{...f.request,expectedConfigurationVersion:Number.MAX_SAFE_INTEGER},{...f.request,expectedSequence:0},{...f.request,revision:"bad"},{...f.request,expectedImageDigest:null},{...f.request,candidateConfigDigest:"bad"}])expect(()=>validateFlyRollbackRequest(value)).toThrow("Invalid Fly rollback request");
 for(const value of [null,[],{}, {...f.prepared,status:"unknown"},{...f.prepared,extra:true},{...f.prepared,configurationVersion:4},{...f.completed,configurationVersion:3},{...f.prepared,request:{...f.request,bindingRequestId:randomUUID()}},{...f.prepared,request:{...f.request,expectedConfigurationVersion:2},configurationVersion:2},{...f.prepared,binding:{...f.binding,request:{...f.binding.request,previousMachineId:"def456"},configurationVersion:2}}])expect(()=>validateFlyRollbackReceipt(value)).toThrow();
 const copy=validateFlyRollbackReceipt(f.prepared);copy.request.expectedSequence=10;expect(f.request.expectedSequence).toBe(1);
});
it("roundtrips prepare, receipt recovery and completion through encoded owner-authenticated routes",async()=>{
 const f=fixture(),fetcher=vi.fn<typeof fetch>(async(url,init)=>Response.json(String(url).endsWith("/complete")?f.completed:f.prepared));
 const client=new LogturaServiceClient({url:"https://service.test",token:`lt_cli_${"a".repeat(43)}`,fetch:fetcher});
 expect(await client.prepareFlyRollback("dep /site",f.request)).toEqual(f.prepared);expect(await client.getFlyRollback("dep /site",f.request.requestId)).toEqual(f.prepared);expect(await client.completeFlyRollback("dep /site",f.request.requestId)).toEqual(f.completed);
 expect(fetcher.mock.calls.map(([url])=>new URL(String(url)).pathname)).toEqual(["/api/deployments/dep%20%2Fsite/config/fly-rollbacks",`/api/deployments/dep%20%2Fsite/config/fly-rollbacks/${f.request.requestId}`,`/api/deployments/dep%20%2Fsite/config/fly-rollbacks/${f.request.requestId}/complete`]);
 expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(f.request);expect(fetcher.mock.calls[0]![1]!.headers).toBeInstanceOf(Headers);
});
it("rejects mismatched or malformed rollback responses rather than trusting historical identity",async()=>{
 const f=fixture();const fetcher=vi.fn<typeof fetch>();const client=new LogturaServiceClient({url:"https://service.test",fetch:fetcher});
 for(const value of [null,{}, {...f.prepared,request:{...f.request,requestId:randomUUID()}}]){
  fetcher.mockResolvedValueOnce(Response.json(value));await expect(client.prepareFlyRollback("dep",f.request)).rejects.toBeInstanceOf(ServiceError);
  fetcher.mockResolvedValueOnce(Response.json(value));await expect(client.getFlyRollback("dep",f.request.requestId)).rejects.toBeInstanceOf(ServiceError);
  fetcher.mockResolvedValueOnce(Response.json(value));await expect(client.completeFlyRollback("dep",f.request.requestId)).rejects.toBeInstanceOf(ServiceError);
 }
 fetcher.mockResolvedValueOnce(Response.json(f.prepared));await expect(client.completeFlyRollback("dep",f.request.requestId)).rejects.toMatchObject({code:"invalid_rollback_receipt"});
 for(const operation of [()=>client.prepareFlyRollback("",f.request),()=>client.getFlyRollback("",f.request.requestId),()=>client.getFlyRollback("dep","bad"),()=>client.completeFlyRollback("",f.request.requestId),()=>client.completeFlyRollback("dep","bad")])await expect(operation()).rejects.toThrow();
});
it("treats only an owned receipt-not-found as recoverable absence",async()=>{
 const f=fixture(),fetcher=vi.fn<typeof fetch>(),client=new LogturaServiceClient({url:"https://service.test",fetch:fetcher});
 fetcher.mockResolvedValueOnce(Response.json({error:"receipt_not_found"},{status:404}));expect(await client.getFlyRollback("dep",f.request.requestId)).toBeNull();
 for(const status of [401,403,404,409,503]){fetcher.mockResolvedValueOnce(Response.json({error:"not_found"},{status}));await expect(client.getFlyRollback("dep",f.request.requestId)).rejects.toMatchObject({status});}
 fetcher.mockRejectedValueOnce(new TypeError("offline"));await expect(client.getFlyRollback("dep",f.request.requestId)).rejects.toThrow("offline");
});
it("validates and transports explicit immutable rebase acknowledgements",async()=>{
 const f=fixture(),request={requestId:randomUUID(),configurationVersion:5,sequence:2,revision:hash("f")},receipt={rollbackId:f.request.requestId,request};
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json(receipt)),client=new LogturaServiceClient({url:"https://service.test",fetch:fetcher});
 expect(await client.rebaseFlyRollback("dep",receipt.rollbackId,request)).toEqual(receipt);expect(await client.getFlyRollbackRebase("dep",receipt.rollbackId,request.requestId)).toEqual(receipt);
 for(const value of [{}, {...receipt,rollbackId:randomUUID()}, {...receipt,request:{...request,requestId:randomUUID()}}]){
  fetcher.mockResolvedValueOnce(Response.json(value));await expect(client.rebaseFlyRollback("dep",receipt.rollbackId,request)).rejects.toMatchObject({code:"invalid_rollback_rebase_receipt"});
  fetcher.mockResolvedValueOnce(Response.json(value));await expect(client.getFlyRollbackRebase("dep",receipt.rollbackId,request.requestId)).rejects.toMatchObject({code:"invalid_rollback_rebase_receipt"});
 }
 fetcher.mockResolvedValueOnce(Response.json({error:"receipt_not_found"},{status:404}));expect(await client.getFlyRollbackRebase("dep",receipt.rollbackId,request.requestId)).toBeNull();
 fetcher.mockResolvedValueOnce(Response.json({error:"not_found"},{status:404}));await expect(client.getFlyRollbackRebase("dep",receipt.rollbackId,request.requestId)).rejects.toMatchObject({status:404});
 for(const operation of [()=>client.rebaseFlyRollback("",receipt.rollbackId,request),()=>client.rebaseFlyRollback("dep","bad",request),()=>client.getFlyRollbackRebase("",receipt.rollbackId,request.requestId),()=>client.getFlyRollbackRebase("dep","bad",request.requestId),()=>client.getFlyRollbackRebase("dep",receipt.rollbackId,"bad")])await expect(operation()).rejects.toThrow();
});
it("validates strict rebase payloads and independently advanced graph fences",async()=>{
 const {validateFlyRollbackFence,validateFlyRollbackRebaseRequest,validateFlyRollbackRebaseReceipt}=await import("../src/fly-rollback"),f=fixture();
 const fence={configurationVersion:5,sequence:2,revision:hash("f")},request={requestId:randomUUID(),...fence};
 expect(validateFlyRollbackFence(fence)).toEqual(fence);expect(validateFlyRollbackRebaseRequest(request)).toEqual(request);expect(validateFlyRollbackRebaseReceipt({rollbackId:f.request.requestId,request})).toEqual({rollbackId:f.request.requestId,request});
 expect(validateFlyRollbackReceipt({...f.prepared,fence,configurationVersion:5}).fence).toEqual(fence);
 for(const value of [null,[],{}, {...fence,extra:1},{...fence,configurationVersion:-1},{...fence,configurationVersion:Number.MAX_SAFE_INTEGER},{...fence,sequence:0},{...fence,revision:"bad"}])expect(()=>validateFlyRollbackFence(value)).toThrow();
 for(const value of [null,[],{}, {...request,extra:1},{...request,requestId:"bad"},{...request,sequence:0}])expect(()=>validateFlyRollbackRebaseRequest(value)).toThrow();
 for(const value of [null,[],{}, {rollbackId:"bad",request},{rollbackId:f.request.requestId,request,extra:1}])expect(()=>validateFlyRollbackRebaseReceipt(value)).toThrow();
});
