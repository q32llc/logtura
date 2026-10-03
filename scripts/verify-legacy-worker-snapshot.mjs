import {readFileSync,writeFileSync,mkdtempSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';import {resolve} from 'node:path';
import assert from 'node:assert/strict';import {Miniflare} from 'miniflare';
import {readD1Migrations} from '@cloudflare/vitest-pool-workers';
import {backupSqlFile,restoredMigrationCount,validateRegistryCandidate,capturedMainModule} from './compatibility-snapshot-state.mjs';
assert.ok(process.argv.length===4||process.argv.length===5,'Usage: verify-legacy-worker-snapshot.mjs <private-worker-snapshot> <private-database-backup> [private-registry-candidate]');
const root=process.cwd(),rollback=resolve(process.argv[2]),backup=resolve(process.argv[3]),candidate=process.argv[4]?resolve(process.argv[4]):null;
for(const directory of [rollback,backup,...(candidate?[candidate]:[])]){const stat=lstatSync(directory);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&(stat.mode&0o077)===0,'Snapshot inputs require owned private directories');assert.equal(realpathSync(directory),directory);}
function privateFile(directory,name){const stat=lstatSync(resolve(directory,name));assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&(stat.mode&0o077)===0,'Snapshot inputs require owned private files');}
privateFile(backup,'backup-receipt.json');
const backupReceipt=JSON.parse(readFileSync(backup+'/backup-receipt.json','utf8')),sqlFile=backupSqlFile(backupReceipt);
for(const [directory,names]of [[rollback,['rollback.json','worker-content.bin','worker-content-type.txt']],[backup,[sqlFile]],...(candidate?[[candidate,['manifest.json','worker.js']]]:[])])for(const name of names)privateFile(directory,name);
const privateDirectory=mkdtempSync(resolve(rollback,candidate?'candidate-native-':'legacy-native-'));
console.log('Native compatibility private evidence: '+privateDirectory);
const receipt=JSON.parse(readFileSync(rollback+'/rollback.json','utf8'));
const sourceBytes=readFileSync(rollback+'/worker-content.bin');assert.equal(createHash('sha256').update(sourceBytes).digest('hex'),receipt.sourceDigest);
const form=await new Response(sourceBytes,{headers:{'content-type':readFileSync(rollback+'/worker-content-type.txt','utf8')}}).formData();
const main=form.get(capturedMainModule([...form.keys()]));let script=typeof main==='string'?main:await main.text();let candidateManifest;if(candidate){candidateManifest=JSON.parse(readFileSync(resolve(candidate,'manifest.json'),'utf8'));const bytes=readFileSync(resolve(candidate,'worker.js'));assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),candidateManifest.workerDigest);validateRegistryCandidate(candidateManifest);script=bytes.toString();}const expectedSent=candidate?4294967307:11;
let outboundRequests=0;
const service=new Miniflare({modules:true,script,compatibilityDate:receipt.settings.compatibility_date??'2025-05-01',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],d1Persist:false,queueProducers:{JOBS_QUEUE:'compat-jobs'},queuePersist:false,bindings:{APP_URL:'http://127.0.0.1',SESSION_SECRET:'isolated-compatibility',CREDENTIAL_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'},outboundService:()=>{outboundRequests++;return Response.json({error:'outbound_denied'},{status:503});}});
let step='initialize';
try{
 await service.ready;const database=await service.getD1Database('DB');
 step='restore';const sql=readFileSync(backup+'/'+sqlFile,'utf8');assert.equal(createHash('sha256').update(sql).digest('hex'),backupReceipt.sha256);
 const dumps=await readD1Migrations(resolve(backup));assert.equal(dumps.length,1);await database.batch(dumps[0].queries.map(query=>database.prepare(query)));
 const oldMigrations=await database.prepare('SELECT name FROM d1_migrations ORDER BY id').all(),migrations=await readD1Migrations(resolve(root,'migrations'));
 const priorMigrations=restoredMigrationCount(oldMigrations.results.map(m=>m.name),migrations,sqlFile);
 const before=await database.prepare('SELECT * FROM deployments').all();assert.equal(before.results.length,1);const legacy=before.results[0];assert.equal(legacy.managed,0);assert.equal(legacy.status,'running');assert.ok(legacy.heartbeat_token);
 writeFileSync(privateDirectory+'/legacy-before.json',JSON.stringify(legacy),{mode:0o600});
 step='migrate';
 for(const migration of migrations.slice(priorMigrations)){await database.batch(migration.queries.map(query=>database.prepare(query)));await database.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(migration.name).run();}
 const after=await database.prepare('SELECT * FROM deployments').all();for(const [key,value]of Object.entries(legacy))assert.deepEqual(after.results[0][key],value,'Legacy field changed: '+key);
 assert.equal((await database.prepare('SELECT name FROM d1_migrations').all()).results.length,migrations.length);
 step='old-worker-requests';
 const call=(path,token,body)=>service.dispatchFetch(`http://127.0.0.1/api/${path}/${legacy.id}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const unauthorized=await call('heartbeat','invalid-fixture',{});assert.equal(unauthorized.status,401);await unauthorized.body?.cancel();
 const heartbeat=await call('heartbeat',legacy.heartbeat_token,{});assert.equal(heartbeat.status,204);
 const now=Date.now();const metrics=await call('metrics',legacy.heartbeat_token,[{name:'component_sent_events_total',namespace:'vector',timestamp:new Date(now).toISOString(),tags:{component_id:'compatibility_fixture',component_kind:'sink'},counter:{value:expectedSent}}]);assert.equal(metrics.status,204);
 const reported=await database.prepare('SELECT status,last_seen_at,metrics_snapshot_json FROM deployments WHERE id=?').bind(legacy.id).first();assert.equal(reported.status,'running');assert.ok(reported.last_seen_at>Date.now()-30000);const reportedSnapshot=JSON.parse(reported.metrics_snapshot_json);assert.equal(reportedSnapshot.byComponent.compatibility_fixture.sent,expectedSent);
 const foreign=await database.prepare('PRAGMA foreign_key_check').all();assert.deepEqual(foreign.results,[]);
 assert.equal(outboundRequests,0,'Unexpected outbound provider request in compatibility replay');
 const evidence={schemaVersion:1,status:'passed',workerSourceDigest:candidateManifest?.workerDigest??receipt.sourceDigest,restoredProductionData:true,priorMigrations,currentMigrations:migrations.length,runtime:candidate?'registry-candidate':'captured-production-worker',originalDeploymentFieldsPreserved:Object.keys(legacy).length,heartbeatStatus:heartbeat.status,metricsStatus:metrics.status,invalidTokenStatus:unauthorized.status,persistedComponentSent:expectedSent,aggregateBefore:JSON.parse(legacy.metrics_snapshot_json).totals.sent,aggregateAfter:reportedSnapshot.totals.sent,foreignKeys:'passed',outboundRequests,productionMutated:false};
 writeFileSync(privateDirectory+'/receipt.json',JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));
}catch(error){writeFileSync(privateDirectory+'/failure.txt',String(error?.stack??error),{mode:0o600});console.error('Native old-Worker compatibility failed during '+step+'; private diagnostic retained');process.exitCode=1;}finally{await service.dispose();}
