import { expect,it } from "vitest";
import { hashConfigDocument } from "../src/config";
import { isInstanceId,validateDeploymentActivation,validateDeploymentInstanceReceipt,validateDeploymentAppliedReport,validateDeploymentConfigurationState } from "../src/deployment-state";
const id="00000000-0000-4000-8000-000000000001",revision=`sha256:${"a".repeat(64)}`;
const activation={requestId:id,expectedConfigurationVersion:0,expectedSequence:1,revision,expectedInstanceId:null},receipt={requestId:id,instanceId:id,configurationVersion:0,sequence:1,revision},report={instanceId:id,sequence:1,revision,reportSequence:1};
it("validates copied public activation, receipt and report records",()=>{
 expect(isInstanceId(id)).toBe(true);expect(isInstanceId(2)).toBe(false);expect(isInstanceId("bad")).toBe(false);
 expect(validateDeploymentActivation(activation)).toEqual(activation);expect(validateDeploymentActivation({...activation,expectedInstanceId:id})).toMatchObject({expectedInstanceId:id});expect(validateDeploymentInstanceReceipt(receipt)).toEqual(receipt);expect(validateDeploymentAppliedReport(report)).toEqual(report);
});
it("rejects missing/unknown fields, invalid IDs, revisions and unsafe counters",()=>{
 for(const [validate,base] of [[validateDeploymentActivation,activation],[validateDeploymentInstanceReceipt,receipt],[validateDeploymentAppliedReport,report]] as const){
  for(const value of [null,2,[],{},Object.create(base), {...base,private:"secret"},Object.fromEntries([...Object.entries(base).slice(1),["private","secret"]])])expect(()=>validate(value)).toThrow("Invalid deployment");
  for(const key of Object.keys(base)){
   const missing={...base} as Record<string,unknown>;delete missing[key];expect(()=>validate(missing)).toThrow("Invalid deployment");
   for(const value of [false,"bad",-1,1.5,Number.MAX_SAFE_INTEGER+1])expect(()=>validate({...base,[key]:value})).toThrow("Invalid deployment");
  }
 }
 expect(()=>validateDeploymentActivation({...activation,expectedSequence:0})).toThrow();expect(()=>validateDeploymentInstanceReceipt({...receipt,sequence:0})).toThrow();expect(()=>validateDeploymentAppliedReport({...report,reportSequence:0})).toThrow();
});
it("validates desired/applied state and checks the actual document hash",async()=>{
 const document={kind:"logtura.deployment" as const,schema_version:1 as const,connections:[],monitors:[],runtimeEnv:null},revision=await hashConfigDocument(document);
 const state={desired:{sequence:2,revision,document,configurationVersion:0},applied:null,activeInstanceId:null,lastReportSequence:0,stale:false};
 expect(await validateDeploymentConfigurationState(state)).toEqual(state);
 const applied={sequence:1,revision,at:0};expect(await validateDeploymentConfigurationState({...state,activeInstanceId:id,lastReportSequence:3,applied,stale:true})).toMatchObject({applied});expect(await validateDeploymentConfigurationState({...state,applied:{...applied,sequence:2}})).toMatchObject({applied:{sequence:2}});
 const cases=[{...state,activeInstanceId:id,lastReportSequence:1},{...state,applied:{...applied,sequence:2,revision:`sha256:${"d".repeat(64)}`}},null,[],2,{}, {...state,extra:true},{...state,desired:null},{...state,desired:{...state.desired,extra:true}},{...state,desired:{...state.desired,sequence:0}},{...state,desired:{...state.desired,configurationVersion:-1}},{...state,desired:{...state.desired,revision:"bad"}},{...state,lastReportSequence:-1},{...state,stale:2},{...state,activeInstanceId:"bad"},{...state,lastReportSequence:1},{...state,desired:{...state.desired,revision:`sha256:${"b".repeat(64)}`}},{...state,desired:{...state.desired,document:{}}},{...state,applied:undefined},{...state,applied:{...applied,extra:true}},{...state,applied:{...applied,sequence:0}},{...state,applied:{...applied,sequence:3}},{...state,applied:{...applied,revision:"bad"}},{...state,applied:{...applied,at:-1}}];
 for(const value of cases)await expect(validateDeploymentConfigurationState(value)).rejects.toThrow();
});
