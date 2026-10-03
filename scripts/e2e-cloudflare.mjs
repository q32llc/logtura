import {validateCloudflareRehearsal,assertCloudflareRehearsalOwnership} from "./cloudflare-rehearsal-state.mjs";
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync,existsSync,lstatSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {readD1Migrations} from '@cloudflare/vitest-pool-workers';
import {signCookie} from '../src/crypto.ts';
import {withPrivateDirectoryLock} from '../packages/cli/src/private-lock.ts';
import {FileRunLedger} from '../test/e2e/file-ledger.ts';
import {runRoutingLifecycle} from '../test/e2e/lifecycle.ts';

if(process.env.LOGT_E2E_ALLOW_CLOUDFLARE!=='1')throw new Error('Explicit Cloudflare rehearsal requires LOGT_E2E_ALLOW_CLOUDFLARE=1');
const root=process.cwd(),cleanupOnly=process.argv.includes('--cleanup');
if(process.argv.slice(2).some(arg=>arg!=='--cleanup'))throw new Error('Usage: e2e-cloudflare.mjs [--cleanup]');
const values={BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID:process.env.BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID,BOOTSTRAP_CLOUDFLARE_API_TOKEN:process.env.BOOTSTRAP_CLOUDFLARE_API_TOKEN};for(const line of (existsSync(join(root,'.env'))?readFileSync(join(root,'.env'),'utf8'):'').split('\n')){const match=line.match(/^\s*(BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID|BOOTSTRAP_CLOUDFLARE_API_TOKEN)\s*=\s*(.*?)\s*$/);if(match&&!values[match[1]])values[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');}
const account=values.BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID,token=values.BOOTSTRAP_CLOUDFLARE_API_TOKEN;
assert.match(account??'',/^[a-f0-9]{32}$/);assert.ok(token,'Cloudflare bootstrap token missing');
const directory=process.env.LOGT_E2E_CLOUDFLARE_LEDGER?dirname(resolve(process.env.LOGT_E2E_CLOUDFLARE_LEDGER)):cleanupOnly?null:mkdtempSync(join((mkdirSync(join(root,'.tmp/cloudflare-e2e'),{recursive:true,mode:0o700}),join(root,'.tmp/cloudflare-e2e')),'run-'));
if(!directory)throw new Error('Cleanup requires LOGT_E2E_CLOUDFLARE_LEDGER');
const ledgerPath=resolve(process.env.LOGT_E2E_CLOUDFLARE_LEDGER??join(directory,'run.json'));const stat=lstatSync(directory);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.uid===process.getuid(),'Cloudflare ledger requires an owned private directory');
let state,tailSocket;
function flush(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function save(){const stage=ledgerPath+'.stage';writeFileSync(stage,JSON.stringify(state,null,2)+'\n',{mode:0o600});flush(stage);renameSync(stage,ledgerPath);flush(directory);}
function validate(){validateCloudflareRehearsal(state,account);}

let requests=0,cleanupRequests=0,cleaning=false,cleanupDeadline=0;const deadline=Date.now()+15*60*1000;
async function api(path,init={},optional=false,envelope=false){
 if(cleaning?(++cleanupRequests>80||Date.now()>cleanupDeadline):(++requests>500||Date.now()>deadline))throw new Error('Cloudflare rehearsal observation budget exhausted');
 const workerMutation=path===`${base}/workers/scripts/${state.name}/secrets`&&init.method==='PUT';if(workerMutation){state.pendingWorkerMutation=true;save();}
 const response=await fetch('https://api.cloudflare.com/client/v4'+path,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...init.headers},redirect:'manual',signal:AbortSignal.timeout(30000)});
 if(optional&&response.status===404){await response.body?.cancel();return null;}
 if(!response.ok){if(workerMutation&&response.status===404){state.pendingWorkerMutation=false;save();}let errors=[];try{errors=(await response.json()).errors?.map(e=>({code:e.code,message:String(e.message).replaceAll(token,'[redacted]').slice(0,400)}))??[];}catch{}writeFileSync(join(directory,'api-error.json'),JSON.stringify({status:response.status,errors},null,2)+'\n',{mode:0o600});throw new Error(`Cloudflare API ${init.method??'GET'} failed (${response.status}); private diagnostic saved`);}
 const result=await response.json();if(!result.success)throw new Error('Cloudflare API rejected the rehearsal request');if(workerMutation){state.pendingWorkerMutation=false;save();}return envelope?result:result.result;
}
async function inventory(path){const all=[];for(let page=1;page<=20;page++){const response=await api(`${path}?page=${page}&per_page=100`,{},false,true);assert.ok(Array.isArray(response.result));all.push(...response.result);const info=response.result_info;const pages=info?.total_pages??(info?.total_count?Math.ceil(info.total_count/(info.per_page??100)):1);assert.ok(Number.isSafeInteger(pages)&&pages>=1&&pages<=20,'Cloudflare inventory pagination exceeds the rehearsal budget');if(page>=pages)return all;}throw new Error('Incomplete Cloudflare inventory');}
const base=`/accounts/${account}`;
async function query(sql,params=[]){validate();assert.ok(state.databaseId);const result=await api(`${base}/d1/database/${state.databaseId}/query`,{method:'POST',body:JSON.stringify({sql,params})});assert.ok(result.every(r=>r.success),'Rehearsal D1 query failed');return result[0].results;}
async function command(label,args,env={}){
 // A child waits for the durable PID marker before starting provider work.
 const child=spawn(process.execPath,['--import',join(root,'scripts/rehearsal-child-gate.mjs'),join(root,'node_modules/wrangler/wrangler-dist/cli.js'),...args],{cwd:directory,env:{...process.env,NODE_OPTIONS:'',CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:account,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG:'error',...env},stdio:['pipe','pipe','pipe']});
 state.childPid=child.pid??null;child.stdin.on('error',()=>{});state.childOperation=label;save();child.stdin.end('go\n');let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 const result=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>accept({code,signal}));});clearTimeout(timer);state.childPid=null;save();
 writeFileSync(join(directory,label+'.log'),output.replaceAll(token,'[redacted]').slice(-30000),{mode:0o600});if(result.code!==0)throw new Error(`${label} failed; retain the private rehearsal ledger/log`);
}
async function cleanup(){
 cleaning=true;cleanupDeadline=Date.now()+120000;validate();tailSocket?.close();if(state.tailId){await api(`${base}/workers/scripts/${state.name}/tails/${state.tailId}`,{method:'DELETE'},true);state.tailId=null;save();}if(state.childPid){try{process.kill(state.childPid,0);throw new Error('Rehearsal provider child is still running; cleanup refused');}catch(error){if(error.code!=='ESRCH')throw error;}state.childPid=null;save();}
 // Names derive solely from this persisted random run, never production names.
 const workers=await inventory(`${base}/workers/scripts`),worker=workers.find(w=>w.id===state.name);
 if(worker){const settings=await api(`${base}/workers/scripts/${state.name}/settings`);assertCloudflareRehearsalOwnership('worker',state,settings);await api(`${base}/workers/scripts/${state.name}`,{method:'DELETE'});}
 else if(state.workerPhase==='deploying')throw new Error('Unresolved Worker upload; retain the ledger for outcome investigation');
 state.workerPhase='deleted';state.pendingWorkerMutation=false;save();
 const databases=await inventory(`${base}/d1/database`);const database=databases.find(d=>d.name===state.name);
 if(database){assertCloudflareRehearsalOwnership('database',state,database);state.databaseId=database.uuid;save();await api(`${base}/d1/database/${database.uuid}`,{method:'DELETE'});}
 else if(state.databasePhase==='creating'&&!state.databaseId)throw new Error('Unresolved database creation; retain the ledger');
 state.databasePhase='deleted';save();
 const queues=await inventory(`${base}/queues`);const queue=queues.find(q=>q.queue_name===state.queueName);
 if(queue){assertCloudflareRehearsalOwnership('queue',state,queue);state.queueId=queue.queue_id;save();await api(`${base}/queues/${queue.queue_id}`,{method:'DELETE'});}
 else if(state.queuePhase==='creating'&&!state.queueId)throw new Error('Unresolved queue creation; retain the ledger');
 state.queuePhase='deleted';save();
 assert.ok(!(await inventory(`${base}/workers/scripts`)).some(w=>w.id===state.name));assert.ok(!(await inventory(`${base}/d1/database`)).some(d=>d.name===state.name));assert.ok(!(await inventory(`${base}/queues`)).some(q=>q.queue_name===state.queueName));state.status='cleaned';save();
}
console.log(`Cloudflare rehearsal private ledger: ${ledgerPath}`);
await withPrivateDirectoryLock(ledgerPath+'.lock',async()=>{
 if(cleanupOnly){const file=lstatSync(ledgerPath);assert.ok(file.isFile()&&!file.isSymbolicLink()&&(file.mode&0o077)===0&&file.uid===process.getuid());state=JSON.parse(readFileSync(ledgerPath,'utf8'));await cleanup();console.log('Owned Cloudflare rehearsal resources are absent');return;}
 assert.ok(!existsSync(ledgerPath),'Use cleanup for an existing rehearsal ledger');const runId=randomUUID().replaceAll('-','');state={schemaVersion:1,accountId:account,runId,name:`logtura-e2e-${runId}`,queueName:`logtura-e2e-${runId}-jobs`,databaseId:null,queueId:null,databasePhase:'planned',queuePhase:'planned',workerPhase:'planned',childPid:null,status:'active',outcome:'not_run',lastMigration:null};save();
 const artifact=process.env.LOGT_E2E_CLOUDFLARE_ARTIFACT;if(!artifact)throw new Error('Set LOGT_E2E_CLOUDFLARE_ARTIFACT to a verified packed-service export');
 const manifest=JSON.parse(readFileSync(join(artifact,'manifest.json'),'utf8'));const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;assert.equal(digest(readFileSync(join(artifact,'worker.js'))),manifest.workerDigest);for(const item of manifest.migrations){assert.match(item.file,/^\d{4}_[a-z0-9_]+\.sql$/);assert.equal(digest(readFileSync(join(artifact,'migrations',item.file))),item.digest);}state.workerDigest=manifest.workerDigest;state.sourceCommit=manifest.sourceCommit;state.migrationDigests=manifest.migrations;save();
 let failure;
 try{
  const subdomain=(await api(`${base}/workers/subdomain`)).subdomain;assert.match(subdomain,/^[a-z0-9-]+$/);const url=`https://${state.name}.${subdomain}.workers.dev`;
  assert.ok(!(await inventory(`${base}/d1/database`)).some(d=>d.name===state.name));assert.ok(!(await inventory(`${base}/queues`)).some(q=>q.queue_name===state.queueName));assert.ok(!(await inventory(`${base}/workers/scripts`)).some(w=>w.id===state.name));
  state.freshNamesVerified=true;save();
  state.databasePhase='creating';save();const database=await api(`${base}/d1/database`,{method:'POST',body:JSON.stringify({name:state.name})});state.databaseId=database.uuid;state.databasePhase='created';save();validate();
  state.queuePhase='creating';save();const queue=await api(`${base}/queues`,{method:'POST',body:JSON.stringify({queue_name:state.queueName})});state.queueId=queue.queue_id;state.queuePhase='created';save();
  const migrations=await readD1Migrations(join(artifact,'migrations'));assert.equal(migrations[16].name,'0017_connection_provider_installation.sql');
  await query('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  async function migrate(list){for(const m of list){for(let i=0;i<m.queries.length;i++){state.migrationAttempt={name:m.name,query:i};save();await query(m.queries[i]);}await query('INSERT INTO d1_migrations(name) VALUES(?)',[m.name]);state.lastMigration=m.name;save();}}
  await migrate(migrations.slice(0,17));const priorMigrations=await query('SELECT * FROM d1_migrations ORDER BY id');assert.equal(priorMigrations.length,17);
  const legacyUser=`usr_legacy_${runId}`,routingUser=`usr_routing_${runId}`,dep=`dep_${runId}`,con=`con_${runId}`,heartbeat=randomUUID(),now=Date.now();
  for(const user of [legacyUser,routingUser])await query('INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES(?,?,?,?,?)',[user,user,'rehearsal',now,now]);
  await query("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES(?,?,'cloudflare-worker-tail','Legacy fixture',x'010203',?,?)",[con,legacyUser,now,now]);
  await query("INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,created_at,updated_at) VALUES(?,?,?,'fly','Legacy fixture',0,'running',?,?,?)",[dep,legacyUser,con,heartbeat,now,now]);
  const src=`src_${runId}`,dst=`dst_${runId}`,mon=`mon_${runId}`,sink=`snk_${runId}`;
  await query("INSERT INTO log_sources(id,connection_id,source_kind,external_id,display_name,discovered_at) VALUES(?,?,'cf_worker','synthetic-worker','Legacy source',?)",[src,con,now]);
  await query("INSERT INTO destinations(id,user_id,kind,display_name,config_encrypted,created_at,updated_at) VALUES(?,?,'webhook','Legacy destination',x'010203',?,?)",[dst,legacyUser,now,now]);
  await query("INSERT INTO monitors(id,user_id,connection_id,display_name,filter_steps_json,enabled,created_at,updated_at) VALUES(?,?,?,'Legacy monitor','[{\"kind\":\"errors\"}]',1,?,?)",[mon,legacyUser,con,now,now]);
  await query("INSERT INTO sinks(id,monitor_id,destination_id,filter_steps_json,created_at) VALUES(?,?,?,'[]',?)",[sink,mon,dst,now]);
  await query('INSERT INTO deployment_connections(deployment_id,connection_id,added_at) VALUES(?,?,?)',[dep,con,now]);
  await query('UPDATE deployments SET source_selection_json=?,monitor_selection_json=?,metrics_target=? WHERE id=?',[JSON.stringify([src]),JSON.stringify([mon]),JSON.stringify({kind:'logtura'}),dep]);
  const tables=['connections','deployments','log_sources','destinations','monitors','sinks','deployment_connections'],before=[];
  for(const table of tables){const columns=(await query(`PRAGMA table_info(${table})`)).map(column=>column.name);before.push({table,columns,rows:await query(`SELECT ${columns.join(',')} FROM ${table}`)});}
  await migrate(migrations.slice(17));for(const item of before)assert.deepEqual(await query(`SELECT ${item.columns.join(',')} FROM ${item.table}`),item.rows);assert.deepEqual(await query('SELECT * FROM d1_migrations WHERE id<=17 ORDER BY id'),priorMigrations);assert.deepEqual((await query('SELECT name FROM d1_migrations ORDER BY id')).map(row=>row.name),migrations.map(m=>m.name));state.migrationPreservedLegacy=true;state.preservedLegacyTables=tables;state.migrationTrackingPreserved=true;save();console.log('Remote D1: schema 17 → current preserves the synthetic legacy deployment');
  const config=join(directory,'wrangler.toml');writeFileSync(config,`name = ${JSON.stringify(state.name)}\nmain = ${JSON.stringify(resolve(artifact,'worker.js'))}\ncompatibility_date = "2025-05-01"\ncompatibility_flags = ["nodejs_compat"]\nworkers_dev = true\n[vars]\nAPP_URL = ${JSON.stringify(url)}\n[assets]\ndirectory = ${JSON.stringify(resolve(artifact,'dist'))}\nbinding = "ASSETS"\nnot_found_handling = "single-page-application"\nrun_worker_first = true\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = ${JSON.stringify(state.name)}\ndatabase_id = ${JSON.stringify(state.databaseId)}\n[[queues.producers]]\nbinding = "JOBS_QUEUE"\nqueue = ${JSON.stringify(state.queueName)}\n`,{mode:0o600});
  state.workerPhase='deploying';save();await command('deploy',['deploy','--config',config,'--no-bundle']);state.workerPhase='deployed';save();
  const session=randomUUID();for(const [name,text] of [['SESSION_SECRET',session],['CREDENTIAL_ENCRYPTION_KEY','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']])await api(`${base}/workers/scripts/${state.name}/secrets`,{method:'PUT',body:JSON.stringify({name,text,type:'secret_text'})});
  const tail=await api(`${base}/workers/scripts/${state.name}/tails`,{method:'POST',body:'{}'});assert.match(tail.id,/^[a-zA-Z0-9_-]{1,128}$/);state.tailId=tail.id;save();
  const events=[];tailSocket=new WebSocket(tail.url,'trace-v1');tailSocket.onmessage=async event=>{try{if(events.length>=100)return;const text=typeof event.data==='string'?event.data:await event.data.text(),message=JSON.parse(text);events.push({outcome:message.outcome,exceptions:message.exceptions,logs:message.logs?.map(log=>log.message)});writeFileSync(join(directory,'worker-diagnostics.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600});}catch{}};
  await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('Rehearsal tail connection timed out')),15000);tailSocket.onopen=()=>{clearTimeout(timer);tailSocket.send(JSON.stringify({debug:false}));accept();};tailSocket.onerror=()=>{clearTimeout(timer);reject(new Error('Rehearsal tail connection failed'));};});
  const cookie=`logtura_session=${await signCookie(routingUser,session)}`;let ready=false;for(let attempt=0;attempt<20;attempt++){try{const response=await fetch(url+'/api/me',{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(10000)});ready=response.ok&&(await response.json()).user?.id===routingUser;if(ready)for(const path of ['/api/connections','/api/deployments']){const probe=await fetch(url+path,{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(10000)});ready=ready&&probe.ok;await probe.body?.cancel();}state.readinessAttempts=attempt+1;save();if(ready)break;}catch{}await new Promise(r=>setTimeout(r,1000));}assert.ok(ready,'Remote test account did not become ready');
  const ledger=new FileRunLedger(join(directory,'routing.json'));await ledger.runExclusive(()=>runRoutingLifecycle({baseUrl:url,fetch:request=>fetch(request),sessionCookie:cookie,expectedUserId:routingUser,runId:randomUUID(),ledger}));state.remoteRoutingPassed=true;save();
  for(const path of ['heartbeat','metrics']){const response=await fetch(`${url}/api/${path}/${dep}`,{method:'POST',headers:{authorization:`Bearer ${heartbeat}`,'content-type':'application/json'},body:path==='metrics'?JSON.stringify([{name:'component_sent_events_total',namespace:'vector',timestamp:new Date().toISOString(),tags:{component_id:'legacy_fixture',component_kind:'sink'},counter:{value:3}}]):'{}',redirect:'manual',signal:AbortSignal.timeout(20000)});assert.equal(response.status,204);}
  const legacy=await query('SELECT status,last_seen_at,metrics_snapshot_json FROM deployments WHERE id=?',[dep]);assert.equal(legacy[0].status,'running');assert.ok(legacy[0].last_seen_at>=now);assert.equal(JSON.parse(legacy[0].metrics_snapshot_json).totals.sent,3);state.legacyReportingPassed=true;state.status='passed';state.outcome='passed';save();console.log('Real remote HTTP routing lifecycle and unchanged legacy heartbeat/metrics authorization passed');
 }catch(error){failure=error;state.outcome='failed';save();await new Promise(resolve=>setTimeout(resolve,2000));}
 try{await cleanup();}catch(error){throw new Error('Cloudflare rehearsal cleanup incomplete; retain the ledger',{cause:error});}
 if(failure)throw failure;console.log(`Cloudflare rehearsal passed with ${requests+cleanupRequests} direct management API requests; all owned cloud resources deleted`);
},'Cloudflare E2E').then(
 // Node's diagnostic WebSocket can retain a socket after the tail is deleted.
 // The exclusive run lock has been released and cleanup proved absence here.
 () => process.exit(0),
 error => { console.error(error); process.exit(1); },
);
