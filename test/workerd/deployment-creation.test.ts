import {createExecutionContext,env,waitOnExecutionContext} from 'cloudflare:test';
import {expect,it} from 'vitest';
import worker from '../../src/index';
import {createOwnedDeployment,readDeploymentCreation} from '../../src/deployment-creation';
import {createConnection,createMonitor,listDeployments,getDeployment,upsertSources,listSources} from '../../src/db';
import {readConfigurationVersion} from '../../src/config-version';
import {seedUser} from './_setup';
const id='00000000-0000-4000-8000-000000000001';
async function fixture(){const user=await seedUser(),connection=await createConnection(env.DB,env,{userId:user.userId,provider:'cloudflare-worker-tail',displayName:'Account',externalAccountId:'account',credentials:{apiToken:'fixture-private'}});return {...user,connection,request:{requestId:id,connectionId:connection.id,displayName:'CLI created',targetKind:'other',sourceIds:null,monitorIds:[],fly:null}};}
async function request(path:string,cookie?:string,method='GET',body?:unknown,raw=false){const ctx=createExecutionContext(),response=await worker.fetch(new Request('http://localhost/api'+path,{method,headers:{...(cookie?{cookie}:{}),'content-type':'application/json'},body:body===undefined?undefined:raw?String(body):JSON.stringify(body)}),env,ctx);await waitOnExecutionContext(ctx);return response;}
it('creates one self-managed record, preserves receipt identity across retries/edits/deletion and fences ownership',async()=>{
 const f=await fixture(),other=await fixture();expect(await readDeploymentCreation(env.DB,f.userId,id)).toBeNull();
 const first=await createOwnedDeployment(env.DB,f.userId,f.request),version=await readConfigurationVersion(env.DB,f.userId);
 expect(first.status).toBe('created');expect((await getDeployment(env.DB,f.userId,first.deployment.id))!.managed).toBe(0);
 await env.DB.prepare("UPDATE deployments SET display_name='Website rename' WHERE id=?").bind(first.deployment.id).run();
 expect(await createOwnedDeployment(env.DB,f.userId,f.request)).toEqual(first);expect((await listDeployments(env.DB,f.userId)).length).toBe(1);
 expect(await readDeploymentCreation(env.DB,other.userId,id)).toBeNull();await expect(createOwnedDeployment(env.DB,f.userId,{...f.request,displayName:'Different'})).rejects.toMatchObject({status:409,code:'creation_request_conflict'});
 await env.DB.prepare('DELETE FROM deployments WHERE id=?').bind(first.deployment.id).run();expect(await createOwnedDeployment(env.DB,f.userId,f.request)).toMatchObject({status:'deleted',deployment:first.deployment});expect(await listDeployments(env.DB,f.userId)).toEqual([]);
 expect(await readConfigurationVersion(env.DB,f.userId)).toBeGreaterThan(version);
 await expect(env.DB.prepare("UPDATE deployment_creation_receipts SET request_json='{}' WHERE user_id=?").bind(f.userId).run()).rejects.toThrow('LOGT_CREATION_IMMUTABLE');
});
it('commits concurrent same-intent calls once and rejects competing intent without orphan rows',async()=>{
 const f=await fixture(),receipts=await Promise.all([createOwnedDeployment(env.DB,f.userId,f.request),createOwnedDeployment(env.DB,f.userId,f.request)]);expect(receipts[0]).toEqual(receipts[1]);expect(await listDeployments(env.DB,f.userId)).toHaveLength(1);
 const other={...f.request,requestId:'00000000-0000-4000-8000-000000000002'};
 const results=await Promise.allSettled([createOwnedDeployment(env.DB,f.userId,other),createOwnedDeployment(env.DB,f.userId,{...other,displayName:'Competing'})]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await listDeployments(env.DB,f.userId)).toHaveLength(2);
});
it('checks every explicit source/monitor owner before writing and preserves empty/all selections',async()=>{
 const f=await fixture(),foreign=await fixture();await expect(createOwnedDeployment(env.DB,f.userId,{...f.request,connectionId:foreign.connection.id})).rejects.toMatchObject({code:'connection_not_found'});
 await expect(createOwnedDeployment(env.DB,f.userId,{...f.request,sourceIds:['unowned']})).rejects.toMatchObject({code:'source_not_found'});
 await expect(createOwnedDeployment(env.DB,f.userId,{...f.request,monitorIds:['unowned']})).rejects.toMatchObject({code:'monitor_not_found'});
 await upsertSources(env.DB,f.connection.id,[{sourceKind:'cloudflare_worker',externalId:'worker',displayName:'Worker',metadata:{}}]);const sources=await listSources(env.DB,f.connection.id),monitor=await createMonitor(env.DB,{userId:f.userId,connectionId:f.connection.id,displayName:'Monitor',filterSteps:[]});
 const created=await createOwnedDeployment(env.DB,f.userId,{...f.request,sourceIds:sources.map(s=>s.id),monitorIds:[monitor.id]});expect((await getDeployment(env.DB,f.userId,created.deployment.id))!.source_selection_json).toBe(JSON.stringify(sources.map(s=>s.id)));
 const empty=await createOwnedDeployment(env.DB,f.userId,{...f.request,requestId:'00000000-0000-4000-8000-000000000002',sourceIds:[],monitorIds:null});expect((await getDeployment(env.DB,f.userId,empty.deployment.id))!.source_selection_json).toBe('[]');expect((await getDeployment(env.DB,f.userId,empty.deployment.id))!.monitor_selection_json).toBeNull();
});
it('does not mask failed storage or claim a missing commit receipt',async()=>{
 const f=await fixture(),error=new Error('storage unavailable');const failed={prepare:(sql:string)=>env.DB.prepare(sql),batch:async()=>{throw error;}} as unknown as D1Database;
 await expect(createOwnedDeployment(failed,f.userId,f.request)).rejects.toBe(error);expect(await listDeployments(env.DB,f.userId)).toEqual([]);
 let committed=false;const missing={prepare:(sql:string)=>sql.startsWith('SELECT request_json')&&committed?{bind:()=>({first:async()=>null})}:env.DB.prepare(sql),batch:async(statements:D1PreparedStatement[])=>{const value=await env.DB.batch(statements);committed=true;return value;}} as unknown as D1Database;
 await expect(createOwnedDeployment(missing,f.userId,f.request)).rejects.toThrow('receipt missing');expect(await listDeployments(env.DB,f.userId)).toHaveLength(1);
});
it('exposes scoped authenticated creation and receipt HTTP contracts without credentials',async()=>{
 const f=await fixture(),foreign=await fixture();expect((await request('/deployments/creations',undefined,'POST',f.request)).status).toBe(303);
 for(const bad of [{}, {...f.request,extra:'private'},'{'])expect((await request('/deployments/creations',f.sessionCookie,'POST',bad,typeof bad==='string')).status).toBe(400);
 expect((await request('/deployments/creations/bad',f.sessionCookie)).status).toBe(400);expect((await request('/deployments/creations/'+id,f.sessionCookie)).status).toBe(404);
 expect((await request('/deployments/creations',f.sessionCookie,'POST',{...f.request,targetKind:'unknown'})).status).toBe(400);
 expect((await request('/deployments/creations',f.sessionCookie,'POST',{...f.request,connectionId:foreign.connection.id})).status).toBe(404);
 const receipt=await (await request('/deployments/creations',f.sessionCookie,'POST',f.request)).json();expect(await (await request('/deployments/creations/'+id,f.sessionCookie)).json()).toEqual(receipt);
 expect((await request('/deployments/creations/'+id,foreign.sessionCookie)).status).toBe(404);expect((await request('/deployments/creations',f.sessionCookie,'POST',{...f.request,displayName:'conflict'})).status).toBe(409);expect(JSON.stringify(receipt)).not.toContain('fixture-private');
});

it('creates an atomically linked existing self-managed Fly identity without provider writes',async()=>{
 const f=await fixture(),receipt=await createOwnedDeployment(env.DB,f.userId,{...f.request,targetKind:'fly',fly:{appName:'owned-app',machineId:'abc123'}});
 const deployment=await getDeployment(env.DB,f.userId,receipt.deployment.id);expect(deployment).toMatchObject({external_id:'fly:owned-app:abc123',managed:0});expect(JSON.parse(deployment!.metadata_json!)).toEqual({appName:'owned-app',machineId:'abc123'});
});
