import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Entry {target:string;stage:string;backup:string;existed:boolean;}
interface Journal {schemaVersion:1;pid:number;committed:boolean;files:Entry[];}
export function transactionPath(config:string):string {return resolve(dirname(resolve(config)),".logtura-transaction.json");}
export function deploymentLinkPath(config:string):string {return `${resolve(config)}.logtura-link.json`;}
export function assertTransactionClear(config:string):void {
  if(existsSync(transactionPath(config)))throw new Error("Configuration transaction pending; run logt config recover before reading or writing");
}
function assertConfigDestination(config:string):void {
  const journal=transactionPath(config);
  if([resolve(dirname(config),".env"),journal,`${journal}.commit`].includes(resolve(config)))throw new Error("Configuration destination is reserved for private transaction state");
}
function syncFile(path:string):void {const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncDirectory(path:string):void {
  // Windows does not support opening a directory for fsync.
  if(process.platform!=="win32")syncFile(dirname(path));
}
function regular(path:string):void {if(existsSync(path) && !lstatSync(path).isFile())throw new Error("Configuration recovery requires regular files");}
function readJournal(path:string,config:string):Journal {
  assertConfigDestination(config);regular(path);
  let value:any;try{value=JSON.parse(readFileSync(path,"utf8"));}catch{throw new Error("Invalid configuration transaction journal; retain it for recovery");}
  const targets=[resolve(dirname(config),".env"),resolve(config),deploymentLinkPath(config)];
  if(value?.schemaVersion!==1 || !Number.isSafeInteger(value.pid) || value.pid<=0 || typeof value.committed!=="boolean" || !Array.isArray(value.files) || (value.files.length!==2 && value.files.length!==3) || value.files.some((file:any,i:number)=>!file || file.target!==targets[i] || typeof file.existed!=="boolean" || typeof file.stage!=="string" || !/^\.[a-f0-9-]{36}\.tmp$/.test(file.stage.slice(file.target.length)) || file.stage!==file.target+file.stage.slice(file.target.length) || file.backup!==file.stage.slice(0,-4)+".bak"))throw new Error("Invalid configuration transaction journal; retain it for recovery");
  if(value.committed && value.files.some((file:Entry)=>!existsSync(file.target)))throw new Error("Committed configuration is missing a destination; retain files for recovery");
  for(const file of value.files)for(const name of [file.target,file.stage,file.backup])regular(name);
  return value as Journal;
}
function cleanup(path:string,journal:Journal):void {
  for(const file of journal.files){rmSync(file.stage,{force:true});rmSync(file.backup,{force:true});}
  rmSync(`${path}.commit`,{force:true});rmSync(path,{force:true});syncDirectory(path);
}
function rollback(path:string,journal:Journal):void {
  let failed=false;
  for(const file of [...journal.files].reverse()) {
    try{if(existsSync(file.backup))renameSync(file.backup,file.target);
    else if(!file.existed && !existsSync(file.stage))rmSync(file.target,{force:true});}catch{failed=true;}
  }
  if(failed)throw new Error("Configuration rollback incomplete; retain the journal");
  syncDirectory(path);cleanup(path,journal);
}
/** Recover an interrupted pair, but never race a live writer. Uncommitted work
 * restores the old pair; a durable commit keeps the new pair and removes backups. */
export function recoverFileTransaction(config:string):boolean {
  const path=transactionPath(config);if(!existsSync(path))return false;
  const journal=readJournal(path,resolve(config));
  try{process.kill(journal.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw new Error("Cannot verify transaction owner; retain files for recovery");
    if(journal.committed)cleanup(path,journal);else rollback(path,journal);return true;
  }
  throw new Error("Configuration transaction owner is still running; recovery refused");
}
/** Acquire the directory lock before preparing stages or reading shared values.
 * The journal precedes original moves; the commit marker precedes discarding them. */
export function commitFileTransaction(config:string,files:Array<{target:string;stage:string;backup:string}>,prepare?:()=>void):void {
  const path=transactionPath(config);
  assertConfigDestination(config);
  // Capture originals only after acquiring the lock. A writer that completed
  // between the caller's preflight and this acquisition must not lose its files.
  const descriptor=openSync(path,"wx",0o600);
  let journal:Journal;
  try{journal={schemaVersion:1,pid:process.pid,committed:false,files:files.map(file=>({...file,existed:existsSync(file.target)}))};
    writeFileSync(descriptor,JSON.stringify(journal)+"\n");}finally{closeSync(descriptor);}
  // From this point onward every failure leaves either the old pair or a journal.
  try {
    syncFile(path);syncDirectory(path);
    if(prepare)prepare();
    for(const file of files)syncFile(file.stage);
    for(const file of journal.files){if(file.existed){renameSync(file.target,file.backup);syncDirectory(path);}renameSync(file.stage,file.target);syncDirectory(path);}
    syncDirectory(path);
    writeFileSync(`${path}.commit`,JSON.stringify({...journal,committed:true})+"\n",{flag:"wx",mode:0o600});
    syncFile(`${path}.commit`);renameSync(`${path}.commit`,path);syncDirectory(path);
  }catch(error){
    // A marker rename may already have succeeded. Read it before deciding whether
    // restoring originals is valid; failed inspection must preserve recovery data.
    try{const current=readJournal(path,resolve(config));if(current.committed)throw new Error("Configuration committed; cleanup requires recovery");rollback(path,current);}catch{throw new Error(`Configuration write interrupted; original files retained for recovery: ${path}`);}
    throw error;
  }
  try{cleanup(path,journal);}catch{throw new Error(`Configuration committed; cleanup requires recovery: ${path}`);}
}
