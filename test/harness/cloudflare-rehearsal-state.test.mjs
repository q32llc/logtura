import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateCloudflareRehearsal,assertCloudflareRehearsalOwnership} from '../../scripts/cloudflare-rehearsal-state.mjs';
const account='a'.repeat(32),runId='b'.repeat(32),databaseId='11111111-1111-4111-8111-111111111111',queueId='c'.repeat(32);
function state(){return {schemaVersion:1,accountId:account,runId,name:`logtura-e2e-${runId}`,queueName:`logtura-e2e-${runId}-jobs`,databaseId,queueId,databasePhase:'created',queuePhase:'created',workerPhase:'deployed',childPid:null,freshNamesVerified:true};}
function resources(s){return {database:{name:s.name,uuid:s.databaseId},queue:{queue_name:s.queueName,queue_id:s.queueId},worker:{bindings:[{type:'d1',id:s.databaseId}]}};}
test('validates pinned account/run/provider identities and refuses production or malformed ledgers',()=>{
 const s=state();validateCloudflareRehearsal(s,account);for(const change of [{accountId:'foreign'},{runId:'../escape'},{name:'logtura'},{queueName:'logtura-jobs'},{databaseId:'f8275804-591c-479b-b628-f678233b6bb6'},{queueId:'invalid'},{databasePhase:'unknown'},{workerPhase:'unknown'},{childPid:0},{childPid:'123'},{pendingWorkerMutation:true,workerPhase:'planned'}])assert.throws(()=>validateCloudflareRehearsal({...s,...change},account));
});
test('only dispatched intentions with fresh-name proof and exact physical ownership authorize deletion',()=>{
 const s=state(),r=resources(s);for(const role of ['database','queue','worker']){assertCloudflareRehearsalOwnership(role,s,r[role]);assert.throws(()=>assertCloudflareRehearsalOwnership(role,{...s,freshNamesVerified:false},r[role]));assert.throws(()=>assertCloudflareRehearsalOwnership(role,{...s,[role+'Phase']:'planned'},r[role]));}
 for(const [role,value] of [['database',{...r.database,uuid:'foreign'}],['database',{...r.database,name:'production'}],['queue',{...r.queue,queue_id:'foreign'}],['queue',{...r.queue,queue_name:'production'}],['worker',{bindings:[{type:'d1',id:'foreign'}]}]])assert.throws(()=>assertCloudflareRehearsalOwnership(role,s,value));
 assert.throws(()=>assertCloudflareRehearsalOwnership('worker',{...s,pendingWorkerMutation:true},r.worker));
 assertCloudflareRehearsalOwnership('database',{...s,databaseId:null,databasePhase:'creating'},r.database);assertCloudflareRehearsalOwnership('queue',{...s,queueId:null,queuePhase:'creating'},r.queue);
 assert.throws(()=>assertCloudflareRehearsalOwnership('database',{...s,databaseId:null},r.database));assert.throws(()=>assertCloudflareRehearsalOwnership('queue',{...s,queueId:null},r.queue));
});
