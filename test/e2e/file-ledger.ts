import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,fsyncSync,linkSync,renameSync,rmSync,mkdirSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {withPrivateDirectoryLock} from "../../packages/cli/src/private-lock";
import {validateRunLedger,type RunLedger,type RunLedgerStore} from "./run-ledger";
function flush(path:string){const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
/** Durable private file store, never credentials or rendered configuration.
 * Hold runExclusive across the entire remote run/cleanup. A live process cannot
 * be displaced; stale locks require OS proof that their owner has exited. */
export class FileRunLedger implements RunLedgerStore {
 readonly path:string;private held=false;
 constructor(path:string){
  if(process.platform==="win32")throw new Error("Durable E2E ledgers require directory fsync");this.path=resolve(path);const parent=dirname(this.path);mkdirSync(parent,{recursive:true,mode:0o700});const stat=lstatSync(parent);if(!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o077)!==0 || stat.uid!==process.getuid!())throw new Error("E2E ledger requires an owned private directory");
 }
 async runExclusive<T>(operation:()=>Promise<T>):Promise<T>{return withPrivateDirectoryLock(this.path+".lock",async()=>{this.held=true;try{return await operation();}finally{this.held=false;}},"E2E run");}
 async read():Promise<RunLedger|null>{
  let fd:number;try{fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("E2E ledger must be a private regular file");}
  try{const stat=fstatSync(fd);if(!stat.isFile() || stat.size>524288 || (stat.mode&0o077)!==0 || stat.uid!==process.getuid!())throw new Error();return validateRunLedger(JSON.parse(readFileSync(fd,"utf8")) as RunLedger);}catch{throw new Error("Invalid private E2E ledger; retain it for recovery");}finally{closeSync(fd);}
 }
 async compareAndSwap(expected:RunLedger|null,next:RunLedger):Promise<boolean>{
  if(!this.held)throw new Error("E2E ledger mutation requires its exclusive run lock");const current=await this.read();if(JSON.stringify(current)!==JSON.stringify(expected))return false;const checked=validateRunLedger(next),serialized=JSON.stringify(checked)+"\n";if(Buffer.byteLength(serialized)>524288)throw new Error("E2E ledger exceeds recovery limit");
  const stage=`${this.path}.${randomUUID()}.stage`;try{writeFileSync(stage,serialized,{flag:"wx",mode:0o600});flush(stage);if(expected===null)linkSync(stage,this.path);else renameSync(stage,this.path);flush(dirname(this.path));}finally{rmSync(stage,{force:true});}return true;
 }
}
