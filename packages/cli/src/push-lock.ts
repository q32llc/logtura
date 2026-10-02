import { mkdirSync,lstatSync,readdirSync,writeFileSync,rmSync,rmdirSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { randomUUID } from "node:crypto";
export function pushLockPath(config:string):string{return resolve(dirname(resolve(config)),".logtura-push.lock");}
/** Unique owner markers prevent stale cleanup from deleting a replacement owner.
 * Only an empty directory can be removed; failed contenders remove their own marker. */
export async function withPushLock<T>(config:string,run:()=>Promise<T>):Promise<T>{
 const directory=pushLockPath(config),owner=`${process.pid}-${randomUUID()}.owner`,marker=resolve(directory,owner);
 try{mkdirSync(directory,{mode:0o700});}catch(error){
  if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
  if(!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())throw new Error("Push lock is not a regular directory");
  const entries=readdirSync(directory);
  for(const entry of entries){const match=entry.match(/^([1-9][0-9]*)-[a-f0-9-]{36}\.owner$/);if(!match || !lstatSync(resolve(directory,entry)).isFile())throw new Error("Invalid push lock; retain it for recovery");
   try{process.kill(Number(match[1]),0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")continue;throw new Error("Cannot verify push lock owner");}throw new Error("Another push is still running");
  }
  for(const entry of entries)rmSync(resolve(directory,entry),{force:true});
  try{rmdirSync(directory);mkdirSync(directory,{mode:0o700});}catch{throw new Error("Push lock changed; retry");}
 }
 try{
  writeFileSync(marker,"",{flag:"wx",mode:0o600});
  if(readdirSync(directory).length!==1 || readdirSync(directory)[0]!==owner)throw new Error("Push lock changed; retry");
  return await run();
 }finally{
  rmSync(marker,{force:true});
  try{rmdirSync(directory);}catch(error){if(!["ENOENT","ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code!))throw error;}
 }
}
