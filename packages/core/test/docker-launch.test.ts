import {expect,it,afterEach} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {renderDockerRunCommand} from "../src/docker-install";
import type {BundleEnvVar} from "../src/types";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(envVars:BundleEnvVar[]){
 const root=mkdtempSync(join(tmpdir(),"logtura-docker-script-"));roots.push(root);
 writeFileSync(join(root,"deploy.sh"),"#!/usr/bin/env bash\nset -euo pipefail\n" + renderDockerRunCommand(envVars),{mode:0o700});
 writeFileSync(join(root,"docker"),'#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2))+"\\n");\n',{mode:0o755});
 const environment={...process.env,PATH:`${root}:${process.env.PATH}`,RECORD:join(root,"calls"),TOKEN:"",MISSING:""};
 const run=(extra:Record<string,string>={})=>spawnSync("bash",["deploy.sh"],{cwd:root,env:{...environment,...extra},encoding:"utf8"});
 const calls=()=>existsSync(join(root,"calls"))?readFileSync(join(root,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line) as string[]):[];
 return {root,run,calls};
}
const variable=(name:string,value:string|null):BundleEnvVar=>({name,value,source:"credential",description:"private"});
it.each(["plain", "quotes'\" spaces $VALUE `command` \\path", "first\nsecond", "$(touch injected)", "`touch injected`", "UTF-8 🔑"])("passes Docker credentials as literal argv: %j", value=>{
 const f=fixture([variable("TOKEN",value)]),result=f.run();expect(result.status,result.stderr).toBe(0);
 expect(f.calls()).toEqual([["build","-t","logtura-forwarder","."],["run","--rm","-e",`TOKEN=${value}`,"logtura-forwarder"]]);
 expect(existsSync(join(f.root,"injected"))).toBe(false);expect(result.stdout).toBe("");
});
it.each([null, ""])("requires missing values before any Docker operation: %j", value=>{
 const f=fixture([variable("MISSING",value)]);const failed=f.run();expect(failed.status).not.toBe(0);expect(failed.stderr).toContain("Set MISSING");expect(f.calls()).toEqual([]);
 const inherited="$(touch injected) ' \" first\nsecond",success=f.run({MISSING:inherited});expect(success.status,success.stderr).toBe(0);
 expect(f.calls()[1]).toEqual(["run","--rm","-e",`MISSING=${inherited}`,"logtura-forwarder"]);expect(existsSync(join(f.root,"injected"))).toBe(false);
});
it("supports a no-secret image and keeps multiple secrets as separate arguments",()=>{
 const empty=fixture([]);expect(empty.run().status).toBe(0);expect(empty.calls()[1]).toEqual(["run","--rm","logtura-forwarder"]);
 const f=fixture([variable("TOKEN","first\nsecond"),variable("MISSING",null)]);expect(f.run({MISSING:"a=b c"}).status).toBe(0);
 expect(f.calls()[1]).toEqual(["run","--rm","-e","TOKEN=first\nsecond","-e","MISSING=a=b c","logtura-forwarder"]);
});
it.each(["bad\0value", undefined, 123])("rejects invalid values before rendering: %j",value=>{
 expect(()=>renderDockerRunCommand([variable("TOKEN",value as string)])).toThrow("environment value");
});
it.each(["BAD;run", undefined])("rejects invalid variable names: %j",name=>{
 expect(()=>renderDockerRunCommand([variable(name as string,"value")])).toThrow("environment name");
});
