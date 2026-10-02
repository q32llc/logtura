import { constants,openSync,closeSync,fsyncSync,writeFileSync,readFileSync,renameSync,rmSync,lstatSync,readdirSync } from "node:fs";
import { basename,dirname,resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { reportLoadedForwarder,ServiceError,type ForwarderReportStore,type ForwarderReportCheckpoint,type LoadedForwarderObservation,type DeploymentAppliedReport } from "@logtura/core";
import { withPrivateDirectoryLock } from "./private-lock";

function regular(path:string):void {
 const stat=lstatSync(path);if(!stat.isFile())throw new Error("Forwarder report state must use regular files");
}
function syncDirectory(path:string):void {
 if(process.platform==="win32")return;
 const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}
}
/** Hold the lock across load, transport and completion, not just individual writes.
 * Atomic replacement retains either durable intent or completion after interruption. */
export async function withForwarderReportFile<T>(path:string,run:(store:ForwarderReportStore)=>Promise<T>):Promise<T> {
 const target=resolve(path),directory=dirname(target);
 if(!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())throw new Error("Forwarder report directory must be a regular directory");
 return withPrivateDirectoryLock(`${target}.lock`,async()=>{
  // Only the crashed writer's narrowly named stages are ours to remove.
  const prefix=`${basename(target)}.`;
  for(const entry of readdirSync(directory))if(entry.startsWith(prefix) && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(entry.slice(prefix.length))){const stage=resolve(directory,entry);regular(stage);rmSync(stage);}
  const store:ForwarderReportStore={
   async load(){
    let fd:number;try{fd=openSync(target,constants.O_RDONLY | constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
    try{regular(target);try{return JSON.parse(readFileSync(fd,"utf8"));}catch{throw new Error("Invalid private forwarder report file");}}finally{closeSync(fd);}
   },
   async save(value:ForwarderReportCheckpoint){
    try{regular(target);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const stage=`${target}.${randomUUID()}.tmp`,fd=openSync(stage,"wx",0o600);
    try{try{writeFileSync(fd,JSON.stringify(value)+"\n");fsyncSync(fd);}finally{closeSync(fd);}renameSync(stage,target);syncDirectory(directory);}finally{rmSync(stage,{force:true});}
   },
  };
  return run(store);
 },"Forwarder report");
}
export async function reportLoadedForwarderFile(options:{checkpoint:string;artifact:unknown;observed:LoadedForwarderObservation;report:(value:DeploymentAppliedReport)=>Promise<boolean>}):Promise<{reportSequence:number;accepted:boolean}>{
 return withForwarderReportFile(options.checkpoint,store=>reportLoadedForwarder({...options,store}));
}
function interval(value:number):number {
 if(!Number.isSafeInteger(value) || value<1 || value>3_600_000)throw new Error("Invalid forwarder reporting interval");return value;
}
function transient(error:unknown):boolean {
 return error instanceof ServiceError?error.status===429 || error.status>=500:error instanceof TypeError || error instanceof DOMException && error.name==="TimeoutError";
}
/** Observe the adapter's actual runtime again for each attempt. Local integrity,
 * ownership and persistence failures stop; transient transport failures back off.
 * An in-flight transport finishes (SDK timeout: 20 seconds) before shutdown returns. */
export async function runForwarderReporting(options:{checkpoint:string;artifact:unknown;observe:()=>Promise<LoadedForwarderObservation>;report:(value:DeploymentAppliedReport)=>Promise<boolean>;signal:AbortSignal;intervalMs?:number;retryMs?:number;maxRetryMs?:number;onResult?:(result:{reportSequence:number;accepted:boolean})=>void;onRetry?:(delayMs:number)=>void}):Promise<void>{
 const intervalMs=interval(options.intervalMs??60_000),retryMs=interval(options.retryMs??1_000),maxRetryMs=interval(options.maxRetryMs??30_000);
 if(maxRetryMs<retryMs)throw new Error("Maximum forwarder retry interval is too small");
 let backoff=retryMs;
 while(!options.signal.aborted){
  const observed=await options.observe();if(options.signal.aborted)return;
  let delay=intervalMs,result:{reportSequence:number;accepted:boolean}|undefined,transportFailure:unknown;
  try{result=await reportLoadedForwarderFile({...options,observed,report:async value=>{try{return await options.report(value);}catch(error){transportFailure=error;throw error;}}});backoff=retryMs;}
  catch(error){if(options.signal.aborted)return;if(error!==transportFailure || !transient(error))throw error;delay=Math.max(1,Math.floor(backoff*(0.8+Math.random()*0.2)));backoff=Math.min(backoff*2,maxRetryMs);options.onRetry?.(delay);}
  if(result)options.onResult?.(result);
  if(options.signal.aborted)return;
  try{await sleep(delay,undefined,{signal:options.signal});}catch(error){if(!options.signal.aborted)throw error;}
 }
}
