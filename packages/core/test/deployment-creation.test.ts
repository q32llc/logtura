import {expect,it} from 'vitest';
import {validateDeploymentCreationRequest,validateDeploymentCreationReceipt,matchesDeploymentCreation,type DeploymentCreationRequest} from '../src/deployment-creation';
import {LogturaServiceClient} from '../src/service-client';
const id='00000000-0000-4000-8000-000000000001';
const input=():DeploymentCreationRequest=>({requestId:id,connectionId:'con_owned',displayName:'CLI created',targetKind:'fly',sourceIds:null,monitorIds:[],fly:null});
const receipt=()=>({schemaVersion:1 as const,request:input(),deployment:{id:'dep_created',displayName:'CLI created'},status:'created' as const});
it('clones valid owned-inventory creation requests and public deletion receipts',()=>{
 const request=input();expect(validateDeploymentCreationRequest(request)).toEqual(request);expect(validateDeploymentCreationRequest(request)).not.toBe(request);
 expect(validateDeploymentCreationRequest({...request,sourceIds:['src_owned'],monitorIds:null})).toMatchObject({sourceIds:['src_owned'],monitorIds:null});
 expect(validateDeploymentCreationRequest({...request,fly:{appName:'existing',machineId:'abc123'}})).toMatchObject({fly:{appName:'existing',machineId:'abc123'}});expect(validateDeploymentCreationReceipt(receipt())).toEqual(receipt());expect(validateDeploymentCreationReceipt({...receipt(),status:'deleted'})).toMatchObject({status:'deleted'});
 expect(matchesDeploymentCreation(receipt(),request)).toBe(true);expect(matchesDeploymentCreation(receipt(),{...request,displayName:'Other'})).toBe(false);
});
it.each([null,[],{}, {extra:true}, {requestId:'bad'}, {connectionId:0}, {connectionId:''},{connectionId:'x'.repeat(257)},{connectionId:'a\nb'},{displayName:null},{displayName:' '},{targetKind:'invalid target'},{sourceIds:'all'},{sourceIds:['x','x']},{sourceIds:[null]},{sourceIds:['']},{sourceIds:['x'.repeat(257)]},{sourceIds:['a\nb']},{sourceIds:Array.from({length:1001},(_,i)=>String(i))},{monitorIds:['','x']},{fly:{}},{fly:{appName:'app'}},{fly:{appName:'app',machineId:'abc123',region:'ord'}},{targetKind:'other',fly:{appName:'app',machineId:'abc123'}}])('rejects malformed creation input %j',patch=>{
 expect(()=>validateDeploymentCreationRequest(patch===null || Array.isArray(patch) || Object.keys(patch).length===0?patch:{...input(),...patch})).toThrow('Invalid deployment creation request');
});
it.each([null,[],{}, {extra:true},{schemaVersion:2},{status:'pending'},{request:{}},{deployment:null},{deployment:[]},{deployment:{}},{deployment:{id:'dep',displayName:'CLI created',extra:true}},{deployment:{id:'bad/id',displayName:'CLI created'}},{deployment:{id:'dep',displayName:'Other'}}])('rejects malformed creation receipts %j',patch=>{
 expect(()=>validateDeploymentCreationReceipt(patch===null || Array.isArray(patch) || Object.keys(patch).length===0?patch:{...receipt(),...patch})).toThrow('Invalid deployment creation receipt');
});
it('uses explicit account creation transport, validates correlation and handles only owned missing receipts',async()=>{
 const calls:Array<{path:string;method:string;body:unknown}>=[];let value:unknown=receipt(),status=200;
 const client=new LogturaServiceClient({url:'https://service.test',token:`lt_cli_${'a'.repeat(43)}`,fetch:async(url,init)=>{calls.push({path:new URL(String(url)).pathname,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}});
 expect(await client.createDeployment(input())).toEqual(receipt());expect(calls[0]).toMatchObject({path:'/api/deployments/creations',method:'POST',body:input()});
 expect(await client.getDeploymentCreation(id)).toEqual(receipt());value={error:'receipt_not_found'};status=404;expect(await client.getDeploymentCreation(id)).toBeNull();
 value={error:'not_found'};await expect(client.getDeploymentCreation(id)).rejects.toMatchObject({status:404});
 status=200;value={...receipt(),request:{...input(),requestId:'00000000-0000-4000-8000-000000000002'}};
 await expect(client.getDeploymentCreation(id)).rejects.toMatchObject({code:'invalid_creation_receipt'});await expect(client.createDeployment(input())).rejects.toMatchObject({code:'invalid_creation_receipt'});
 value={};await expect(client.getDeploymentCreation(id)).rejects.toMatchObject({code:'invalid_creation_receipt'});await expect(client.getDeploymentCreation('bad')).rejects.toThrow('identity');
 await expect(client.createDeployment({...input(),connectionId:''})).rejects.toThrow('request');
});
