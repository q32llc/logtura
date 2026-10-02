import {expect,it} from "vitest";
import {parse} from "yaml";
import {customVectorProvider as provider,customVectorDestination as destination} from "../src/index";
const connection={id:"?!",externalAccountId:null,displayName:"Custom"};
const source=(raw:unknown)=>provider.generatePipeline({connection,selection:{kind:"list",sources:[{id:"feed",externalId:"feed",sourceKind:"custom_vector",displayName:"Feed",metadata:{customVector:raw}}]}});
const sink=(fragment:unknown,input?:string|null,inputs=["monitor"])=>destination.generateSinkBundle({config:{fragment:fragment as any,input},inputs,sinkKey:"?!",envVarName:"UNUSED"});
it("works without remote credentials or discovery and requires no destination runtime secrets",async()=>{
 expect(await provider.verifyCredentials({fragment:{},feed:""})).toEqual([{id:"custom-vector",name:"Custom Vector"}]);
 expect(await provider.discoverSources({credentials:{fragment:{},feed:""},accountId:"custom-vector"})).toEqual([]);
 expect(destination.runtimeEnvVars({config:{fragment:{}},envVarName:"UNUSED",displayName:"Custom"})).toEqual([]);
 expect(destination.envVarValue({fragment:{}},"UNUSED")).toBeNull();
});
it("rejects unsupported selections and incomplete parsed source configurations",()=>{
 expect(()=>provider.generatePipeline({connection,selection:{kind:"all"}})).toThrow("all-selection");
 expect(()=>provider.generatePipeline({connection,selection:{kind:"list",sources:[]}})).toThrow("parsed vector config");
 for(const raw of [null,[],42,{}, {fragment:null,feed:"feed"},{fragment:[],feed:"feed"},{fragment:{},feed:"feed"},{fragment:{sources:{}},feed:42},{fragment:{sources:{}},feed:""}])expect(()=>source(raw)).toThrow();
 expect(()=>source({fragment:{sources:{feed:{type:"demo_logs"}}},feed:"absent"})).toThrow("must name a source or transform");
});
it("rejects malformed maps, disallowed sections and duplicate component identities",()=>{
 for(const value of [null,[],42]){
  expect(()=>source({fragment:{sources:value},feed:"feed"})).toThrow("component map");
  expect(()=>sink({sinks:value},"external")).toThrow("component map");
 }
 expect(()=>sink({sources:{}},"external")).toThrow("cannot define sources");
 expect(()=>source({fragment:{sources:{same:{}},transforms:{same:{}}},feed:"same"})).toThrow("duplicate custom-vector");
 expect(()=>source({fragment:{sources:{"a b":{},a_b:{}}},feed:"a b"})).toThrow("collide after normalization");
 expect(()=>sink({sinks:{"a b":{},a_b:{}}},"external")).toThrow("collide after normalization");
});
it("rejects ambiguous/absent sink inputs and placeholders shadowing a defined component",()=>{
 for(const inputs of [[],["one","two"]])expect(()=>sink({sinks:{out:{type:"blackhole",inputs:["external"]}}},null,inputs)).toThrow("exactly one");
 for(const fragment of [{sinks:{out:{type:"blackhole"}}},{sinks:{out:null}},{sinks:{out:{inputs:42}}}])expect(()=>sink(fragment)).toThrow("0 dangling inputs");
 expect(()=>sink({transforms:{format:{type:"remap",inputs:["external"],source:". = ."}},sinks:{out:{type:"blackhole",inputs:["format"]}}},"format")).toThrow("external placeholder");
});
it("rewrites nested graph inputs while preserving non-reference values and opaque input strings",()=>{
 const fragment={sources:{"?!":{type:"demo_logs"}},transforms:{format:{type:"remap",inputs:["?!","outside",42],source:".message = \"outside\"",nested:[{inputs:["?!","outside",null]},"literal",null]}}};
 const pipeline=source({fragment,feed:"format"});
 expect(pipeline.outputKey).toBe("custom_x_format");
 expect(parse(pipeline.components[1]!.yaml)).toEqual({...fragment.transforms.format,inputs:["custom_x_x","outside",42],nested:[{inputs:["custom_x_x","outside",null]},"literal",null]});
 const direct=source({fragment:{sources:{feed:{type:"demo_logs"}}},feed:"feed"});expect(direct.components).toHaveLength(1);
});
it("supports explicit placeholders, inferred string inputs and transform-only source feeds",()=>{
 const output=sink({sinks:{out:{type:"blackhole",inputs:["external",42,null]}}});
 expect(parse(output.sinks![0]!.yaml).inputs).toEqual(["monitor",42,null]);
 const transformsOnly=source({fragment:{transforms:{feed:{type:"remap",inputs:["external"],source:". = ."}}},feed:"feed"});expect(transformsOnly.components).toHaveLength(1);
 const explicit=sink({sinks:{out:{type:"blackhole",inputs:["external"]}}},"external");expect(explicit.preSinkTransforms).toEqual([]);
});
