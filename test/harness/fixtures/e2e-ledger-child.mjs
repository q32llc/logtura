import {FileRunLedger} from '../../e2e/file-ledger.ts';
import {runRoutingLifecycle,cleanupRoutingLifecycle} from '../../e2e/lifecycle.ts';
const [path,baseUrl,runId,stage,mode,userId='e2e-user']=process.argv.slice(2),ledger=new FileRunLedger(path);
async function boundary(name){if(stage==='none'||name==='none'||stage!==name)return;if(mode==='hold'){console.log('HELD');await new Promise(()=>setInterval(()=>{},1000));}else process.kill(process.pid,'SIGKILL');}
try{await ledger.runExclusive(async()=>{
 const target={baseUrl,runId,expectedUserId:userId,sessionCookie:'logtura_session=private-cookie-fixture',ledger,fetch:request=>fetch(request),afterCommit:async state=>{await boundary(state.status==='cleaned'?'cleaned':state.resources.find(r=>`${r.key}:${r.phase}`===stage)?stage:'none');},afterResponse:async key=>boundary(`${key}:response`)};
 if(mode==='cleanup')await cleanupRoutingLifecycle(target);else await runRoutingLifecycle(target);
});console.log('DONE');}catch(error){console.error(error.message);process.exitCode=1;}
