import { mkdirSync,lstatSync,readdirSync,writeFileSync,rmSync,rmdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
/** Unique owner markers prevent stale cleanup from deleting a replacement owner.
 * Only an empty directory can be removed; failed contenders remove their own marker. */
export async function withPrivateDirectoryLock<T>(path:string,run:()=>Promise<T>,label="Push"):Promise<T>{
 const directory=resolve(path),owner=`${process.pid}-${randomUUID()}.owner`,marker=resolve(directory,owner);
 try{mkdirSync(directory,{mode:0o700});}catch(error){
  if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
  if(!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())throw new Error(`${label} lock is not a regular directory`);
  const entries=readdirSync(directory);
  for(const entry of entries){const match=entry.match(/^([1-9][0-9]*)-[a-f0-9-]{36}\.owner$/);if(!match || !lstatSync(resolve(directory,entry)).isFile())throw new Error(`Invalid ${label.toLowerCase()} lock; retain it for recovery`);
   try{process.kill(Number(match[1]),0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")continue;throw new Error(`Cannot verify ${label.toLowerCase()} lock owner`);}throw new Error(`Another ${label.toLowerCase()} is still running`);
  }
  for(const entry of entries)rmSync(resolve(directory,entry),{force:true});
  try{rmdirSync(directory);mkdirSync(directory,{mode:0o700});}catch{throw new Error(`${label} lock changed; retry`);}
 }
 try{
  writeFileSync(marker,"",{flag:"wx",mode:0o600});
  if(readdirSync(directory).length!==1 || readdirSync(directory)[0]!==owner)throw new Error(`${label} lock changed; retry`);
  return await run();
 }finally{
  rmSync(marker,{force:true});
  try{rmdirSync(directory);}catch(error){if(!["ENOENT","ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code!))throw error;}
 }
}
