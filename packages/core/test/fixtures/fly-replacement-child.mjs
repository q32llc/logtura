import {readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync,mkdirSync,rmSync} from "node:fs";
import {dirname} from "node:path";
import {FlyMachinesClient,executeFlyReplacement,executeFlyReplacementCleanup,canonicalConfigJson} from "../../dist/index.js";
const [path,origin,killPhase,rollback]=process.argv.slice(2);
const flush=path=>{const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}};
const store={async runExclusive(operation){
 mkdirSync(path+".lock",{mode:0o700});
 try{return await operation({read:async()=>JSON.parse(readFileSync(path,"utf8")),compareAndSwap:async(expected,next)=>{
  if(canonicalConfigJson(JSON.parse(readFileSync(path,"utf8")))!==canonicalConfigJson(expected))return false;
  const stage=path+".stage";writeFileSync(stage,JSON.stringify(next),{mode:0o600,flag:"wx"});flush(stage);renameSync(stage,path);flush(dirname(path));
  if(next.phase===killPhase)process.kill(process.pid,"SIGKILL");return true;
 }});}finally{rmSync(path+".lock",{recursive:true,force:true});}
}};
const client=new FlyMachinesClient({token:"private-fixture",fetch:(url,init)=>{const upstream=new URL(url);if(upstream.origin!=="https://api.machines.dev")throw new Error("Unexpected provider origin");return fetch(new URL(upstream.pathname,origin),init);}});
try{const state=await (rollback==="cleanup"?executeFlyReplacementCleanup(store,client,{assertCurrent:async()=>{}}):executeFlyReplacement(store,client,{rollback:rollback==="rollback",assertCurrent:async()=>{}}));console.log(state.phase);}catch(error){console.error(error.message);process.exitCode=1;}
