import { expect,it } from "vitest";
import { validateDeploymentTarget,type DeploymentTarget } from "../src/deployment-target";
const target:DeploymentTarget={kind:"fly",managed:false,imageDigest:null,fly:{appName:"existing-app"}};
it("copies only a validated public target identity",()=>{
 expect(validateDeploymentTarget(target)).toEqual(target);
 const complete={...target,managed:true,imageDigest:`sha256:${"a".repeat(64)}`,fly:{...target.fly!,machineId:"abc123",region:"iad",orgSlug:"personal"}};
 const copy=validateDeploymentTarget(complete);copy.fly!.appName="changed";expect(complete.fly.appName).toBe("existing-app");
 expect(validateDeploymentTarget({...target,kind:"other",fly:null})).toEqual({...target,kind:"other",fly:null});
});
it("rejects unknown fields, unsafe identities and malformed optional target fields",()=>{
 const invalid=[null,[],{}, {...target,secret:"private"},{...target,kind:2},{...target,kind:"bad/kind"},{...target,managed:1},{...target,imageDigest:2},{...target,imageDigest:"tag:latest"},{...target,kind:"other"},{...target,fly:undefined},{...target,fly:[]},{...target,fly:{...target.fly,credentials:"private"}},{...target,fly:{appName:2}},{...target,fly:{appName:"bad\"name"}}];
 for(const field of ["machineId","region","orgSlug"])for(const value of [2,"bad/value"])invalid.push({...target,fly:{...target.fly,[field]:value}});
 for(const value of invalid)expect(()=>validateDeploymentTarget(value)).toThrow("Invalid deployment target");
});
