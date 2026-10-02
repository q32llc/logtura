import { spawn,execFile,type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { constants,openSync,readFileSync,closeSync,fstatSync,lstatSync,mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { dirname,resolve,join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import { validateForwarderRuntimeArtifact,verifyLoadedForwarder,GENERATOR_VERSION,VECTOR_VERSION,type ForwarderRuntimeArtifact,type LoadedForwarderObservation,type DeploymentAppliedReport } from "@logtura/core";
import { runForwarderReporting } from "./runtime-report";
import { withPrivateDirectoryLock } from "./private-lock";

function readRegular(path:string):Uint8Array {
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{if(!fstatSync(fd).isFile() || !lstatSync(path).isFile())throw new Error();return readFileSync(fd);}finally{closeSync(fd);}
}
function installedFiles(artifact:ForwarderRuntimeArtifact,config:string,assets:string):Record<string,Uint8Array>{
 try{return Object.fromEntries(Object.keys(artifact.files).map(name=>[name,readRegular(name==="vector.yaml"?config:resolve(assets,name.slice("assets/".length)))]));}catch{throw new Error("Cannot read installed forwarder files");}
}
function duration(value:number):number {if(!Number.isSafeInteger(value) || value<1 || value>300_000)throw new Error("Invalid forwarder process timeout");return value;}
/** Own Vector's config snapshot, launch environment, startup event and lifecycle.
 * Installed assets stay at the generated /opt/logtura/assets paths and are checked
 * again on every report. Container runtimes should mount/bake those assets read-only. */
export async function runForwarderProcess(options:{artifact:unknown;configDirectory:string;checkpoint:string;environment?:Record<string,string|undefined>;vector?:string;signal:AbortSignal;report:(value:DeploymentAppliedReport)=>Promise<boolean>;startupMs?:number;shutdownMs?:number;intervalMs?:number;retryMs?:number;maxRetryMs?:number;onReady?:()=>Promise<void>|void;onResult?:(result:{reportSequence:number;accepted:boolean})=>void;onRetry?:(delayMs:number)=>void;diagnostics?:(chunk:Uint8Array)=>void}):Promise<void>{
 if(process.platform==="win32")throw new Error("Forwarder process supervision requires a POSIX runtime");
 const startupMs=duration(options.startupMs??60_000),shutdownMs=duration(options.shutdownMs??10_000),artifact=await validateForwarderRuntimeArtifact(options.artifact);
 if(options.signal.aborted)return;
 const environment:Record<string,string|undefined>={...process.env,...options.environment};
 // These variables can add configuration paths, suppress the owned startup event,
 // enable reloading, or override shutdown/interpolation. No ambient overrides.
 for(const key of Object.keys(environment))if(/^VECTOR_(CONFIG(?:_|$)|WATCH_CONFIG(?:_|$)|LOG(?:_|$)|DISABLE_ENV_VAR_INTERPOLATION$|NO_GRACEFUL_SHUTDOWN_LIMIT$|GRACEFUL_SHUTDOWN_LIMIT_SECS$)/.test(key))delete environment[key];
 environment.VECTOR_LOG="info";
 const configDirectory=resolve(options.configDirectory),checkpoint=resolve(options.checkpoint),assets="/opt/logtura/assets",vector=options.vector??"vector";
 const initial=installedFiles(artifact,join(configDirectory,"vector.yaml"),assets);
 await verifyLoadedForwarder(artifact,{files:initial,environment,generatorVersion:GENERATOR_VERSION,vectorVersion:VECTOR_VERSION,ready:true});
 let version:string;
 try{const result=await promisify(execFile)(vector,["--version"],{env:environment,timeout:10_000,maxBuffer:64*1024});version=result.stdout.match(/^vector (\d+\.\d+\.\d+)/)?.[1]??"";}catch{throw new Error("Cannot determine forwarder Vector version");}
 if(version!==artifact.vectorVersion)throw new Error("Installed Vector version differs from the issued artifact");
 if(options.signal.aborted)return;
 return withPrivateDirectoryLock(`${checkpoint}.runtime.lock`,async()=>{
  const snapshot=mkdtempSync(join(dirname(checkpoint),".logtura-runtime-")),config=join(snapshot,"vector.yaml");
  let child:ChildProcess|undefined,closed=false,failed=false,apiStarted=false,retain=false;
  const stopped=new AbortController(),stop=()=>stopped.abort();options.signal.addEventListener("abort",stop,{once:true});if(options.signal.aborted)stop();
  let finish!:()=>void;const finished=new Promise<void>(resolve=>finish=resolve);
  try{
   writeFileSync(config,initial["vector.yaml"]!,{mode:0o400,flag:"wx"});
   if(stopped.signal.aborted)return;
   child=spawn(vector,["--config",config,"--log-format","text","--color","never","--graceful-shutdown-limit-secs",String(Math.max(1,Math.ceil(shutdownMs/1000)))],{env:environment,detached:true,stdio:["ignore","inherit","pipe"]});
   child.on("error",()=>{failed=true;stop();});child.on("close",()=>{closed=true;stop();finish();});
   const decoder=new StringDecoder("utf8");let pending="",discard=false;
   child.stderr!.on("data",(chunk:Buffer)=>{
    // Drain all diagnostics, but bound the startup parser even for malicious or
    // arbitrary output. Only this child's internal API event establishes ownership.
    try{options.diagnostics?.(chunk);}catch{failed=true;stop();}
    for(const part of decoder.write(chunk).split(/(?<=\n)/)){
     if(!discard){pending+=part;if(pending.length>64*1024){pending="";discard=true;}}
     if(part.endsWith("\n")){if(!discard && /^\d{4}-\d{2}-\d{2}T\S+\s+INFO\s+vector::internal_events::api:\s+API server running\.\s+address=0\.0\.0\.0:8686\s*$/.test(pending))apiStarted=true;pending="";discard=false;}
    }
   });
   const observe=async():Promise<LoadedForwarderObservation>=>{
    let ready=false;
    if(apiStarted && !closed && !failed)try{ready=(await fetch("http://127.0.0.1:8686/health",{signal:AbortSignal.timeout(1000),redirect:"manual"})).status===200;}catch{}
    return {files:installedFiles(artifact,config,assets),environment,generatorVersion:GENERATOR_VERSION,vectorVersion:version,ready:ready && !closed && !failed};
   };
   const deadline=Date.now()+startupMs;
   while(!stopped.signal.aborted){
    const observed=await observe();if(observed.ready){await verifyLoadedForwarder(artifact,observed);break;}
    if(Date.now()>=deadline)throw new Error("Owned Vector startup timed out");
    try{await sleep(100,undefined,{signal:stopped.signal});}catch{}
   }
   if(!stopped.signal.aborted){await options.onReady?.();if(!stopped.signal.aborted)await runForwarderReporting({...options,observe,signal:stopped.signal});}
   if(!options.signal.aborted)throw new Error("Owned Vector process stopped unexpectedly");
  }finally{
   options.signal.removeEventListener("abort",stop);
   if(child?.pid){
    const kill=(signal:NodeJS.Signals)=>{try{process.kill(-child!.pid!,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw new Error("Cannot stop owned Vector process group");}};
    try{kill("SIGTERM");await Promise.race([finished,sleep(shutdownMs,undefined,{ref:false})]);if(!closed){kill("SIGKILL");await Promise.race([finished,sleep(1000,undefined,{ref:false})]);if(!closed){retain=true;throw new Error("Owned Vector cleanup incomplete; runtime snapshot retained");}}}catch(error){retain=true;throw error;}
   }
   if(!retain)rmSync(snapshot,{recursive:true,force:true});
  }
 },"Forwarder runtime");
}
