import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { commitFileTransaction, recoverFileTransaction, transactionPath } from "../src/file-transaction";
import { writePulledConfig } from "../src/pull";
import { main } from "../src/main";
import { exportDeploymentManifest, createSecretVersioner, hashConfigDocument } from "@logtura/core";
vi.mock("node:fs", {spy:true});
const native=await vi.importActual<typeof fs>("node:fs");
const roots:string[]=[];
afterEach(()=>{vi.mocked(fs.renameSync).mockReset();vi.mocked(fs.rmSync).mockReset();vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(original=true){
 const root=mkdtempSync(join(tmpdir(),"logtura-journal-"));roots.push(root);const config=join(root,"logt.yaml"),tag=randomUUID();
 const files=[join(root,".env"),config].map((target,i)=>({target,stage:`${target}.${tag}.tmp`,backup:`${target}.${tag}.bak`,existed:original}));
 for(const [i,file] of files.entries()){if(original)writeFileSync(file.target,`old-${i}`,{mode:i===0?0o600:0o644});writeFileSync(file.stage,`new-${i}`,{mode:i===0?0o600:0o644});}
 return {root,config,files};
}
function journal(f:ReturnType<typeof fixture>,overrides:Record<string,unknown>={}){
 writeFileSync(transactionPath(f.config),JSON.stringify({schemaVersion:1,pid:2147483647,committed:false,files:f.files,...overrides}),{mode:0o600});
}
it.each([1,2,3,4,5])("recovers a real process killed after rename %i without mixing file revisions",(stop)=>{
 const f=fixture();const module=new URL("../src/file-transaction.ts",import.meta.url).href;
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';let count=0;const rename=fs.renameSync;fs.renameSync=(...args)=>{rename(...args);if(++count===${stop})process.kill(process.pid,'SIGKILL')};syncBuiltinESMExports();const {commitFileTransaction}=await import(${JSON.stringify(module)});commitFileTransaction(${JSON.stringify(f.config)},${JSON.stringify(f.files)});`;
 const result=spawnSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",script],{encoding:"utf8"});
 expect(result.error).toBeUndefined();expect(result.signal,result.stderr).toBe("SIGKILL");expect(statSync(transactionPath(f.config)).mode&0o777).toBe(0o600);
 expect(recoverFileTransaction(f.config)).toBe(true);
 for(const [i,file] of f.files.entries())expect(readFileSync(file.target,"utf8")).toBe(`${stop===5?"new":"old"}-${i}`);
 expect(statSync(f.files[0]!.target).mode&0o777).toBe(0o600);expect(readdirSync(f.root)).toEqual([".env","logt.yaml"]);expect(recoverFileTransaction(f.config)).toBe(false);
});
it("removes newly installed files when an interrupted initial write had no originals",()=>{
 const f=fixture(false);journal(f);fs.renameSync(f.files[0]!.stage,f.files[0]!.target);
 expect(recoverFileTransaction(f.config)).toBe(true);expect(readdirSync(f.root)).toEqual([]);
});
it("recovers partially restored originals and rejects live or unverifiable owners",()=>{
 const f=fixture();journal(f,{pid:process.pid});expect(()=>recoverFileTransaction(f.config)).toThrow("still running");
 journal(f);const kill=vi.spyOn(process,"kill").mockImplementation(()=>{throw Object.assign(new Error("private"),{code:"EPERM"});});
 expect(()=>recoverFileTransaction(f.config)).toThrow("Cannot verify");expect(existsSync(transactionPath(f.config))).toBe(true);kill.mockRestore();
 fs.renameSync(f.files[1]!.target,f.files[1]!.backup);fs.renameSync(f.files[1]!.stage,f.files[1]!.target);
 const actual=native.renameSync;vi.spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(from).endsWith(".bak"))throw new Error("unwritable");return actual(from,to);});
 expect(()=>recoverFileTransaction(f.config)).toThrow("rollback incomplete");expect(existsSync(f.files[1]!.backup)).toBe(true);
 vi.mocked(fs.renameSync).mockReset();vi.restoreAllMocks();expect(recoverFileTransaction(f.config)).toBe(true);expect(readFileSync(f.config,"utf8")).toBe("old-1");
});
it.each([null,{}, {schemaVersion:2}, {pid:-1}, {committed:"yes"}, {files:[]}, {files:[null,null]}])("retains malformed journals without changing destinations (%j)",(value)=>{
 const f=fixture();journal(f,value===null?{}:value);if(value===null)writeFileSync(transactionPath(f.config),"{broken");else if(Object.keys(value).length===0)writeFileSync(transactionPath(f.config),"{}");
 expect(()=>recoverFileTransaction(f.config)).toThrow("Invalid configuration");expect(readFileSync(f.config,"utf8")).toBe("old-1");expect(existsSync(transactionPath(f.config))).toBe(true);
});
it("rejects forged destination paths, stage/backup paths, and symlink recovery artifacts",()=>{
 for(const patch of [{target:"/tmp/foreign"},{stage:"/tmp/foreign.tmp"},{backup:"/tmp/foreign.bak"},{existed:"yes"}]){
 const f=fixture();journal(f,{files:[{...f.files[0],...patch},f.files[1]]});expect(()=>recoverFileTransaction(f.config)).toThrow("Invalid");
 }
 const f=fixture();journal(f);rmSync(f.files[0]!.stage);symlinkSync(f.config,f.files[0]!.stage);
 expect(()=>recoverFileTransaction(f.config)).toThrow("regular");expect(readFileSync(f.config,"utf8")).toBe("old-1");
});
it("retains a committed pair if cleanup fails and recovers its backups afterward",()=>{
 const f=fixture();const actual=native.rmSync;vi.spyOn(fs,"rmSync").mockImplementation((path,options)=>{if(String(path).endsWith(".bak"))throw new Error("cleanup failed");return actual(path,options);});
 expect(()=>commitFileTransaction(f.config,f.files)).toThrow("committed");expect(readFileSync(f.config,"utf8")).toBe("new-1");
 vi.mocked(fs.renameSync).mockReset();vi.mocked(fs.rmSync).mockReset();vi.restoreAllMocks();const stored=JSON.parse(readFileSync(transactionPath(f.config),"utf8"));journal(f,{...stored,pid:2147483647});
 expect(recoverFileTransaction(f.config)).toBe(true);expect(readFileSync(f.config,"utf8")).toBe("new-1");expect(readdirSync(f.root)).toEqual([".env","logt.yaml"]);
});
it("does not restore stale originals if a failure occurs after commit-marker replacement",()=>{
 const f=fixture();const actual=native.renameSync;vi.spyOn(fs,"renameSync").mockImplementation((from,to)=>{actual(from,to);if(String(from).endsWith(".commit"))throw new Error("post-rename failure");});
 expect(()=>commitFileTransaction(f.config,f.files)).toThrow("retained for recovery");expect(readFileSync(f.config,"utf8")).toBe("new-1");
 vi.mocked(fs.renameSync).mockReset();vi.mocked(fs.rmSync).mockReset();vi.restoreAllMocks();const stored=JSON.parse(readFileSync(transactionPath(f.config),"utf8"));journal(f,{...stored,pid:2147483647});expect(recoverFileTransaction(f.config)).toBe(true);expect(readFileSync(f.config,"utf8")).toBe("new-1");
});
it("blocks further pulls while recovery is pending and exposes recovery through the CLI",async()=>{
 const f=fixture();journal(f);const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner("test"));
 await expect(writePulledConfig({...exported,revision:await hashConfigDocument(exported.document),deployment:{id:"local",displayName:"Local"}},f.config,true)).rejects.toThrow("pending");
 const output=vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});
 expect(await main(["-c",f.config,"config","recover","--json"])).toBe(0);expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({path:f.config,recovered:true});
 expect(await main(["-c",f.config,"config","recover"])).toBe(0);expect(output.mock.calls.at(-1)![0]).toBe("No interrupted configuration write");
 expect(await main(["-c",f.config,"config","recover","extra"])).toBe(1);
});
it("refuses reads and edits for every config sharing an interrupted companion environment",async()=>{
 const f=fixture();journal(f);const {loadConfigFile,readConfigDoc,writeConfigDoc,readConfigEnvironment}=await import("../src/config");
 const alternate=join(f.root,"another.yaml");writeFileSync(alternate,"providers: {}\n");
 for(const path of [f.config,alternate]){
 expect(()=>loadConfigFile(path)).toThrow("pending");expect(()=>readConfigDoc(path)).toThrow("pending");expect(()=>readConfigEnvironment(path)).toThrow("pending");expect(()=>writeConfigDoc(path,{})).toThrow("pending");
 }
 expect(()=>recoverFileTransaction(alternate)).toThrow("Invalid");expect(readFileSync(alternate,"utf8")).toBe("providers: {}\n");
});
it("retains backups when a committed destination is missing rather than deleting the last copy",()=>{
 const f=fixture();fs.renameSync(f.files[1]!.target,f.files[1]!.backup);journal(f,{committed:true});
 expect(()=>recoverFileTransaction(f.config)).toThrow("missing a destination");expect(readFileSync(f.files[1]!.backup,"utf8")).toBe("old-1");
});
it("commits an initial pair without originals and skips unsupported directory fsync on Windows",()=>{
 const f=fixture(false);vi.stubGlobal("process",{...process,platform:"win32"});
 try{commitFileTransaction(f.config,f.files);}finally{vi.unstubAllGlobals();}
 expect(readFileSync(f.config,"utf8")).toBe("new-1");expect(readdirSync(f.root)).toEqual([".env","logt.yaml"]);
});
it("holds the shared-directory lock during preparation and cleans up failed preparation",()=>{
 const f=fixture();let prepared=false;
 expect(()=>commitFileTransaction(f.config,f.files,()=>{
  prepared=true;expect(existsSync(transactionPath(f.config))).toBe(true);
  expect(()=>commitFileTransaction(join(f.root,"other.yaml"),f.files,()=>{throw new Error("must not run");})).toThrow(/EEXIST/);
  throw new Error("preparation failed");
 })).toThrow("preparation failed");
 expect(prepared).toBe(true);expect(readFileSync(f.config,"utf8")).toBe("old-1");expect(readFileSync(f.files[0]!.target,"utf8")).toBe("old-0");expect(readdirSync(f.root)).toEqual([".env","logt.yaml"]);
});
it.each([1,2,3,4,5,6,7])("recovers a linked three-file transaction killed after rename %i",(stop)=>{
 const f=fixture(),target=`${f.config}.logtura-link.json`,tag=randomUUID();
 const link={target,stage:`${target}.${tag}.tmp`,backup:`${target}.${tag}.bak`,existed:true};f.files.push(link);writeFileSync(target,"old-2",{mode:0o600});writeFileSync(link.stage,"new-2",{mode:0o600});
 const module=new URL("../src/file-transaction.ts",import.meta.url).href;
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';let count=0;const rename=fs.renameSync;fs.renameSync=(...args)=>{rename(...args);if(++count===${stop})process.kill(process.pid,'SIGKILL')};syncBuiltinESMExports();const {commitFileTransaction}=await import(${JSON.stringify(module)});commitFileTransaction(${JSON.stringify(f.config)},${JSON.stringify(f.files)});`;
 const result=spawnSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",script],{encoding:"utf8"});expect(result.signal,result.stderr).toBe("SIGKILL");expect(recoverFileTransaction(f.config)).toBe(true);
 for(const [i,file] of f.files.entries())expect(readFileSync(file.target,"utf8")).toBe(`${stop===7?"new":"old"}-${i}`);expect(statSync(target).mode&0o777).toBe(0o600);expect(readdirSync(f.root)).toEqual([".env","logt.yaml","logt.yaml.logtura-link.json"]);
});
it("rejects configuration paths reserved for shared private transaction state",()=>{
 const f=fixture();for(const name of [".env",".logtura-transaction.json",".logtura-transaction.json.commit"])expect(()=>commitFileTransaction(join(f.root,name),f.files)).toThrow("reserved");expect(readFileSync(f.config,"utf8")).toBe("old-1");
});

it("refuses recovery when the config destination aliases the journal or companion environment",()=>{
 const f=fixture();journal(f);
 for(const name of [".env",".logtura-transaction.json",".logtura-transaction.json.commit"])expect(()=>recoverFileTransaction(join(f.root,name))).toThrow("reserved");
 expect(readFileSync(f.config,"utf8")).toBe("old-1");expect(existsSync(transactionPath(f.config))).toBe(true);
});
