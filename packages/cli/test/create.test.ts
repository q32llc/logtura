import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,statSync,symlinkSync,mkdirSync,chmodSync,readdirSync} from 'node:fs';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {exportDeploymentManifest,createSecretVersioner,hashConfigDocument,FlyMachinesClient,LogturaServiceClient,type DeploymentCreationRequest,type DeploymentCreationReceipt} from '@logtura/core';
import {createLinkedDeployment,readPendingDeploymentCreation} from '../src/create';
import {pendingCreationPath,assertNoPendingPush} from '../src/file-transaction';
import {deploymentStatus} from '../src/deployment-link';
import {main} from '../src/main';
vi.mock('node:fs',{spy:true});const native=await vi.importActual<typeof fs>('node:fs');
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const root of roots.splice(0))native.rmSync(root,{recursive:true,force:true});});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'logtura-create-'));roots.push(root);const path=join(root,'logt.yaml');
 const input={connectionId:'con_owned',displayName:'CLI created',targetKind:'fly',sourceIds:null,monitorIds:[],fly:null};
 const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner('private-service'));
 let receipt:DeploymentCreationReceipt|null=null,mode='normal',owner='usr_owned',writes=0;
 const snapshot={...exported,revision:await hashConfigDocument(exported.document),deployment:{id:'dep_created',displayName:'CLI created'},configurationVersion:3,desiredSequence:0};
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  if(String(url).endsWith('/me'))return Response.json({user:{id:owner,githubLogin:'fixture'}});
  if(init?.method==='POST'){
   writes++;const pending=readPendingDeploymentCreation(path);expect(pending?.phase).toBe('dispatched');expect(statSync(pendingCreationPath(path)).mode&0o777).toBe(0o600);
   const request=JSON.parse(String(init.body)) as DeploymentCreationRequest;receipt={schemaVersion:1,request,deployment:snapshot.deployment,status:'created'};
   if(mode==='journal-race'){writeFileSync(pendingCreationPath(path),JSON.stringify({...pending,request:{...pending!.request,displayName:'Externally changed'}}),{mode:0o600});}
   if(mode==='lost-post'){mode='normal';throw new Error('lost response');}
   if(mode==='deleted-post')receipt.status='deleted';
   return Response.json(receipt);
  }
  if(String(url).includes('/creations/'))return receipt?Response.json(receipt):Response.json({error:'receipt_not_found'},{status:404});
  if(mode==='pull-failure')throw new Error('export unavailable');return Response.json(snapshot);
 });
 const client=new LogturaServiceClient({url:'https://service.test',token:`lt_cli_${'T'.repeat(43)}`,fetch});
 return {root,path,input,client,fetch,snapshot,get receipt(){return receipt;},set receipt(v){receipt=v;},get mode(){return mode;},set mode(v){mode=v;},set owner(v:string){owner=v;},get writes(){return writes;}};
}
it('creates, links and archives with private files, no provider calls or credential uploads',async()=>{
 const f=await fixture(),result=await createLinkedDeployment(f.client,f.path,{request:f.input});expect(result.deploymentId).toBe('dep_created');expect(result.revision).toBe(f.snapshot.revision);expect(f.writes).toBe(1);expect(existsSync(pendingCreationPath(f.path))).toBe(false);
 expect(statSync(result.archive).mode&0o777).toBe(0o600);expect(JSON.parse(readFileSync(result.archive,'utf8'))).toMatchObject({phase:'completed',receipt:{status:'created'}});
 expect(await deploymentStatus(f.path)).toMatchObject({linked:true,changes:[],privateChanges:[]});expect(statSync(join(f.root,'.env')).mode&0o777).toBe(0o600);expect(JSON.stringify(f.receipt)).not.toContain('private-service');
 expect(f.fetch.mock.calls.every(call=>String(call[0]).startsWith(f.client.url+'/api/'))).toBe(true);
});
it('recovers a lost creation response from the receipt without another POST and blocks other writes',async()=>{
 const f=await fixture();f.mode='lost-post';await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('lost response');
 expect(readPendingDeploymentCreation(f.path)?.phase).toBe('dispatched');expect(()=>assertNoPendingPush(f.path)).toThrow('Pending creation');expect(await deploymentStatus(f.path)).toMatchObject({linked:false,pendingCreation:{phase:'dispatched'}});
 await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('--resume');await createLinkedDeployment(f.client,f.path,{resume:true});expect(f.writes).toBe(1);
});
it('recovers a received creation after export failure without another POST',async()=>{
 const f=await fixture();f.mode='pull-failure';await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('export unavailable');expect(readPendingDeploymentCreation(f.path)?.phase).toBe('received');
 f.mode='normal';await createLinkedDeployment(f.client,f.path,{resume:true,request:f.input});expect(f.writes).toBe(1);
});
it('reconciles committed local files and an already linked archive after interrupted finalization',async()=>{
 const f=await fixture();let fail=true;vi.mocked(fs.rmSync).mockImplementation((path,options)=>{if(path===pendingCreationPath(f.path)&&fail){fail=false;throw new Error('unlink interrupted');}return native.rmSync(path,options);});
 await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('unlink interrupted');expect(readPendingDeploymentCreation(f.path)?.phase).toBe('completed');
 await createLinkedDeployment(f.client,f.path,{resume:true});expect(f.writes).toBe(1);expect(existsSync(pendingCreationPath(f.path))).toBe(false);
});
it('rejects changed local committed files and changed archives without overwriting evidence',async()=>{
 const f=await fixture();vi.mocked(fs.rmSync).mockImplementation((path,options)=>{if(path===pendingCreationPath(f.path))throw new Error('unlink interrupted');return native.rmSync(path,options);});
 await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('unlink interrupted');vi.mocked(fs.rmSync).mockImplementation(native.rmSync);
 writeFileSync(f.path,readFileSync(f.path,'utf8').replace('logtura.deployment','invalid.kind'));await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow();
 writeFileSync(f.path,readFileSync(f.path,'utf8').replace('invalid.kind','logtura.deployment'));
 const archive=readdirSync(f.root).find(name=>name.startsWith('.logtura-created-'))!;writeFileSync(join(f.root,archive),'changed',{mode:0o600});await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow();expect(readFileSync(join(f.root,archive),'utf8')).toBe('changed');
});
it('requires explicit force to repair a missing committed link without creating another deployment',async()=>{
 const f=await fixture();vi.mocked(fs.rmSync).mockImplementation((path,options)=>{if(path===pendingCreationPath(f.path))throw new Error('unlink interrupted');return native.rmSync(path,options);});
 await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('unlink interrupted');vi.mocked(fs.rmSync).mockImplementation(native.rmSync);
 rmSync(`${f.path}.logtura-link.json`);await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow('Locally committed creation changed');
 await createLinkedDeployment(f.client,f.path,{resume:true,force:true});expect(f.writes).toBe(1);expect(await deploymentStatus(f.path)).toMatchObject({linked:true,changes:[],privateChanges:[]});
});
it('never recreates a deleted creation and archives only its observed deletion',async()=>{
 const f=await fixture();f.mode='lost-post';await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow();
 await expect(createLinkedDeployment(f.client,f.path,{abandon:true})).rejects.toThrow('verified deleted');f.receipt={...f.receipt!,status:'deleted'};
 await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow('--abandon');const result=await createLinkedDeployment(f.client,f.path,{abandon:true});expect(result.abandoned).toBe(true);expect(f.writes).toBe(1);expect(JSON.parse(readFileSync(result.archive,'utf8'))).toMatchObject({phase:'abandoned',receipt:{status:'deleted'}});
});
it('keeps a deleted POST outcome recoverable without accepting or pulling it',async()=>{
 const f=await fixture();f.mode='deleted-post';await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('deleted');expect(readPendingDeploymentCreation(f.path)?.phase).toBe('dispatched');await createLinkedDeployment(f.client,f.path,{abandon:true});expect(f.writes).toBe(1);
});
it('fences origin, account, saved intent and receipt identity before recovery writes',async()=>{
 const f=await fixture();f.mode='lost-post';await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow();
 f.owner='other';await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow('account or origin');f.owner='usr_owned';
 const other=new LogturaServiceClient({url:'https://other.test',fetch:f.fetch});await expect(createLinkedDeployment(other,f.path,{resume:true})).rejects.toThrow('account or origin');
 await expect(createLinkedDeployment(f.client,f.path,{resume:true,request:{...f.input,displayName:'changed'}})).rejects.toThrow('saved intent');
 f.receipt={...f.receipt!,request:{...f.receipt!.request,displayName:'changed'},deployment:{...f.receipt!.deployment,displayName:'changed'}};await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow('saved intent');expect(f.writes).toBe(1);
});
it('refuses a missing or changed receipt after receiving it',async()=>{
 const f=await fixture();f.mode='pull-failure';await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow();const saved=f.receipt;f.receipt=null;await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow('receipt changed');
 f.receipt={...saved!,deployment:{...saved!.deployment,id:'dep_changed'}};await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow('receipt changed');expect(f.writes).toBe(1);
});
it('preflights local destinations and invalid recovery choices before POST',async()=>{
 const f=await fixture();for(const options of [{resume:true},{abandon:true},{abandon:true,resume:true},{}])await expect(createLinkedDeployment(f.client,f.path,options)).rejects.toThrow();
 writeFileSync(f.path,'keep');await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('exists');expect(f.writes).toBe(0);await createLinkedDeployment(f.client,f.path,{request:f.input,force:true});
 const second=await fixture();symlinkSync(join(second.root,'target'),second.path);await expect(createLinkedDeployment(second.client,second.path,{request:second.input,force:true})).rejects.toThrow('regular');expect(second.writes).toBe(0);
 for(const name of ['.env','.logtura-create.json','.logtura-create.lock'])await expect(createLinkedDeployment(second.client,join(second.root,name),{request:second.input})).rejects.toThrow('reserved');
});
it('reads only bounded private regular journals and validates their complete envelope',async()=>{
 const f=await fixture();expect(readPendingDeploymentCreation(f.path)).toBeNull();const path=pendingCreationPath(f.path);mkdirSync(path);expect(()=>readPendingDeploymentCreation(f.path)).toThrow('Invalid private');rmSync(path,{recursive:true});
 writeFileSync(join(f.root,'target'),'{}');symlinkSync(join(f.root,'target'),path);expect(()=>readPendingDeploymentCreation(f.path)).toThrow('private regular');rmSync(path);
 writeFileSync(path,'{}',{mode:0o644});expect(()=>readPendingDeploymentCreation(f.path)).toThrow('Invalid private');chmodSync(path,0o600);writeFileSync(path,'x'.repeat(2_097_153));expect(()=>readPendingDeploymentCreation(f.path)).toThrow('Invalid private');rmSync(path);
 f.mode='lost-post';await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow();const original=JSON.parse(readFileSync(path,'utf8'));
 for(const patch of [{schemaVersion:2},{config:'other'},{service:'https://service.test/'},{accountId:''},{phase:'bad'},{receipt:{}},{extra:true},{request:{}},{phase:'received',receipt:null}]){writeFileSync(path,JSON.stringify({...original,...patch}),{mode:0o600});expect(()=>readPendingDeploymentCreation(f.path)).toThrow('Invalid private');}
});
it('offers explicit create/recovery CLI flags and rejects unsupported or conflicting input',async()=>{
 const f=await fixture();vi.stubGlobal('fetch',f.fetch);vi.stubEnv('LOGT_SERVICE_URL',f.client.url);const auth=join(f.root,'auth.json');writeFileSync(auth,JSON.stringify({service:f.client.url,token:`lt_cli_${'T'.repeat(43)}`,scope:'account:read account:write',expiresAt:Date.now()+60000}),{mode:0o600});vi.stubEnv('LOGT_AUTH_FILE',auth);const log=vi.spyOn(console,'log').mockImplementation(()=>{}),error=vi.spyOn(console,'error').mockImplementation(()=>{});
 const code=await main(['-c',f.path,'create','--connection',f.input.connectionId,'--name',f.input.displayName,'--target','fly','--source-ids','none','--monitor-ids','none','--json']);expect(code,JSON.stringify(error.mock.calls)).toBe(0);expect(JSON.parse(String(log.mock.calls.at(-1)![0])).deploymentId).toBe('dep_created');
 for(const args of [[],['--bad'],['--connection','con','--name','Name','--app','app'],['--connection','con','--name','Name','--machine','machine'],['--resume','--connection','con'],['--connection','con'],['--connection','con','--name','Name','--source-ids','x,x']])expect(await main(['-c',f.path,'create',...args])).toBe(1);expect(error).toHaveBeenCalled();
});

it('retains changed private intent after a provider acknowledgement instead of overwriting it',async()=>{
 const f=await fixture();f.mode='journal-race';await expect(createLinkedDeployment(f.client,f.path,{request:f.input})).rejects.toThrow('journal changed');
 expect(readPendingDeploymentCreation(f.path)?.request.displayName).toBe('Externally changed');expect(existsSync(f.path)).toBe(false);expect(f.writes).toBe(1);
 await expect(createLinkedDeployment(f.client,f.path,{resume:true})).rejects.toThrow('saved intent');expect(f.writes).toBe(1);
});

it('verifies an explicitly linked Fly app/machine with read-only provider requests before creation',async()=>{
 const f=await fixture(),input={...f.input,fly:{appName:'owned-app',machineId:'abc123'}};
 await expect(createLinkedDeployment(f.client,f.path,{request:input})).rejects.toThrow('FLY_API_TOKEN');expect(f.writes).toBe(0);
 const requests:Array<string>=[];const fly=new FlyMachinesClient({token:'fixture-provider',fetch:async(url,init)=>{expect(init?.method).toBe('GET');requests.push(String(url));return Response.json(String(url).endsWith('/machines/abc123')?{id:'abc123',instance_id:'version',state:'started',region:'ord',config:{image:'registry.fixture/old:latest'},image_ref:{registry:'registry.fixture',repository:'old',digest:`sha256:${'a'.repeat(64)}`}}:{name:'owned-app',organization:{slug:'personal'}});}});
 const result=await createLinkedDeployment(f.client,f.path,{request:input,fly});expect(result.deploymentId).toBe('dep_created');expect(requests).toHaveLength(2);expect(f.receipt!.request.fly).toEqual(input.fly);
});
it('does not dispatch creation when provider verification rejects a selected machine',async()=>{
 const f=await fixture(),fly=new FlyMachinesClient({token:'fixture-provider',fetch:async()=>new Response('{}',{status:403})});
 await expect(createLinkedDeployment(f.client,f.path,{request:{...f.input,fly:{appName:'owned-app',machineId:'abc123'}},fly})).rejects.toThrow('403');expect(f.writes).toBe(0);expect(readPendingDeploymentCreation(f.path)).toBeNull();
});
it('blocks malformed or non-regular creation permits in the general configuration write guard',async()=>{
 const f=await fixture(),path=pendingCreationPath(f.path);
 for(const value of ['{','{}',JSON.stringify({request:{requestId:'wrong'}})]){writeFileSync(path,value,{mode:0o600});expect(()=>assertNoPendingPush(f.path,undefined,'permit')).toThrow('Pending creation');}
 rmSync(path);mkdirSync(path);expect(()=>assertNoPendingPush(f.path,undefined,'permit')).toThrow('Pending creation');rmSync(path,{recursive:true});
 symlinkSync(join(f.root,'target'),path);writeFileSync(join(f.root,'target'),JSON.stringify({request:{requestId:'permit'}}));expect(()=>assertNoPendingPush(f.path,undefined,'permit')).toThrow('Pending creation');
});
