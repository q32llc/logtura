import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,chmodSync,symlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {FileRunLedger} from '../e2e/file-ledger.ts';
import {validateRunLedger} from '../e2e/run-ledger.ts';
async function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'logtura-run-ledger-')),path=join(directory,'run.json'),runId=crypto.randomUUID(),monitors=new Map(),destinations=new Map(),sinks=new Map();
 monitors.set('mon_baseline',{id:'mon_baseline',displayName:'Baseline',enabled:true});destinations.set('dest_baseline',{id:'dest_baseline',displayName:'Baseline'});sinks.set('sink_baseline',{id:'sink_baseline',monitorId:'mon_baseline',destinationId:'dest_baseline'});
 const receipts=new Map();
 const creates={destination:0,monitor:0,sink:0},deletes=[],requests=[];let enteredResolve,releaseResolve,finishedResolve;const entered=new Promise(r=>enteredResolve=r),gate=new Promise(r=>releaseResolve=r),finished=new Promise(r=>finishedResolve=r);
 let mode='normal',account='e2e-user',extraConnection=false,failure;
 const server=createServer(async(request,response)=>{
  try{
   assert.equal(request.headers.cookie,'logtura_session=private-cookie-fixture');let text='';for await(const chunk of request)text+=chunk;const route=request.url,method=request.method;requests.push([method,route]);const body=text.startsWith('{')?JSON.parse(text):null;
   const send=(value,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
   if(route==='/api/me'){if(mode==='redirect'){response.writeHead(302,{location:'http://127.0.0.1:1/leak'});response.end('private-response');return;}send({user:{id:account}});return;}
   if(route==='/api/creation-requests'){send({protocolVersion:1});return;}
   const receiptRoute=route.match(/^\/api\/creation-requests\/([^?]+)\?kind=(destination|monitor|sink)$/);
   if(method==='DELETE' && receiptRoute){const [,requestId,kind]=receiptRoute;let receipt=receipts.get(requestId);if(!receipt){receipt={requestId,kind,resourceId:`cancelled_${kind}`,status:'cancelled'};receipts.set(requestId,receipt);}if(receipt.status==='pending')receipt.status='cancelled';send({receipt});return;}
   if(route==='/api/connections'){send({connections:extraConnection?[{id:'con_production'}]:[]});return;}
   if(route==='/api/deployments'){send({deployments:[]});return;}
   if(method==='GET' && route==='/api/monitors'){send({monitors:[...monitors.values()],sinks:[...sinks.values()]});return;}
   if(method==='GET' && route==='/api/destinations'){send({destinations:[...destinations.values()].filter(d=>mode!=='stale-inventory'||d.id==='dest_baseline')});return;}
   if(method==='POST' && ['/api/monitors','/api/destinations'].includes(route)){
    const key=route.endsWith('monitors')?'monitor':'destination',displayName=key==='monitor'?body?.displayName:text.match(/name="display_name"\r\n\r\n([^\r\n]*)/)?.[1];if(!displayName){send({error:'invalid'},400);return;}
    const requestId=request.headers['x-logtura-request-id'];if(requestId && receipts.has(requestId)){send({error:'cancelled'},409);return;}
    if(mode==='inflight' && key==='destination'){receipts.set(requestId,{requestId,kind:key,resourceId:'destination_inflight',status:'pending'});enteredResolve();await gate;if(receipts.get(requestId).status==='cancelled'){send({error:'cancelled'},409);finishedResolve();return;}}
    creates[key]++;const id=`${key}_${creates[key]}`,item={id,displayName,...(key==='monitor'?{enabled:true}:{})};(key==='monitor'?monitors:destinations).set(id,item);if(requestId)receipts.set(requestId,{requestId,kind:key,resourceId:id,status:'completed'});
    if(mode===`loss-${key}`){mode='normal';request.socket.destroy();return;}send({[key]:item});return;
   }
   const parent=route.match(/^\/api\/monitors\/([^/]+)\/sinks$/);
   if(parent && method==='POST'){assert.ok(monitors.has(parent[1]));assert.ok(destinations.has(body.destinationId));const requestId=request.headers['x-logtura-request-id'];if(receipts.has(requestId)){send({error:'cancelled'},409);return;}creates.sink++;const sink={id:`sink_${creates.sink}`,monitorId:parent[1],destinationId:body.destinationId};sinks.set(sink.id,sink);receipts.set(requestId,{requestId,kind:'sink',resourceId:sink.id,status:'completed'});if(mode==='loss-sink'){mode='normal';request.socket.destroy();return;}send({sink});return;}
   const match=route.match(/^\/api\/(monitors|destinations|sinks)\/([^/]+)$/);if(match){
    const table=match[1]==='monitors'?monitors:match[1]==='destinations'?destinations:sinks,item=table.get(match[2]);
    if(method==='PUT'){if(!item){send({error:'missing'},404);return;}Object.assign(item,body);send({[match[1]==='monitors'?'monitor':'sink']:item});return;}
    if(method==='DELETE'){if(mode==='delete-failed' && match[1]==='sinks'){send({error:'private-body'},503);return;}deletes.push(match[2]);table.delete(match[2]);for(const r of receipts.values())if(r.resourceId===match[2] && r.status==='completed')r.status='deleted';if(match[1]!=='sinks')for(const [id,sink] of sinks)if(match[1]==='monitors'?sink.monitorId===match[2]:sink.destinationId===match[2])sinks.delete(id);send({ok:true});return;}
   }
   throw new Error(`Unexpected fixture request ${method} ${route}`);
  }catch(error){failure=error;response.writeHead(500);response.end('private-fixture-rejected');}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 function start(stage='none',mode='run',userId='e2e-user'){
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/e2e-ledger-child.mjs',import.meta.url)),path,origin,runId,stage,mode,userId],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  const result=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>{clearTimeout(timer);if(failure)reject(failure);else resolve({code,signal,stdout,stderr});});});return {child,result,stdout:()=>stdout};
 }
 return {entered,finished,release:()=>releaseResolve(),directory,path,runId,origin,monitors,destinations,sinks,creates,deletes,requests,start,run:async(...args)=>start(...args).result,state:()=>JSON.parse(readFileSync(path,'utf8')),set mode(value){mode=value;},set account(value){account=value;},set extraConnection(value){extraConnection=value;},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}};
}
function baseline(f){assert.deepEqual([...f.monitors.keys()],['mon_baseline']);assert.deepEqual([...f.destinations.keys()],['dest_baseline']);assert.deepEqual([...f.sinks.keys()],['sink_baseline']);assert.ok(!f.deletes.some(id=>id.endsWith('baseline')));}
test('actual HTTP run records private durable resources, idempotently removes them and preserves the pre-existing graph',async()=>{
 const f=await fixture();try{assert.equal((await f.run()).code,0);baseline(f);assert.equal(f.state().status,'cleaned');assert.deepEqual(f.creates,{destination:1,monitor:1,sink:1});assert.equal(statSync(f.path).mode&0o777,0o600);assert.ok(!readFileSync(f.path,'utf8').includes('private-cookie'));assert.equal((await f.run('none','cleanup')).code,0);baseline(f);assert.equal((await f.run()).code,1);}finally{await f.close();}
});
for(const stage of ['destination:creating','destination:response','destination:created','monitor:creating','monitor:response','monitor:created','sink:creating','sink:response','sink:created','sink:deleting','monitor:deleting','destination:deleting','cleaned'])test(`recovers SIGKILL after ${stage} through the same durable ledger`,async()=>{
 const f=await fixture();try{assert.deepEqual((await f.run(stage)).signal,'SIGKILL');const before={...f.creates},result=await f.run('none','cleanup');assert.equal(result.code,0,result.stderr);assert.deepEqual(f.creates,before);assert.equal(f.state().status,'cleaned');baseline(f);}finally{await f.close();}
});
for(const key of ['destination','monitor','sink'])test(`reconciles a lost ${key} POST response without repeating creation`,async()=>{
 const f=await fixture();try{f.mode=`loss-${key}`;const result=await f.run();assert.equal(result.code,1);assert.equal(f.creates[key],1);assert.equal(f.state().status,'cleaned');baseline(f);}finally{await f.close();}
});
test('cancels an in-flight POST before accepting absence; its late write cannot create an orphan',async()=>{
 const f=await fixture();let running;try{f.mode='inflight';running=f.start();await Promise.race([f.entered,running.result.then(()=>{throw new Error("Create did not reach pending boundary");})]);running.child.kill('SIGKILL');assert.equal((await running.result).signal,'SIGKILL');assert.equal((await f.run('none','cleanup')).code,0);assert.equal(f.state().status,'cleaned');f.release();await f.finished;baseline(f);assert.deepEqual(f.creates,{destination:0,monitor:0,sink:0});}finally{running?.child.kill('SIGKILL');f.release();await f.close();}
});
test('a live executor cannot be displaced; only its confirmed dead lock owner is recovered',async()=>{
 const f=await fixture();let held;try{held=f.start('destination:created','hold');const deadline=Date.now()+5000;while(!held.stdout().includes('HELD') && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(held.stdout().includes('HELD'));const result=await f.run('none','cleanup');assert.equal(result.code,1);assert.match(result.stderr,/still running/);held.child.kill('SIGKILL');assert.equal((await held.result).signal,'SIGKILL');assert.equal((await f.run('none','cleanup')).code,0);baseline(f);}finally{held?.child.kill('SIGKILL');await f.close();}
});
test('uses authoritative receipts for lost responses and refuses renamed resource ownership',async()=>{
 const f=await fixture();try{await f.run('destination:response');f.account='foreign';assert.equal((await f.run('none','cleanup')).code,1);assert.equal(f.deletes.length,0);f.account='e2e-user';const original=f.destinations.get('destination_1');f.destinations.set('ambiguous',{...original,id:'ambiguous'});original.displayName='Changed externally';assert.equal((await f.run('none','cleanup')).code,1);assert.equal(f.state().status,'active');assert.equal(f.deletes.length,0);original.displayName=`e2e-${f.runId}-webhook`;assert.equal((await f.run('none','cleanup')).code,0);assert.ok(f.destinations.has('ambiguous'),'an unrelated name match must not be deleted');}finally{await f.close();}
});
test('an empty or stale inventory cannot claim cleanup while the durable receipt remains completed',async()=>{
 const f=await fixture();try{await f.run('destination:created');f.mode='stale-inventory';assert.equal((await f.run('none','cleanup')).code,1);assert.equal(f.state().status,'active');assert.equal(f.state().resources[0].phase,'created');assert.ok(f.destinations.has('destination_1'));f.mode='normal';assert.equal((await f.run('none','cleanup')).code,0);baseline(f);}finally{await f.close();}
});
test('blocks parent cascades when failed sink deletion or foreign routing still references owned resources',async()=>{
 const f=await fixture();try{await f.run('sink:created');f.mode='delete-failed';assert.equal((await f.run('none','cleanup')).code,1);assert.equal(f.monitors.size,2);assert.equal(f.destinations.size,2);f.mode='normal';assert.equal((await f.run('none','cleanup')).code,0);baseline(f);
 }finally{await f.close();}
 const g=await fixture();try{await g.run('monitor:created');g.sinks.set('foreign',{id:'foreign',monitorId:'monitor_1',destinationId:'destination_1'});assert.equal((await g.run('none','cleanup')).code,1);assert.ok(g.sinks.has('foreign'));assert.equal(g.monitors.size,2);assert.equal(g.destinations.size,2);}finally{await g.close();}
});
test('rejects target/account ledger mismatches before credential requests and refuses production topology',async()=>{
 const f=await fixture();try{await f.run('destination:created');const before=f.requests.length;assert.equal((await f.run('none','cleanup','foreign')).code,1);assert.equal(f.requests.length,before);const saved=f.state();saved.baseUrl='https://foreign.invalid';writeFileSync(f.path,JSON.stringify(saved));assert.equal((await f.run('none','cleanup')).code,1);assert.equal(f.requests.length,before);}finally{await f.close();}
 const g=await fixture();try{g.extraConnection=true;assert.equal((await g.run()).code,1);assert.equal(existsSync(g.path),false);assert.deepEqual(g.creates,{destination:0,monitor:0,sink:0});g.extraConnection=false;g.mode='redirect';assert.equal((await g.run()).code,1);assert.equal(g.requests.at(-1)[1],'/api/me');}finally{await g.close();}
});
test('validates ledger schema, permissions, symlinks, size, CAS ownership and exclusive mutation',async()=>{
 const f=await fixture();try{await f.run();const saved=f.state();for(const mutate of [s=>{s.extra='private';},s=>{s.runId=12345678;},s=>{s.resources[0].id=123;},s=>{s.resources[0].requestId=null;},s=>{s.resources[0].requestId=s.resources[1].requestId;},s=>{s.resources[0].id='dest_baseline';},s=>{s.resources[0].id='../escape';},s=>{s.resources[0].phase='creating';},s=>{s.resources.reverse();},s=>{s.baseline.monitors.push('mon_baseline');}]){const corrupt=structuredClone(saved);mutate(corrupt);assert.throws(()=>validateRunLedger(corrupt),/Invalid/);}
 const store=new FileRunLedger(f.path);await assert.rejects(store.compareAndSwap(saved,saved),/exclusive/);await store.runExclusive(async()=>{assert.equal(await store.compareAndSwap({...saved,status:'active'},saved),false);});chmodSync(f.path,0o644);await assert.rejects(store.read(),/Invalid private/);chmodSync(f.path,0o600);writeFileSync(f.path,'x'.repeat(524289));await assert.rejects(store.read(),/Invalid private/);rmSync(f.path);symlinkSync(join(f.directory,'missing'),f.path);await assert.rejects(store.read(),/private regular/);
 chmodSync(f.directory,0o755);assert.throws(()=>new FileRunLedger(f.path),/private directory/);
 }finally{await f.close();}
});
