import {afterEach,expect,it,vi} from "vitest";
import {parseMetricsBody,applyMetricsToSnapshot,emptySnapshot,rateFor,type ComponentMetrics} from "../src/metrics";
afterEach(()=>vi.restoreAllMocks());
const epoch=1_790_880_000_000;
function metric(name="component_sent_events_total",value:unknown=10,time=epoch,id="sink"){return {name,namespace:"vector",timestamp:time,tags:{component_id:id,component_kind:"sink",component_type:"http"},counter:{value}};}
function parsed(events:unknown[]){return parseMetricsBody(JSON.stringify(events));}
function errors(value:number,type:string,time=epoch){return {...metric("component_errors_total",value,time),tags:{...metric().tags,error_type:type}};}
function uptime(value:number,time=epoch){return {name:"vector_uptime_seconds",timestamp:time,gauge:{value}};}
it("parses equivalent JSON arrays, pretty single events and ordinary NDJSON without exposing malformed input",()=>{
 const events=[metric(),metric("component_received_events_total",12)];expect(parseMetricsBody(JSON.stringify(events))).toEqual(parseMetricsBody(events.map(e=>JSON.stringify(e)).join("\n\n")));expect(parseMetricsBody("  "+JSON.stringify(events[0],null,2)+"  ")).toEqual(parsed([events[0]]));
 for(const text of [""," \n ","private broken input",JSON.stringify(events[0])+"\nprivate invalid line","[broken]","null","false","[]","[null,[],false,1,{}]"])expect(parseMetricsBody(text)).toEqual([]);
});
it("normalizes namespaces, kinds, timestamps, gauges and legacy numeric strings while rejecting invalid metric values",()=>{
 vi.spyOn(Date,"now").mockReturnValue(epoch);
 const sample=metric();expect(parsed([sample])[0]).toMatchObject({bareName:"component_sent_events_total",componentId:"sink",componentKind:"sink",componentType:"http",value:10,isCounter:true,isGauge:false,timestampMs:epoch});
 for(const timestamp of [epoch/1000,new Date(epoch).toISOString(),undefined,"invalid",NaN,-1]){const input={...sample,timestamp};if(Number.isNaN(timestamp))input.timestamp=undefined;expect(parsed([input])[0]!.timestampMs).toBe(epoch);}
 const records=[{...sample,name:"custom_component_sent_events_total",namespace:"custom"},{...sample,name:"vector_component_sent_events_total",namespace:"other"},{...sample,name:"component_sent_events_total",namespace:""},{name:"unknown"},{name:"build_info",tags:{version:"0.55.0"},gauge:{value:1}},{...sample,tags:{component_kind:"source"}},{...sample,tags:{component_kind:"transform"}},{...sample,tags:{component_kind:"other",component_id:1,component_type:2,error_type:3}},{...sample,tags:[]},{...sample,tags:null}];
 const result=parsed(records);expect(result.slice(0,3).map(e=>e.bareName)).toEqual(Array(3).fill("component_sent_events_total"));expect(result[4]).toMatchObject({buildVersion:"0.55.0",isGauge:true});expect(result[5]!.componentKind).toBe("source");expect(result[6]!.componentKind).toBe("transform");expect(result[7]!.componentId).toBeUndefined();
 expect(parsed([metric("component_sent_events_total","42")])[0]!.value).toBe(42);
 for(const value of [-1,"NaN","Infinity","",false,null,{},[],{"toString":"bad"}])expect(parsed([metric("component_sent_events_total",value)])).toEqual([]);
 for(const input of [{...sample,name:""},{...sample,name:1},{...sample,counter:null},{...sample,counter:[]},{...sample,counter:{}},{...sample,gauge:{value:1}},{name:"gauge",gauge:{}},{name:"gauge",gauge:null},{name:"gauge",gauge:[]}])expect(parsed([input])).toEqual([]);
 expect(()=>parseMetricsBody("private broken input",{strict:true})).toThrow("Invalid metrics JSON or NDJSON");
});
it("keeps independent field rates, drops duplicate/older counters and never mutates previous snapshots",()=>{
 const before=applyMetricsToSnapshot(null,parsed([metric(),metric("component_received_events_total",15),metric("component_discarded_events_total",2)])),copy=structuredClone(before);
 const after=applyMetricsToSnapshot(before,parsed([metric("component_received_events_total",25,epoch+60_000),metric("component_sent_events_total",20,epoch+60_000)]));expect(before).toEqual(copy);expect(rateFor(after.byComponent.sink!,"sent")).toBe(10);expect(rateFor(after.byComponent.sink!,"received")).toBe(10);
 const duplicate=applyMetricsToSnapshot(after,parsed([metric("component_sent_events_total",1,epoch),metric("component_sent_events_total",20,epoch+60_000)]));expect(duplicate.byComponent.sink).toEqual(after.byComponent.sink);expect(duplicate.totals).toEqual(after.totals);expect(duplicate.lifetimeOffset.sent).toBe(0);
 expect(applyMetricsToSnapshot(before,[])).toEqual(before);expect(applyMetricsToSnapshot(null,[])).toEqual(emptySnapshot());
});
it("resets individual counters without double subtraction or losing other field baselines",()=>{
 let snap=applyMetricsToSnapshot(null,parsed([metric("component_received_events_total",15),metric("component_sent_events_total",10)]));snap=applyMetricsToSnapshot(snap,parsed([metric("component_received_events_total",20,epoch+60_000),metric("component_sent_events_total",20,epoch+60_000)]));
 const reset=applyMetricsToSnapshot(snap,parsed([metric("component_received_events_total",2,epoch+120_000)]));expect(reset.totals.received).toBe(2);expect(reset.lifetimeOffset.received).toBe(20);expect(reset.byComponent.sink!.prev?.received).toBeUndefined();expect(reset.byComponent.sink!.prev?.sent).toBe(10);expect(rateFor(reset.byComponent.sink!,"sent")).toBe(10);
 const firstReset=applyMetricsToSnapshot(applyMetricsToSnapshot(null,parsed([metric()])),parsed([metric("component_sent_events_total",2,epoch+1000)]));expect(firstReset.totals.sent).toBe(2);expect(firstReset.lifetimeOffset.sent).toBe(10);
});
it("sums per-type errors once, preserves a same-batch aggregate rate and handles per-type resets and delayed labels",()=>{
 let snap=applyMetricsToSnapshot(null,parsed([errors(2,"request"),errors(3,"encoding")]));expect(snap.totals.errors).toBe(5);
 snap=applyMetricsToSnapshot(snap,parsed([errors(4,"request",epoch+60_000),errors(5,"encoding",epoch+60_000)]));expect(snap.totals.errors).toBe(9);expect(snap.byComponent.sink!.prev?.errors).toBe(5);expect(rateFor(snap.byComponent.sink!,"errors")).toBe(4);
 const staleError=errors(1,"request",epoch);staleError.tags.component_kind="source";staleError.tags.component_type="stale";const old=applyMetricsToSnapshot(snap,parsed([staleError]));expect(old.byComponent.sink).toEqual(snap.byComponent.sink);
 const reset=applyMetricsToSnapshot(snap,parsed([errors(1,"request",epoch+120_000)]));expect(reset.totals.errors).toBe(6);expect(reset.lifetimeOffset.errors).toBe(4);expect(rateFor(reset.byComponent.sink!,"errors")).toBeNull();
 const later=applyMetricsToSnapshot(reset,parsed([errors(2,"delayed",epoch+110_000)]));expect(later.totals.errors).toBe(8);expect(later.byComponent.sink!.sampleAtByField!.errors).toBe(epoch+120_000);
 expect(applyMetricsToSnapshot(null,parsed([{...metric("component_errors_total",1),tags:{component_id:"sink"}}])).byComponent.sink!.errorsByType).toEqual({other:1});
});
it("detects whole-process restarts, accumulates lifetime totals, and ignores stale uptime/build history",()=>{
 let snap=applyMetricsToSnapshot(null,parsed([uptime(60),metric(),errors(2,"request"),metric("component_received_events_total",12),metric("component_discarded_events_total",3),{name:"build_info",timestamp:epoch,tags:{version:"0.55.0"},gauge:{value:1}}]));expect(snap.processStartAt).toBe(epoch-60_000);
 snap=applyMetricsToSnapshot(snap,parsed([uptime(1,epoch+120_000),metric("component_sent_events_total",2,epoch+120_000),errors(1,"request",epoch+120_000)]));expect(snap.lifetimeOffset).toEqual({received:12,sent:10,errors:2,discarded:3});expect(snap.totals).toEqual({received:0,sent:2,errors:1,discarded:0});expect(rateFor(snap.byComponent.sink!,"sent")).toBeNull();
 const stale=applyMetricsToSnapshot(snap,parsed([uptime(60,epoch),metric("component_received_events_total",999,epoch),{name:"build_info",timestamp:epoch-1000,tags:{version:"old"},gauge:{value:1}}]));expect(stale.processStartAt).toBe(snap.processStartAt);expect(stale.totals).toEqual(snap.totals);expect(stale.vectorVersion).toBe("0.55.0");
 const build=applyMetricsToSnapshot(stale,parsed([{name:"build_info",timestamp:epoch+180_000,tags:{version:"new"},gauge:{value:1}}]));expect(build.vectorVersion).toBe("new");
});
it("caps components and error labels and safely handles prototype-like identities in parsed or restored JSON",()=>{
 const many=Array.from({length:257},(_,i)=>metric("component_sent_events_total",1,epoch,"component"+i));const snap=applyMetricsToSnapshot(null,parsed(many));expect(Object.keys(snap.byComponent)).toHaveLength(256);expect(snap.totals.sent).toBe(256);
 let errorsSnap=applyMetricsToSnapshot(null,parsed(Array.from({length:33},(_,i)=>errors(1,"type"+i))));expect(Object.keys(errorsSnap.byComponent.sink!.errorsByType!)).toHaveLength(32);expect(errorsSnap.totals.errors).toBe(32);errorsSnap=applyMetricsToSnapshot(errorsSnap,parsed([errors(2,"type0",epoch+1000)]));expect(errorsSnap.totals.errors).toBe(33);
 const malicious=parsed([metric("constructor",999),metric("component_sent_events_total",3,epoch,"__proto__"),{...errors(2,"__proto__"),tags:{component_id:"constructor",error_type:"__proto__"}}]);const safe=applyMetricsToSnapshot(null,malicious);expect(Object.keys(safe.byComponent)).toEqual(["__proto__","constructor"]);expect(safe.totals.sent).toBe(3);expect(safe.totals.errors).toBe(2);expect(({} as Record<string,unknown>).sent).toBeUndefined();
 const restored=JSON.parse(JSON.stringify(safe));expect(applyMetricsToSnapshot(restored,parsed([metric("component_sent_events_total",4,epoch+1000,"__proto__")])).totals.sent).toBe(4);
});
it("supports legacy snapshot timestamp fallbacks and rejects undefined, reversed or equal rate intervals",()=>{
 const comp:ComponentMetrics={kind:"sink",type:"http",sent:10,lastSeen:epoch+60_000,prev:{sent:5,sampleAt:epoch}};expect(rateFor(comp,"sent")).toBe(5);expect(rateFor({...comp,prev:undefined},"sent")).toBeNull();expect(rateFor({...comp,sent:undefined},"sent")).toBeNull();expect(rateFor({...comp,lastSeen:epoch},"sent")).toBeNull();expect(rateFor({...comp,sent:2},"sent")).toBe(0);
 const old={...emptySnapshot(),byComponent:{sink:{...comp,errors:3,errorsByType:{request:3}}},totals:{received:0,sent:10,errors:3,discarded:0}};const next=applyMetricsToSnapshot(old,parsed([metric("component_sent_events_total",12,epoch+120_000),errors(4,"request",epoch+120_000)]));expect(rateFor(next.byComponent.sink!,"sent")).toBe(2);expect(next.byComponent.sink!.errorsAtByType!.request).toBe(epoch+120_000);
});
it("ignores missing component identities, selects newest metadata and resets legacy baselines",()=>{
 expect(applyMetricsToSnapshot(null,parsed([{name:"component_sent_events_total",counter:{value:10}}])).totals.sent).toBe(0);
 const errorsFirst=applyMetricsToSnapshot(null,parsed([errors(3,"request")]));const errorsReset=applyMetricsToSnapshot(errorsFirst,parsed([errors(1,"request",epoch+1000)]));expect(errorsReset.lifetimeOffset.errors).toBe(3);
 const legacy={...emptySnapshot(),byComponent:{sink:{kind:"sink" as const,type:"http",sent:10,lastSeen:epoch,prev:{sent:5,sampleAt:epoch-1000}}},totals:{received:0,sent:10,errors:0,discarded:0}};expect(applyMetricsToSnapshot(legacy,parsed([metric("component_sent_events_total",1,epoch+1000)])).totals.sent).toBe(1);
 const samples=applyMetricsToSnapshot(null,parsed([uptime(60),uptime(61,epoch+1000),uptime(59,epoch-1000),{name:"build_info",timestamp:epoch,tags:{version:"old"},gauge:{value:1}},{name:"build_info",timestamp:epoch+1000,tags:{version:"new"},gauge:{value:1}}]));expect(samples.uptimeSampleAt).toBe(epoch+1000);expect(samples.vectorVersion).toBe("new");
});

it("keeps process identity stable under tolerated uptime jitter rather than forcing every checkpoint",()=>{
 let snap=applyMetricsToSnapshot(null,parsed([uptime(60)]));const boot=snap.processStartAt;
 for(const skew of [1,-1,100,30_000]){snap=applyMetricsToSnapshot(snap,parsed([uptime(60,epoch+skew)]));expect(snap.processStartAt).toBe(boot);}
 const restarted=applyMetricsToSnapshot(snap,parsed([uptime(1,epoch+120_000)]));expect(restarted.processStartAt).toBe(epoch+119_000);
});

it("keeps large representable rates finite and marks overflowing rates unavailable",()=>{
 const component:ComponentMetrics={kind:"source",type:"exec",sent:1e308,lastSeen:60_000,prev:{sent:0,sampleAt:0}};
 expect(rateFor(component,"sent")).toBe(1e308);
 expect(rateFor({...component,lastSeen:1},"sent")).toBeNull();
 expect(rateFor({...component,sent:0},"sent")).toBe(0);
 expect(rateFor({...component,sent:Number.MIN_VALUE},"sent")).toBe(Number.MIN_VALUE);
 expect(rateFor({...component,sent:Number.MIN_VALUE,lastSeen:Number.MIN_VALUE},"sent")).toBe(60_000);
});
it.each([NaN,Infinity,-Infinity,-1])("rejects invalid current or previous counters (%s)",value=>{
 const component:ComponentMetrics={kind:"sink",type:"http",sent:10,lastSeen:60_000,prev:{sent:5,sampleAt:0}};
 expect(rateFor({...component,sent:value},"sent")).toBeNull();
 expect(rateFor({...component,prev:{sent:value,sampleAt:0}},"sent")).toBeNull();
});
it.each([NaN,Infinity,-Infinity])("rejects invalid sample clocks including field-specific clocks (%s)",value=>{
 const component:ComponentMetrics={kind:"sink",type:"http",sent:10,lastSeen:60_000,prev:{sent:5,sampleAt:0}};
 expect(rateFor({...component,lastSeen:value},"sent")).toBeNull();
 expect(rateFor({...component,prev:{sent:5,sampleAt:value}},"sent")).toBeNull();
 expect(rateFor({...component,sampleAtByField:{sent:value}},"sent")).toBeNull();
 expect(rateFor({...component,prev:{sent:5,sampleAt:0,sampleAtByField:{sent:value}}},"sent")).toBeNull();
});
it("rejects an overflowing clock interval instead of reporting a zero rate",()=>{
 expect(rateFor({kind:"sink",type:"http",sent:10,lastSeen:Number.MAX_VALUE,prev:{sent:5,sampleAt:-Number.MAX_VALUE}},"sent")).toBeNull();
});
