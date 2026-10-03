import assert from 'node:assert/strict';
export function validateCloudflareRehearsal(state,account){
 assert.equal(state.schemaVersion,1);assert.equal(state.accountId,account);assert.match(state.runId,/^[a-f0-9]{32}$/);assert.equal(state.name,`logtura-e2e-${state.runId}`);assert.equal(state.queueName,state.name+'-jobs');
 if(state.databaseId)assert.match(state.databaseId,/^[a-f0-9-]{36}$/);if(state.queueId)assert.match(state.queueId,/^[a-f0-9]{32}$/);assert.notEqual(state.databaseId,'f8275804-591c-479b-b628-f678233b6bb6');
 for(const phase of [state.databasePhase,state.queuePhase])assert.ok(['planned','creating','created','deleted'].includes(phase));assert.ok(['planned','deploying','deployed','deleted'].includes(state.workerPhase));
 if(state.childPid!==null)assert.ok(Number.isSafeInteger(state.childPid)&&state.childPid>0);if(state.pendingWorkerMutation)assert.ok(state.workerPhase==='deployed'||state.workerPhase==='deleted'&&state.status==='cleaned');
}
/** A familiar name or a failed preflight cannot authorize provider deletion. */
export function assertCloudflareRehearsalOwnership(role,state,resource){
 assert.equal(state.freshNamesVerified,true,'Rehearsal names were not proved fresh');assert.notEqual(state[`${role}Phase`],'planned','Undispatched provider resource is not owned');
 if(role==='database'){assert.equal(resource.name,state.name);assert.ok(state.databaseId===resource.uuid||state.databaseId===null&&state.databasePhase==='creating','Rehearsal database identity changed');}
 else if(role==='queue'){assert.equal(resource.queue_name,state.queueName);assert.ok(state.queueId===resource.queue_id||state.queueId===null&&state.queuePhase==='creating','Rehearsal queue identity changed');}
 else {assert.equal(role,'worker');assert.ok(!state.pendingWorkerMutation,'Unresolved Worker mutation; retain the ledger');assert.ok(state.databaseId&&resource.bindings.some(b=>b.type==='d1'&&b.id===state.databaseId),'Rehearsal Worker ownership binding changed');}
}
