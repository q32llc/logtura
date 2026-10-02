import { mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it,afterEach,vi } from "vitest";
import * as cp from "node:child_process";
import { exportDeploymentManifest,createSecretVersioner,hashConfigDocument } from "@logtura/core";
import { createDeploymentLink } from "../src/deployment-link";
import { writePulledConfig } from "../src/pull";
import { main } from "../src/main";
vi.mock("node:child_process",{spy:true});
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(linked=true){
 const root=mkdtempSync(join(tmpdir(),"logtura-fly-update-"));roots.push(root);const path=join(root,"logt.yaml"),out=join(root,"out");
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[{connection:{id:"con_worker",provider:"cloudflare-worker-tail",displayName:"Workers",externalAccountId:"account"},credentials:{apiToken:"private-token"},selectedSources:[{id:"src_worker",externalId:"worker",displayName:"Worker",sourceKind:"cf_worker",metadata:null}]}],monitors:[]},await createSecretVersioner("key"));
 const result={...exported,revision:await hashConfigDocument(exported.document),configurationVersion:1,desiredSequence:1,deployment:{id:"dep_target",displayName:"Website label"},target:{kind:"fly",managed:false,imageDigest:null,fly:{appName:"existing-forwarder",region:"ord",orgSlug:"personal"}}};
 const link=await createDeploymentLink("https://service.test","usr_target",result);await writePulledConfig(result,path,false,linked?link:undefined);
 return {path,out,result,root};
}
function mock(status=0){return vi.mocked(cp.spawnSync).mockReset().mockImplementation((command,args,options)=>({status:command==="flyctl" && args?.[0]==="status" && options?.stdio==="ignore"?status:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),pid:1,output:[],signal:null}));}
it("deploys a clean linked graph into its existing Fly app without creating a replacement",async()=>{
 const f=await fixture(),spawn=mock();expect(await main(["-c",f.path,"deploy","fly","--output",f.out])).toBe(0);
 const calls=spawn.mock.calls.filter(([c])=>c==="flyctl");expect(calls.map(([,args])=>args?.[0])).toEqual(["version","status","secrets","deploy","status"]);
 expect(calls.slice(1).every(([,args])=>args?.includes("existing-forwarder"))).toBe(true);expect(readFileSync(join(f.out,"fly.toml"),"utf8")).toContain('primary_region = "ord"');
});
it("refuses creation when a linked app is missing or inaccessible",async()=>{
 const f=await fixture(),spawn=mock(1);expect(await main(["-c",f.path,"deploy","fly","--output",f.out])).toBe(1);expect(spawn.mock.calls.some(([,args])=>args?.[0]==="apps" || args?.[0]==="deploy")).toBe(false);
});
it("rejects conflicting targets and unsynchronized local edits before deployment artifacts or credentials change",async()=>{
 const f=await fixture(),spawn=mock();expect(await main(["-c",f.path,"deploy","fly","--app","different-app","--output",f.out,"--write-env"])).toBe(1);expect(existsSync(f.out)).toBe(false);expect(spawn).not.toHaveBeenCalled();
 const document=structuredClone(f.result.document);document.connections[0]!.connection.displayName="Local edit";writeFileSync(f.path,JSON.stringify(document));expect(await main(["-c",f.path,"deploy","fly","--output",f.out])).toBe(1);expect(spawn).not.toHaveBeenCalled();
});
it("preserves standalone creation through flyctl without service login",async()=>{
 const f=await fixture(false),spawn=mock(1);expect(await main(["-c",f.path,"deploy","fly","--app","standalone-app","--org","my-org","--region","lhr","--output",f.out])).toBe(0);
 expect(spawn.mock.calls.find(([,args])=>args?.[0]==="apps")?.[1]).toEqual(["apps","create","standalone-app","--org","my-org"]);
});
