import {expect,it,afterEach} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {renderFlyLaunchScript} from "../src/fly-install";
import type {BundleEnvVar} from "../src/types";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(envVars:BundleEnvVar[],region?:string){
 const root=mkdtempSync(join(tmpdir(),"logtura-fly-script-"));roots.push(root);
 writeFileSync(join(root,"deploy.sh"),renderFlyLaunchScript({appName:"logtura-example",region,envVars}),{mode:0o700});
 writeFileSync(join(root,"flyctl"),'#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2))+"\\n");\n',{mode:0o755});
 const environment={...process.env,PATH:`${root}:${process.env.PATH}`,RECORD:join(root,"calls"),TOKEN:"",MISSING:""};
 const run=(extra:Record<string,string>={})=>spawnSync("bash",["deploy.sh"],{cwd:root,env:{...environment,...extra},encoding:"utf8"});
 const calls=()=>existsSync(join(root,"calls"))?readFileSync(join(root,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line) as string[]):[];
 return {root,run,calls};
}
const variable=(name:string,value:string|null):BundleEnvVar=>({name,value,source:"credential",description:"private"});
it.each(["plain", "quotes'\" spaces $VALUE `command` \\path", "first\nsecond", "$(touch injected)", "`touch injected`", "UTF-8 🔑"])("passes known credentials as literal argument data: %j", value=>{
 const f=fixture([variable("TOKEN",value)],"ord"),result=f.run();expect(result.status,result.stderr).toBe(0);
 expect(f.calls()).toEqual([["launch","--copy-config","--no-deploy","--name","logtura-example","--region","ord"],["secrets","set","--app","logtura-example",`TOKEN=${value}`],["deploy","--app","logtura-example"]]);
 expect(existsSync(join(f.root,"injected"))).toBe(false);expect(result.stdout).toBe("");
});
it.each([null, ""])("requires a missing value before any provider operation and accepts its literal inherited value: %j", value=>{
 const f=fixture([variable("MISSING",value)]);const failed=f.run();expect(failed.status).not.toBe(0);expect(failed.stderr).toContain("Set MISSING");expect(f.calls()).toEqual([]);
 const inherited="$(touch injected) ' \" first\nsecond",success=f.run({MISSING:inherited});expect(success.status,success.stderr).toBe(0);
 expect(f.calls()[0]).toEqual(["launch","--copy-config","--no-deploy","--name","logtura-example"]);
 expect(f.calls()[1]).toEqual(["secrets","set","--app","logtura-example",`MISSING=${inherited}`]);expect(existsSync(join(f.root,"injected"))).toBe(false);
});
it("creates and deploys a no-secret bundle without issuing an empty secrets command",()=>{
 const f=fixture([]),result=f.run();expect(result.status,result.stderr).toBe(0);expect(f.calls().map(call=>call[0])).toEqual(["launch","deploy"]);
});
it("keeps multiple secrets as separate arguments, including multiline values",()=>{
 const f=fixture([variable("TOKEN","first\nsecond"),variable("MISSING",null)]);expect(f.run({MISSING:"a=b c"}).status).toBe(0);
 expect(f.calls()[1]).toEqual(["secrets","set","--app","logtura-example","TOKEN=first\nsecond","MISSING=a=b c"]);
});
it.each(["bad\0value", undefined, 123])("rejects invalid credential values before rendering: %j",value=>{
 expect(()=>renderFlyLaunchScript({appName:"app",envVars:[variable("TOKEN",value as string)]})).toThrow("environment value");
});
it("validates provider identity and variable names for the script",()=>{
 expect(()=>renderFlyLaunchScript({appName:"app;run",envVars:[]})).toThrow("app name");
 expect(()=>renderFlyLaunchScript({appName:"app",region:null as unknown as string,envVars:[]})).toThrow("region");
 expect(()=>renderFlyLaunchScript({appName:"app",envVars:[variable("TOKEN;run","value")]})).toThrow("environment name");
});
