import { expect,it } from "vitest";
import { linkedFlyTarget } from "../src/fly-target";
import type { DeploymentLink } from "../src/deployment-link";
const link={target:{kind:"fly",managed:false,imageDigest:null,fly:{appName:"existing-app",region:"ord",orgSlug:"personal",machineId:"abc123"}}} as DeploymentLink;
it("retains the app/region/organization of a website deployment",()=>{
 expect(linkedFlyTarget(link,{})).toEqual({appName:"existing-app",region:"ord",org:"personal",existingOnly:true});
 expect(linkedFlyTarget(link,{app:"existing-app",region:"ord",org:"personal"})).toEqual(linkedFlyTarget(link,{}));
 const minimal={...link,target:{...link.target!,fly:{appName:"existing-app"}}};expect(linkedFlyTarget(minimal,{})).toEqual({appName:"existing-app",region:"iad",existingOnly:true});
 expect(linkedFlyTarget(minimal,{region:"lhr",org:"my-org"})).toMatchObject({region:"lhr",org:"my-org"});
 const unresolved={...link,target:{...link.target!,fly:null}};expect(linkedFlyTarget(unresolved,{app:"legacy-app"})).toEqual({appName:"legacy-app",region:"iad",existingOnly:true});
 for(const options of [{},{app:"bad/app"}])expect(()=>linkedFlyTarget(unresolved,options)).toThrow("requires --app");
 for(const options of [{app:"another-app"},{region:"iad"},{org:"another-org"}])expect(()=>linkedFlyTarget(link,options)).toThrow("conflict");
 for(const options of [{region:"bad/region"},{org:"bad/org"}])expect(()=>linkedFlyTarget(minimal,options)).toThrow("Invalid Fly");
 expect(()=>linkedFlyTarget({...link,target:undefined},{})).toThrow("Pull again");expect(()=>linkedFlyTarget({...link,target:{...link.target!,kind:"other",fly:null}},{})).toThrow("does not target");expect(()=>linkedFlyTarget({...link,target:{...link.target!,managed:true}},{})).toThrow("Managed forwarders");
});
