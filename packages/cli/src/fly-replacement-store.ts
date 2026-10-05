import {canonicalConfigJson,isInstanceId,validateFlyReplacementState,type FlyReplacementState,type FlyReplacementStore,type FlyReplacementTransaction} from "@logtura/core";
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,linkSync,renameSync,rmSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {withPrivateDirectoryLock} from "./private-lock";
import {pendingFlyReplacementPath,assertTransactionClear} from "./file-transaction";

interface Envelope {schemaVersion:1;config:string;state:FlyReplacementState;}
const limit=16_777_216;
const equal=(a:unknown,b:unknown)=>canonicalConfigJson(a)===canonicalConfigJson(b);
function flush(path:string):void{const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function flushDirectory(path:string):void{if(process.platform!=="win32")flush(dirname(path));}
const transitions:Record<FlyReplacementState["phase"],FlyReplacementState["phase"][]>={prepared:["creating","created"],creating:["created"],created:["switching","rolling_back"],switching:["installed","rolling_back"],installed:["rolling_back"],rolling_back:["rolling_back","rolled_back"],rolled_back:[]};
function validTransition(before:FlyReplacementState,after:FlyReplacementState):boolean{
 return equal(before.plan,after.plan) && transitions[before.phase].includes(after.phase)
  && (before.machineId===null?after.phase==="creating"?after.machineId===null:after.machineId!==null:after.machineId===before.machineId);
}
/** Reads never follow symlinks or block on devices/pipes. This file contains
 * resolved provider payloads and must not be printed or uploaded as evidence. */
function readState(config:string,path:string):FlyReplacementState|null{
 assertTransactionClear(config);
 try{if(!lstatSync(path).isFile())throw new Error();}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("Replacement state must be a private regular file");}
 let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{throw new Error("Replacement state must be a private regular file");}
 let value:Envelope;
 try{
  const stat=fstatSync(fd);if(!stat.isFile() || stat.size>limit || (process.platform!=="win32" && (stat.mode&0o077)!==0))throw new Error();
  value=JSON.parse(readFileSync(fd,"utf8")) as Envelope;
 }catch{throw new Error("Invalid private replacement state; retain it for recovery");}finally{closeSync(fd);}
 try{
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==3 || Object.keys(value).some(k=>!["schemaVersion","config","state"].includes(k)) || value.schemaVersion!==1 || value.config!==resolve(config))throw new Error();
  return validateFlyReplacementState(value.state);
 }catch{throw new Error("Invalid private replacement state; retain it for recovery");}
}
export function readPrivateFlyReplacement(config:string):FlyReplacementState|null{return readState(config,pendingFlyReplacementPath(config));}
export function readPrivateFlyReplacementArchive(config:string,id:string):FlyReplacementState|null{
 if(!isInstanceId(id))throw new Error("Invalid replacement archive identity");
 return readState(config,resolve(dirname(resolve(config)),`.logtura-replaced-${id}.json`));
}
function write(config:string,state:FlyReplacementState,initial:boolean):void{
 const path=pendingFlyReplacementPath(config),stage=`${path}.${randomUUID()}.tmp`;
 const envelope:Envelope={schemaVersion:1,config:resolve(config),state:validateFlyReplacementState(state)},serialized=JSON.stringify(envelope)+"\n";
 if(Buffer.byteLength(serialized)>limit)throw new Error("Private replacement state exceeds its recovery reader limit");
 try{writeFileSync(stage,serialized,{flag:"wx",mode:0o600});flush(stage);if(initial)linkSync(stage,path);else renameSync(stage,path);flushDirectory(path);}
 finally{rmSync(stage,{force:true});}
}
/** The lock covers read/CAS plus every provider operation invoked by the core
 * engine. Successful CAS means the replacement journal and directory are fsynced.
 * A failed acknowledgement leaves whatever intent reached disk for read-back. */
export class PrivateFlyReplacementStore implements FlyReplacementStore {
 readonly config:string;
 constructor(config:string){this.config=resolve(config);}
 private exclusive<T>(run:()=>Promise<T>):Promise<T>{return withPrivateDirectoryLock(resolve(dirname(this.config),".logtura-replacement.lock"),async()=>{assertTransactionClear(this.config);return run();},"Replacement");}
 async prepare(state:FlyReplacementState):Promise<void>{
  const validated=validateFlyReplacementState(state);
  if(validated.phase!=="prepared")throw new Error("Prepare a replacement before any provider dispatch");
  return this.exclusive(async()=>{if(readPrivateFlyReplacement(this.config))throw new Error("Pending Fly replacement; resume its retained intent");write(this.config,validated,true);});
 }
 async runExclusive<T>(operation:(transaction:FlyReplacementTransaction)=>Promise<T>):Promise<T>{
  return this.exclusive(async()=>operation({
   read:async()=>{const state=readPrivateFlyReplacement(this.config);if(!state)throw new Error("Replacement state is missing; retain provider resources for recovery");return state;},
   compareAndSwap:async(expected,next)=>{
    const current=readPrivateFlyReplacement(this.config),validated=validateFlyReplacementState(next);
    if(!current || !equal(current,expected) || !validTransition(current,validated))return false;
    write(this.config,validated,false);return true;
   },
  }));
 }
 /** Caller verifies accepted current runtime/target (or acknowledged rollback)
  * under this lock. A running machine or an old service receipt is insufficient. */
 async archive(expected:FlyReplacementState,assertCurrent:()=>Promise<void>):Promise<string>{
  return this.exclusive(async()=>{
   const state=readPrivateFlyReplacement(this.config);
   if(!state || !equal(state,expected) || !["installed","rolled_back"].includes(state.phase))throw new Error("Replacement is not ready to archive; retain it for recovery");
   await assertCurrent();
   const path=pendingFlyReplacementPath(this.config),archive=resolve(dirname(path),`.logtura-replaced-${state.plan.id}.json`);
   try{linkSync(path,archive);}catch(error){
    if((error as NodeJS.ErrnoException).code!=="EEXIST" || !lstatSync(archive).isFile() || (process.platform!=="win32" && (lstatSync(archive).mode&0o077)!==0) || readFileSync(archive,"utf8")!==readFileSync(path,"utf8"))throw new Error("Replacement archive conflicts; retain it for recovery");
   }
   flushDirectory(archive);await assertCurrent();
   if(!equal(readPrivateFlyReplacement(this.config),state))throw new Error("Replacement changed before archive acknowledgement; retain it for recovery");
   rmSync(path);flushDirectory(path);return archive;
  });
 }
}
