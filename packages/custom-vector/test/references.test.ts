import {expect,it} from "vitest";
import {parse} from "yaml";
import {customVectorProvider as provider,customVectorDestination as destination} from "../src/index";
const connection={id:"fixture",externalAccountId:null,displayName:"Fixture"};
function source(fragment:Record<string,unknown>,feed:string){return provider.generatePipeline({connection,selection:{kind:"list",sources:[{id:"feed",externalId:feed,displayName:"Feed",sourceKind:"custom_vector",metadata:{customVector:{fragment,feed}}}]}});}
function sink(fragment:Record<string,unknown>,input?:string){return destination.generateSinkBundle({config:{fragment,input},inputs:["monitor"],sinkKey:"fixture",envVarName:"UNUSED"});}
it("maps named source feeds and named/wildcard output references without changing ports",()=>{
 const fragment={sources:{in:{type:"demo_logs"}},transforms:{route:{type:"route",inputs:["in"],route:{good:"true"}},merge:{type:"remap",inputs:["route.good","route.*","outside.port"],source:". = ."}}};
 const pipeline=source(fragment,"route.good");expect(pipeline.outputKey).toBe("custom_fixture_route.good");
 expect(parse(pipeline.components[2]!.yaml).inputs).toEqual(["custom_fixture_route.good","custom_fixture_route.*","outside.port"]);
 expect(source(fragment,"route.*").outputKey).toBe("custom_fixture_route.*");
 expect(()=>source(fragment,"missing.port")).toThrow("must name a source or transform");
});
it("expands component globs against original local identities, preserving output suffixes",()=>{
 const fragment={sources:{"ingress one":{},"ingress two":{},unrelated:{}},transforms:{route_a:{inputs:["ingress *"]},route_b:{inputs:["ingress *"]},merged:{inputs:["route_*.selected","route_*.error*"]}}};
 const pipeline=source(fragment,"merged");
 expect(parse(pipeline.components[3]!.yaml).inputs).toEqual(["custom_fixture/ingress *"]);
 expect(parse(pipeline.components[5]!.yaml).inputs).toEqual(["custom_fixture/route_*.selected","custom_fixture/route_*.error*"]);
 expect(JSON.stringify(fragment)).toContain('"inputs":["ingress *"]');
});
it("isolates all-component globs, excludes the current transform and escapes regex characters",()=>{
 const all=source({sources:{one:{},two:{}},transforms:{merge:{inputs:["*"]}}},"merge");
 expect(parse(all.components[2]!.yaml).inputs).toEqual(["custom_fixture/*"]);
 const escaped=source({sources:{"a+b":{},ab:{}},transforms:{merge:{inputs:["a+*"]}}},"merge");
 expect(parse(escaped.components[2]!.yaml).inputs).toEqual(["custom_fixture/a+*"]);
 expect(()=>source({sources:{one:{}},transforms:{merge:{inputs:["absent*"]}}},"merge")).toThrow("wildcard input");
});
it("infers only the external destination placeholder across named ports and local globs",()=>{
 const fragment={transforms:{route:{inputs:["external"]},stamp_one:{inputs:["route.one"]},stamp_two:{inputs:["route.two"]},merge:{inputs:["stamp_*"]}},sinks:{output:{inputs:["merge"]}}};
 const bundle=sink(fragment);
 expect(parse(bundle.preSinkTransforms![0]!.yaml).inputs).toEqual(["monitor"]);
 expect(parse(bundle.preSinkTransforms![2]!.yaml).inputs).toEqual(["custom_fixture/route.one"]);
 expect(parse(bundle.preSinkTransforms![4]!.yaml).inputs).toEqual(["custom_fixture/stamp_*"]);
 expect(parse(bundle.sinks![0]!.yaml).inputs).toEqual(["custom_fixture/merge"]);
 for(const input of ["route.one","route.*","stamp_*"])expect(()=>sink(fragment,input)).toThrow("external placeholder");
});
it("never expands destination globs to sinks and preserves explicit external aliases",()=>{
 const bundle=sink({transforms:{format:{inputs:["external"]}},sinks:{one:{inputs:["*"]},two:{inputs:["format"]}}},"external");
 expect(parse(bundle.sinks![0]!.yaml).inputs).toEqual(["custom_fixture/*"]);
 const external=sink({sinks:{output:{inputs:["external*"]}}});expect(parse(external.sinks![0]!.yaml).inputs).toEqual(["monitor"]);
 const exact=source({sources:{"name.part":{},name:{}},transforms:{merged:{inputs:["name.part","name.part.output"]}}},"name.part.output");
 expect(exact.outputKey).toBe("custom_fixture_name_part.output");
 expect(parse(exact.components[2]!.yaml).inputs).toEqual(["custom_fixture_name_part","custom_fixture_name_part.output"]);
});
it.each([
 {pattern:"a?",keys:["a1","a2","long"],selected:["a1","a2"]},
 {pattern:"a[12]",keys:["a1","a2","a3"],selected:["a1","a2"]},
 {pattern:"a[!2]",keys:["a1","a2","a3"],selected:["a1","a3"]},
 {pattern:"a[?]",keys:["a?","a1"],selected:["a?"]},
 {pattern:"a[[]b",keys:["a[b","ab"],selected:["a[b"]},
 {pattern:"a[]]b",keys:["a]b","ab"],selected:["a]b"]},
 {pattern:"a[!]]",keys:["a]","a1"],selected:["a1"]},
 {pattern:"a[^]",keys:["a^","a1"],selected:["a^"]},
 {pattern:"a[-1]",keys:["a-","a1","a2"],selected:["a-","a1"]},
 {pattern:"**/foo",keys:["foo","path/foo","other"],selected:["foo","path/foo"]},
 {pattern:"**",keys:["one","two"],selected:["one","two"]},
 {pattern:"u?",keys:["u🦊","u1","other"],selected:["u🦊","u1"]},
])("preserves pinned Vector glob grammar for $pattern",({pattern,keys,selected})=>{
 const pipeline=source({sources:Object.fromEntries(keys.map(key=>[key,{}])),transforms:{merged:{inputs:[pattern]}}},"merged");
 expect(parse(pipeline.components.at(-1)!.yaml).inputs).toEqual(["custom_fixture/"+pattern]);
 expect(selected.every(key=>pipeline.components.some(component=>component.key==="custom_fixture/"+key))).toBe(true);
});
it.each(["a[","a[]","a[!]","a[z-a]","a**","***","**x","x/**z"])("rejects invalid input glob %s",pattern=>{
 expect(()=>source({sources:{a1:{}},transforms:{merged:{inputs:[pattern]}}},"merged")).toThrow("Invalid custom-vector wildcard");
});
it("keeps external aliases exact even when their mapped identity ends in the namespace boundary",()=>{
 const bundle=destination.generateSinkBundle({config:{input:"external",fragment:{transforms:{format:{inputs:["external"]}},sinks:{out:{inputs:["*"]}}}},inputs:["outside/"],sinkKey:"fixture",envVarName:"UNUSED"});
 expect(parse(bundle.sinks![0]!.yaml).inputs).toEqual(["custom_fixture/*"]);
 expect(parse(bundle.preSinkTransforms![0]!.yaml).inputs).toEqual(["outside/"]);
});
it("namespaces nested component globs and leaves original exact-reference graph identities stable",()=>{
 const exact=source({sources:{"?!":{}},transforms:{merged:{inputs:["?!"]}}},"merged");expect(exact.components[0]!.key).toBe("custom_fixture_x");
 const nested=source({sources:{one:{}},transforms:{merged:{inputs:["one"],nested:[{inputs:["o*"]}]}}},"merged");
 expect(parse(nested.components[1]!.yaml).nested).toEqual([{inputs:["custom_fixture/o*"]}]);
});
it("matches long repeated-star expressions without regex backtracking",()=>{
 const key="a".repeat(50), pattern="*a".repeat(25)+"*";
 expect(source({sources:{[key]:{}},transforms:{merged:{inputs:[pattern]}}},"merged").components).toHaveLength(2);
 expect(source({sources:{[key+"c"]:{}},transforms:{merged:{inputs:["*a".repeat(25)+"b"]}}},"merged").components).toHaveLength(2);
});
it("preserves raw wildcard graph names and isolates identities that normalize alike",()=>{
 const fragment={sources:{"a b":{},"a_b":{}},transforms:{merged:{inputs:["a*"]}}};
 const generated=(id:string)=>provider.generatePipeline({connection:{...connection,id},selection:{kind:"list",sources:[{id:"feed",externalId:"merged",displayName:"Feed",sourceKind:"custom_vector",metadata:{customVector:{fragment,feed:"merged"}}}]}});
 const first=generated("a.b!*()"),second=generated("a_b");
 expect(first.components[0]!.key).toBe("custom_a%2Eb%21%2A%28%29/a b");
 expect(first.components[1]!.key).toBe("custom_a%2Eb%21%2A%28%29/a_b");
 expect(second.components[0]!.key).toBe("custom_a_b/a b");
 expect(()=>source({sources:{"a.b":{}},transforms:{merged:{inputs:["a*"]}}},"merged")).toThrow("cannot contain dots");
 expect(source({sources:{one:{},two:{}}},"o*").outputKey).toBe("custom_fixture/o*");
});
it.each(["external.raw","external._unmatched"])("provides a scoped external named output %s for native expansion",input=>{
 const bundle=sink({transforms:{format:{inputs:[input]}},sinks:{out:{inputs:["f*"]}}},input);
 const alias=parse(bundle.preSinkTransforms![0]!.yaml);
 expect(bundle.preSinkTransforms![0]!.key).toBe("custom_fixture/external");
 expect(alias.inputs).toEqual(["monitor"]);
 if(input.endsWith("_unmatched")){expect(alias.type).toBe("route");expect(alias.reroute_unmatched).toBe(true);}
 else{expect(alias.type).toBe("exclusive_route");expect(alias.routes).toEqual([{name:"raw",condition:"true"}]);}
 expect(parse(bundle.preSinkTransforms![1]!.yaml).inputs).toEqual(["custom_fixture/"+input]);
});
