import {expect,it} from "vitest";
import {generateBundle} from "../src";
import {mockProvider,mockDestination} from "./_fixtures";
it("round-trips opaque driver component identities as YAML map keys",()=>{
 const sourceKey="fragment/source: one",transformKey='fragment/transform " # one',preKey='fragment/pre "one"',sinkKey="fragment/sink: one";
 const provider={...mockProvider,generatePipeline:()=>({components:[{key:sourceKey,kind:"source" as const,yaml:"    type: demo_logs\n    format: json"},{key:transformKey,kind:"transform" as const,yaml:`    type: remap\n    inputs: [${JSON.stringify(sourceKey)}]\n    source: '. = .'`}],outputKey:transformKey,envVars:[],dockerfileDeps:[]})};
 const destination={...mockDestination,envVarValue:()=>null,generateSinkBundle:({inputs}:{inputs:string[]})=>({preSinkTransforms:[{key:preKey,yaml:`    type: remap\n    inputs: ${JSON.stringify(inputs)}\n    source: '. = .'`}],sinks:[{key:sinkKey,yaml:`    type: blackhole\n    inputs: [${JSON.stringify(preKey)}]`}]})};
 const bundle=generateBundle({providers:[provider],destinations:[destination],connections:[{connection:{id:"fixture",provider:provider.id,externalAccountId:null,displayName:"Fixture"},selectedSources:[{id:"source",externalId:"one",sourceKind:"mock",displayName:"One",metadata:null}]}],monitors:[{monitor:{id:"monitor",connectionId:null,displayName:"Monitor",enabled:true,filterSteps:[]},sinks:[{sink:{id:"sink",filterSteps:[]},destination:{id:"destination",kind:destination.id,displayName:"Destination"},destinationConfig:{}}]}]});
 for(const key of [sourceKey,transformKey,preKey,sinkKey])expect(bundle.vectorYaml).toContain(`  ${JSON.stringify(key)}:`);
 expect(bundle.vectorYaml).toContain(`    inputs: [${JSON.stringify(sourceKey)}]`);
 expect(bundle.vectorYaml).toContain(`    inputs: [${JSON.stringify(preKey)}]`);
 expect(bundle.vectorYaml).toContain(`    inputs: [${JSON.stringify(transformKey)}]`);
});
