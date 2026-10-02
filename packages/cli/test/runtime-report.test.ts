import { expect,it,afterEach,vi } from "vitest";
import { mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,existsSync,mkdirSync,symlinkSync,readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileForwarderRuntime,exportDeploymentManifest,createSecretVersioner,hashConfigDocument,ServiceError,type ForwarderReportCheckpoint,type DeploymentAppliedReport,type ProviderDriver } from "@logtura/core";
import { reportLoadedForwarderFile,withForwarderReportFile,runForwarderReporting } from "../src/runtime-report";
const directories:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
async function fixture(){
 const directory=mkdtempSync(join(tmpdir(),"logt-report-"));directories.push(directory);
 const provider:ProviderDriver={id:"report-fixture",displayName:"Fixture",sourceLabel:"Fixture",capabilities:{selection:"list"},verifyCredentials:async()=>[],discoverSources:async()=>[],generatePipeline:()=>({components:[{key:"fixture",kind:"source",yaml:"    type: stdin\n"}],outputKey:"fixture",envVars:[],dockerfileDeps:[]})};
 const checkpoint=join(directory,"checkpoint.json"),input={providers:[provider],destinations:[],connections:[{connection:{id:"con_fixture",provider:provider.id,displayName:"Fixture",externalAccountId:null},selectedSources:[]}],monitors:[]};
 const exported=await exportDeploymentManifest(input,await createSecretVersioner("test-key"));
 const {artifact,bundle}=await compileForwarderRuntime({service:"https://service.test",deploymentId:"dep_test",document:exported.document,instance:{requestId:crypto.randomUUID(),instanceId:crypto.randomUUID(),configurationVersion:0,sequence:1,revision:await hashConfigDocument(exported.document)},env:exported.secretValues,providers:input.providers,destinations:[]});
 const observed={files:{"vector.yaml":bundle.vectorYaml},environment:{},generatorVersion:artifact.generatorVersion,vectorVersion:artifact.vectorVersion,ready:true};
 return {directory,checkpoint,artifact,observed};
}
it("persists intent privately before transport and resumes the same counter after a lost response",async()=>{
 const f=await fixture(),reports:DeploymentAppliedReport[]=[];
 await expect(reportLoadedForwarderFile({...f,report:async report=>{reports.push(report);expect(JSON.parse(readFileSync(f.checkpoint,"utf8"))).toMatchObject({pending:report,lastReportSequence:0});throw new TypeError("Connection lost");}})).rejects.toThrow("Connection lost");
 expect(statSync(f.checkpoint).mode&0o777).toBe(0o600);
 expect(await reportLoadedForwarderFile({...f,report:async report=>{reports.push(report);return false;}})).toEqual({accepted:false,reportSequence:1});expect(reports[0]).toEqual(reports[1]);
 expect(await reportLoadedForwarderFile({...f,report:async()=>true})).toEqual({accepted:true,reportSequence:2});
 expect(JSON.parse(readFileSync(f.checkpoint,"utf8"))).toMatchObject({pending:null,lastReportSequence:2,lastAccepted:true});expect(readdirSync(f.directory)).toEqual(["checkpoint.json"]);
});
it("serializes the complete report attempt and retains intent when the transport fails",async()=>{
 const f=await fixture();let release!:()=>void,started!:()=>void;
 const ready=new Promise<void>(resolve=>started=resolve),wait=new Promise<void>(resolve=>release=resolve);
 const first=reportLoadedForwarderFile({...f,report:async()=>{started();await wait;return true;}});await ready;
 await expect(reportLoadedForwarderFile({...f,report:async()=>true})).rejects.toThrow("Another forwarder report is still running");release();await first;
 expect(await reportLoadedForwarderFile({...f,report:async()=>true})).toEqual({accepted:true,reportSequence:2});
});
it("rejects corrupt, foreign and symbolic-link state without reporting or modifying unrelated files",async()=>{
 const f=await fixture(),report=vi.fn(async()=>true);
 writeFileSync(f.checkpoint,"private malformed file");await expect(reportLoadedForwarderFile({...f,report})).rejects.toThrow("Invalid private forwarder report file");
 writeFileSync(f.checkpoint,JSON.stringify({schemaVersion:1}));await expect(reportLoadedForwarderFile({...f,report})).rejects.toThrow("checkpoint");
 rmSync(f.checkpoint);await reportLoadedForwarderFile({...f,report:async()=>true});const state=JSON.parse(readFileSync(f.checkpoint,"utf8"));writeFileSync(f.checkpoint,JSON.stringify({...state,instanceId:crypto.randomUUID()}));await expect(reportLoadedForwarderFile({...f,report})).rejects.toThrow("checkpoint");
 const other=join(f.directory,"unrelated");writeFileSync(other,"keep-private");rmSync(f.checkpoint);symlinkSync(other,f.checkpoint);await expect(reportLoadedForwarderFile({...f,report})).rejects.toThrow();expect(readFileSync(other,"utf8")).toBe("keep-private");
 expect(report).not.toHaveBeenCalled();
});
it("removes only abandoned regular UUID stages and refuses unsafe directories or stages",async()=>{
 const f=await fixture(),stage=`${f.checkpoint}.${crypto.randomUUID()}.tmp`,other=`${f.checkpoint}.unrelated.tmp`;writeFileSync(stage,"abandoned");writeFileSync(other,"unrelated");
 await reportLoadedForwarderFile({...f,report:async()=>true});expect(readdirSync(f.directory)).toContain("checkpoint.json.unrelated.tmp");expect(readdirSync(f.directory)).not.toContain(stage.split("/").at(-1));
 symlinkSync(other,stage);await expect(reportLoadedForwarderFile({...f,report:async()=>true})).rejects.toThrow("regular files");
 const alias=join(f.directory,"alias");symlinkSync(f.directory,alias);await expect(withForwarderReportFile(join(alias,"report"),async()=>{})).rejects.toThrow("regular directory");
 await expect(withForwarderReportFile(join(other,"report"),async()=>{})).rejects.toThrow("regular directory");
 rmSync(stage);rmSync(f.checkpoint);mkdirSync(f.checkpoint);await expect(withForwarderReportFile(f.checkpoint,async store=>store.save({} as ForwarderReportCheckpoint))).rejects.toThrow("regular files");
 await expect(withForwarderReportFile(f.checkpoint,async store=>store.load())).rejects.toThrow("regular files");
});
it("fails before transport when loaded integrity or checkpoint persistence cannot be established",async()=>{
 const f=await fixture(),report=vi.fn(async()=>true);
 await expect(reportLoadedForwarderFile({...f,observed:{...f.observed,ready:false},report})).rejects.toThrow("issued artifact");expect(report).not.toHaveBeenCalled();expect(readdirSync(f.directory)).toEqual([]);
 // A serialization failure must preserve the old durable file and clean the stage.
 await reportLoadedForwarderFile({...f,report:async()=>true});const original=readFileSync(f.checkpoint,"utf8");const cyclic:any={};cyclic.self=cyclic;
 await expect(withForwarderReportFile(f.checkpoint,async store=>store.save(cyclic))).rejects.toThrow();expect(readFileSync(f.checkpoint,"utf8")).toBe(original);expect(readdirSync(f.directory)).toEqual(["checkpoint.json"]);
});
it("backs off transient transport failures, retries durable intent and refreshes observations",async()=>{
 const f=await fixture(),controller=new AbortController(),sequences:number[]=[],delays:number[]=[],results:unknown[]=[];let attempts=0;
 const observe=vi.fn(async()=>f.observed);vi.useFakeTimers();vi.spyOn(Math,"random").mockReturnValue(1);
 const running=runForwarderReporting({...f,observe,signal:controller.signal,intervalMs:10,retryMs:2,maxRetryMs:4,onRetry:delay=>delays.push(delay),onResult:result=>{results.push(result);if(results.length===2)controller.abort();},report:async value=>{sequences.push(value.reportSequence);attempts++;if(attempts===1)throw new TypeError("offline");if(attempts===2)throw new ServiceError(429,"rate_limited");if(attempts===3)throw new ServiceError(503,"unavailable");if(attempts===4)throw new DOMException("timeout","TimeoutError");return attempts!==5;}});
 await vi.runAllTimersAsync();await running;
 expect(delays).toEqual([2,4,4,4]);expect(sequences).toEqual([1,1,1,1,1,2]);expect(results).toEqual([{accepted:false,reportSequence:1},{accepted:true,reportSequence:2}]);expect(observe).toHaveBeenCalledTimes(6);
});
it("stops on authentication, integrity, local state and callback failures instead of retrying them",async()=>{
 const f=await fixture(),controller=new AbortController();
 for(const error of [new ServiceError(401,"unauthorized"),new Error("invalid response"),new DOMException("aborted","AbortError")])await expect(runForwarderReporting({...f,observe:async()=>f.observed,signal:controller.signal,report:async()=>{throw error;}})).rejects.toBe(error);
 await expect(runForwarderReporting({...f,observe:async()=>({...f.observed,ready:false}),signal:controller.signal,report:async()=>true})).rejects.toThrow("issued artifact");
 writeFileSync(f.checkpoint,"{}");await expect(runForwarderReporting({...f,observe:async()=>f.observed,signal:controller.signal,report:async()=>true})).rejects.toThrow("checkpoint");rmSync(f.checkpoint);
 const callback=new TypeError("callback failed");await expect(runForwarderReporting({...f,observe:async()=>f.observed,signal:controller.signal,report:async()=>true,onResult:()=>{throw callback;}})).rejects.toBe(callback);
 const report=vi.fn(async()=>true);await expect(runForwarderReporting({...f,checkpoint:undefined as unknown as string,observe:async()=>f.observed,signal:controller.signal,report})).rejects.toBeInstanceOf(TypeError);expect(report).not.toHaveBeenCalled();
});
it("honors stop before observation, during observation, during transport and during waiting",async()=>{
 const f=await fixture(),report=vi.fn(async()=>true),already=new AbortController();already.abort();const observe=vi.fn(async()=>f.observed);
 await runForwarderReporting({...f,signal:already.signal,observe,report});expect(observe).not.toHaveBeenCalled();
 const observing=new AbortController();await runForwarderReporting({...f,signal:observing.signal,observe:async()=>{observing.abort();return f.observed;},report});expect(report).not.toHaveBeenCalled();
 const sending=new AbortController();await runForwarderReporting({...f,signal:sending.signal,observe,report:async()=>{sending.abort();throw new TypeError("offline");}});expect(JSON.parse(readFileSync(f.checkpoint,"utf8")).pending.reportSequence).toBe(1);
 const waiting=new AbortController();const running=runForwarderReporting({...f,signal:waiting.signal,observe,report:async()=>true,onResult:()=>setImmediate(()=>waiting.abort())});await running;expect(JSON.parse(readFileSync(f.checkpoint,"utf8")).lastReportSequence).toBe(1);
});
it("validates bounded retry policy before reading state or sending",async()=>{
 const f=await fixture(),signal=new AbortController().signal,report=vi.fn(async()=>true);
 for(const policy of [{intervalMs:0},{intervalMs:1.5},{intervalMs:3_600_001},{retryMs:0},{maxRetryMs:0},{retryMs:10,maxRetryMs:1}])await expect(runForwarderReporting({...f,observe:async()=>f.observed,signal,report,...policy})).rejects.toThrow("interval");expect(report).not.toHaveBeenCalled();
});

for(const [method,boundary,nextCounter,accepted] of [["fsyncSync",1,1,true],["renameSync",1,1,true],["fsyncSync",2,1,true],["fsyncSync",3,1,false],["renameSync",2,2,true],["fsyncSync",4,2,true]] as const){
 it(`recovers a real writer killed after ${method} boundary ${boundary}`,async()=>{
  const f=await fixture(),deliveries=join(f.directory,"deliveries"),options={checkpoint:f.checkpoint,artifact:f.artifact,observed:f.observed};
  const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
   const sync=fs.fsyncSync,original=fs[${JSON.stringify(method)}];let count=0;
   fs[${JSON.stringify(method)}]=(...args)=>{original(...args);if(++count===${boundary})process.kill(process.pid,'SIGKILL')};syncBuiltinESMExports();
   const {reportLoadedForwarderFile}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname,"../src/runtime-report.ts")).href)});
   await reportLoadedForwarderFile({...${JSON.stringify(options)},report:async value=>{fs.appendFileSync(${JSON.stringify(deliveries)},value.reportSequence+'\\n');const fd=fs.openSync(${JSON.stringify(deliveries)},'r');sync(fd);fs.closeSync(fd);return true;}});`;
  const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{encoding:"utf8",timeout:10_000});
  expect(child.error).toBeUndefined();expect(child.stderr).toBe("");expect(child.signal).toBe("SIGKILL");
  const highest=existsSync(deliveries)?Math.max(...readFileSync(deliveries,"utf8").trim().split("\n").map(Number)):0;
  expect(await reportLoadedForwarderFile({...f,report:async value=>value.reportSequence>highest})).toEqual({reportSequence:nextCounter,accepted});
  const state=JSON.parse(readFileSync(f.checkpoint,"utf8"));expect(state.pending).toBeNull();expect(state.lastReportSequence).toBe(nextCounter);expect(readdirSync(f.directory).some(name=>name.endsWith(".lock") || name.endsWith(".tmp"))).toBe(false);
 });
}
