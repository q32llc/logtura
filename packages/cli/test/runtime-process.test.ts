import { expect,it,afterEach,vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync,existsSync,mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileForwarderRuntime,exportDeploymentManifest,createSecretVersioner,hashConfigDocument,type ProviderDriver } from "@logtura/core";
import { runForwarderProcess } from "../src/runtime-process";
import { forwarderRuntimeMain } from "../src/runtime-main";
vi.mock("node:fs",{spy:true});
const directories:string[]=[];
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
async function waitForFile(path:string){const deadline=Date.now()+3000;while(!existsSync(path)){if(Date.now()>deadline)throw new Error("Fake process phase not reached");await new Promise(resolve=>setTimeout(resolve,10));}}
async function fixture(mode="normal"){
 const directory=mkdtempSync(join(tmpdir(),"logt-process-"));directories.push(directory);
 const provider:ProviderDriver={id:"process-fixture",displayName:"Fixture",sourceLabel:"Fixture",capabilities:{selection:"list"},verifyCredentials:async()=>[],discoverSources:async()=>[],generatePipeline:()=>({components:[{key:"fixture",kind:"source",yaml:"    type: stdin\n"}],outputKey:"fixture",envVars:[],dockerfileDeps:[],runtimeAssets:mode==="asset"?[{path:"missing.bin",content:new Uint8Array([0,255])}]:[]})};
 const exported=await exportDeploymentManifest({providers:[provider],destinations:[],connections:[{connection:{id:"con_fixture",provider:provider.id,displayName:"Fixture",externalAccountId:null},selectedSources:[]}],monitors:[]},await createSecretVersioner("key"));
 const {artifact,bundle}=await compileForwarderRuntime({service:"https://service.test",deploymentId:"dep_fixture",document:exported.document,instance:{requestId:crypto.randomUUID(),instanceId:crypto.randomUUID(),configurationVersion:0,sequence:1,revision:await hashConfigDocument(exported.document)},env:exported.secretValues,providers:[provider],destinations:[]});
 writeFileSync(join(directory,"vector.yaml"),bundle.vectorYaml);const vector=join(directory,"fake-vector"),capture=join(directory,"capture.json");
 const script=`#!${process.execPath}
 const fs=require('node:fs');
 if(process.argv.includes('--version')){if(${JSON.stringify(mode)}==='slow-version'){fs.writeFileSync(${JSON.stringify(join(directory,'version-started'))},'started');const deadline=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(join(directory,'version-release'))}) && Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}if(${JSON.stringify(mode)}==='version-fail')process.exit(1);if(${JSON.stringify(mode)}==='disappear')fs.unlinkSync(__filename);console.log(${JSON.stringify(mode)}==='bad-version'?'unknown version':'vector '+(${JSON.stringify(mode)}==='wrong-version'?'0.1.0':'0.55.0'));process.exit(0);}
 if(${JSON.stringify(mode)}==='hang')process.on('SIGTERM',()=>{});
 fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),env:process.env}));
 if(${JSON.stringify(mode)}==='exit')process.exit(1);
 if(!['silent','hang'].includes(${JSON.stringify(mode)})){
  process.stderr.write('not JSON\\n'+'x'.repeat(70000)+'\\n');
  const event=new Date().toISOString()+' INFO '+(${JSON.stringify(mode)}==='foreign'?'unrelated':'vector::internal_events::api')+': API server running. address='+(${JSON.stringify(mode)}==='wrong-address'?'0.0.0.0:9999':'0.0.0.0:8686');
  const data=event+'\\n';process.stderr.write(data.slice(0,10));setTimeout(()=>process.stderr.write(data.slice(10)),10);
 }
 setInterval(()=>{},1000);
 `;writeFileSync(vector,script,{mode:0o755});const stop=new AbortController(),report=vi.fn(async()=>true);
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({ok:true})));
 return {directory,configDirectory:directory,checkpoint:join(directory,"checkpoint.json"),artifact,vector,signal:stop.signal,report,capture,stop};
}
it("owns an immutable YAML snapshot, sanitized launch environment and child startup before reporting",async()=>{
 const f=await fixture();let ready=false;
 await runForwarderProcess({...f,environment:{VECTOR_CONFIG:"unrelated.yaml",VECTOR_CONFIG_DIR:"/private",VECTOR_WATCH_CONFIG:"true",VECTOR_DISABLE_ENV_VAR_INTERPOLATION:"true",VECTOR_LOG:"off"},onReady:()=>{ready=true;},onResult:()=>f.stop.abort()});
 expect(ready).toBe(true);expect(f.report).toHaveBeenCalledOnce();const captured=JSON.parse(readFileSync(f.capture,"utf8"));expect(captured.args).toContain("--log-format");expect(captured.args).not.toContain("--watch-config");expect(captured.args[1]).not.toBe(join(f.directory,"vector.yaml"));expect(captured.env).toMatchObject({VECTOR_LOG:"info"});for(const key of ["VECTOR_CONFIG","VECTOR_CONFIG_DIR","VECTOR_WATCH_CONFIG","VECTOR_DISABLE_ENV_VAR_INTERPOLATION"])expect(captured.env[key]).toBeUndefined();expect(readdirSync(f.directory).some(name=>name.startsWith(".logtura-runtime-") || name.endsWith(".lock"))).toBe(false);expect(()=>process.kill(captured.pid,0)).toThrow();
});
it("rejects changed files and incompatible versions before starting a reporting process",async()=>{
 const changed=await fixture();writeFileSync(join(changed.directory,"vector.yaml"),"changed");await expect(runForwarderProcess(changed)).rejects.toThrow("file differs");expect(changed.report).not.toHaveBeenCalled();
 for(const mode of ["wrong-version","version-fail"]){const f=await fixture(mode);await expect(runForwarderProcess(f)).rejects.toThrow(/Vector version/);expect(f.report).not.toHaveBeenCalled();expect(existsSync(f.capture)).toBe(false);}
 const f=await fixture();rmSync(join(f.directory,"vector.yaml"));await expect(runForwarderProcess(f)).rejects.toThrow("Cannot read installed");
});
it("requires its own API bind event even if an unrelated health endpoint responds successfully",async()=>{
 for(const mode of ["silent","foreign","wrong-address"]){const f=await fixture(mode);await expect(runForwarderProcess({...f,startupMs:120,shutdownMs:50})).rejects.toThrow("startup timed out");expect(f.report).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();}
});
it("cleans up version-to-launch disappearance, unexpected exit and diagnostics failures",async()=>{
 for(const mode of ["disappear","exit"]){const f=await fixture(mode);await expect(runForwarderProcess({...f,shutdownMs:50})).rejects.toThrow("stopped unexpectedly");expect(f.report).not.toHaveBeenCalled();expect(readdirSync(f.directory).some(name=>name.startsWith(".logtura-runtime-"))).toBe(false);}
 const f=await fixture();await expect(runForwarderProcess({...f,diagnostics:()=>{throw new Error("private diagnostic failure");}})).rejects.toThrow("stopped unexpectedly");expect(f.report).not.toHaveBeenCalled();
});
it("honors stop during startup and forcibly stops an unresponsive owned process group",async()=>{
 const f=await fixture("hang"),running=runForwarderProcess({...f,shutdownMs:50});await waitForFile(f.capture);f.stop.abort();await running;expect(f.report).not.toHaveBeenCalled();if(existsSync(f.capture)){const pid=JSON.parse(readFileSync(f.capture,"utf8")).pid;expect(()=>process.kill(pid,0)).toThrow();}
 const already=await fixture();already.stop.abort();await runForwarderProcess(already);expect(existsSync(already.capture)).toBe(false);
});
it("fails closed on unhealthy runtime observations and validates timeout bounds",async()=>{
 const f=await fixture();vi.stubGlobal("fetch",vi.fn(async()=>Response.json({}, {status:503})));await expect(runForwarderProcess({...f,startupMs:120})).rejects.toThrow("timed out");expect(f.report).not.toHaveBeenCalled();
 for(const options of [{startupMs:0},{startupMs:1.5},{shutdownMs:300001}])await expect(runForwarderProcess({...f,...options})).rejects.toThrow("timeout");
});
it("runtime CLI help and malformed/private file failures do not expose input values",async()=>{
 const out=vi.spyOn(console,"log").mockImplementation(()=>{}),error=vi.spyOn(console,"error").mockImplementation(()=>{});
 expect(await forwarderRuntimeMain(["--help"])).toBe(0);expect(out).toHaveBeenCalledWith(expect.stringContaining("logt-forwarder"));
 for(const args of [[],["--unknown","private-token"],["--artifact"],["--artifact","--checkpoint"],["--artifact","/missing","--artifact","/other"]])expect(await forwarderRuntimeMain(args)).toBe(1);
 const f=await fixture(),artifact=join(f.directory,"artifact.json");expect(await forwarderRuntimeMain(["--artifact",f.directory])).toBe(1);writeFileSync(artifact," ".repeat(1_048_577));expect(await forwarderRuntimeMain(["--artifact",artifact])).toBe(1);writeFileSync(artifact,"private malformed input");expect(await forwarderRuntimeMain(["--artifact",artifact])).toBe(1);writeFileSync(artifact,JSON.stringify(f.artifact));vi.stubEnv("LOGTURA_HEARTBEAT_TOKEN","");expect(await forwarderRuntimeMain(["--artifact",artifact])).toBe(1);
 expect(error.mock.calls.flat().every(value=>value==="Forwarder runtime failed; retain private state for recovery")).toBe(true);
});

it("runs the runtime CLI with private reporting authority and removes its signal handlers",async()=>{
 const f=await fixture(),artifact=join(f.directory,"artifact.json");writeFileSync(artifact,JSON.stringify(f.artifact));vi.stubEnv("LOGTURA_HEARTBEAT_TOKEN","fixture-report-token");
 vi.spyOn(process.stderr,"write").mockImplementation(()=>true);
 const output=vi.spyOn(console,"log").mockImplementation(()=>{}),errors=vi.spyOn(console,"error").mockImplementation(()=>{}),listeners=process.listenerCount("SIGTERM");
 vi.stubGlobal("fetch",vi.fn(async(url,init)=>{if(String(url).includes("/api/applied/")){expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-report-token");process.listeners("SIGTERM").at(-1)!("SIGTERM");return Response.json({accepted:true});}return Response.json({ok:true});}));
 expect(await forwarderRuntimeMain(["--artifact",artifact,"--checkpoint",f.checkpoint,"--config-directory",f.directory,"--vector",f.vector,"--interval-ms","5","--retry-ms","2"])).toBe(0);
 expect(output).toHaveBeenCalledWith(JSON.stringify({event:"applied_report",reportSequence:1,accepted:true}));expect(errors).not.toHaveBeenCalled();expect(process.listenerCount("SIGTERM")).toBe(listeners);
 writeFileSync(join(f.directory,"vector"),readFileSync(f.vector),{mode:0o755});vi.stubEnv("PATH",`${f.directory}:${process.env.PATH}`);
 expect(await forwarderRuntimeMain(["--artifact",artifact,"--checkpoint",f.checkpoint])).toBe(0);
 expect(JSON.parse(readFileSync(f.checkpoint,"utf8")).lastReportSequence).toBe(2);

 // An unwritable default state volume fails before starting Vector or reporting.
 vi.mocked(fs.mkdirSync).mockImplementationOnce(()=>{throw new Error("Read-only state volume");});expect(await forwarderRuntimeMain(["--artifact",artifact])).toBe(1);
});

it("retains its snapshot if the OS refuses process-group cleanup",async()=>{
 const f=await fixture(),kill=process.kill.bind(process);const spy=vi.spyOn(process,"kill").mockImplementation((pid,signal)=>{if(signal==="SIGTERM")throw Object.assign(new Error("Permission denied"),{code:"EPERM"});return kill(pid,signal);});
 try{await expect(runForwarderProcess({...f,onResult:()=>f.stop.abort()})).rejects.toThrow("Cannot stop owned Vector process group");expect(readdirSync(f.directory).some(name=>name.startsWith(".logtura-runtime-"))).toBe(true);}
 finally{spy.mockRestore();if(existsSync(f.capture)){const pid=JSON.parse(readFileSync(f.capture,"utf8")).pid;kill(-pid,"SIGKILL");await new Promise(resolve=>setTimeout(resolve,30));}}
});
it("observes health loss and callback failures, and keeps its YAML independent of later edits",async()=>{
 const f=await fixture();await runForwarderProcess({...f,onReady:()=>writeFileSync(join(f.directory,"vector.yaml"),"later edit"),onResult:()=>f.stop.abort()});expect(f.report).toHaveBeenCalledOnce();
 const failed=await fixture();await expect(runForwarderProcess({...failed,onReady:()=>{vi.stubGlobal("fetch",vi.fn(async()=>{throw new TypeError("health unavailable");}));}})).rejects.toThrow("not the issued artifact");expect(failed.report).not.toHaveBeenCalled();
 const callback=await fixture();await expect(runForwarderProcess({...callback,onReady:()=>{throw new Error("Ready callback failed");}})).rejects.toThrow("Ready callback failed");expect(callback.report).not.toHaveBeenCalled();
});

it("rejects unsupported platforms and unsafe installed file types",async()=>{
 const f=await fixture(),platform=process.platform;
 try{Object.defineProperty(process,"platform",{value:"win32"});await expect(runForwarderProcess(f)).rejects.toThrow("POSIX");}finally{Object.defineProperty(process,"platform",{value:platform});}
 rmSync(join(f.directory,"vector.yaml"));mkdirSync(join(f.directory,"vector.yaml"));await expect(runForwarderProcess(f)).rejects.toThrow("Cannot read installed");
 const asset=await fixture("asset");await expect(runForwarderProcess(asset)).rejects.toThrow("Cannot read installed");expect(asset.report).not.toHaveBeenCalled();
 const version=await fixture("bad-version");await expect(runForwarderProcess(version)).rejects.toThrow("Vector version differs");expect(version.report).not.toHaveBeenCalled();
});
it("honors stop during version discovery and just before child launch",async()=>{
 const f=await fixture("slow-version"),running=runForwarderProcess(f);await waitForFile(join(f.directory,"version-started"));f.stop.abort();writeFileSync(join(f.directory,"version-release"),"release");await running;expect(existsSync(f.capture)).toBe(false);expect(f.report).not.toHaveBeenCalled();
 const beforeLaunch=await fixture(),write=fs.writeFileSync;const spy=vi.spyOn(fs,"writeFileSync").mockImplementationOnce((...args)=>{write(...args);beforeLaunch.stop.abort();});
 try{await runForwarderProcess(beforeLaunch);expect(beforeLaunch.report).not.toHaveBeenCalled();expect(existsSync(beforeLaunch.capture)).toBe(false);}finally{spy.mockRestore();}
});
