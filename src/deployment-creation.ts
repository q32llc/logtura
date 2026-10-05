import {canonicalConfigJson,validateDeploymentCreationRequest,validateDeploymentCreationReceipt,matchesDeploymentCreation,type DeploymentCreationRequest,type DeploymentCreationReceipt} from '@logtura/core';
import {getConnection,getDeployment,getSourcesByIdsForUser,listMonitors,prepareDeploymentCreation} from './db';
export class DeploymentCreationError extends Error {
 constructor(readonly status:400|404|409,readonly code:string){super(code);}
}
export async function readDeploymentCreation(db:D1Database,userId:string,requestId:string):Promise<DeploymentCreationReceipt|null>{
 const row=await db.prepare('SELECT request_json,deployment_id FROM deployment_creation_receipts WHERE user_id=? AND request_id=?').bind(userId,requestId).first<{request_json:string;deployment_id:string}>();
 if(!row)return null;
 const request=validateDeploymentCreationRequest(JSON.parse(row.request_json));
 return validateDeploymentCreationReceipt({schemaVersion:1,request,deployment:{id:row.deployment_id,displayName:request.displayName},status:await getDeployment(db,userId,row.deployment_id)?'created':'deleted'});
}
export async function createOwnedDeployment(db:D1Database,userId:string,input:DeploymentCreationRequest):Promise<DeploymentCreationReceipt>{
 const request=validateDeploymentCreationRequest(input);
 const existing=await readDeploymentCreation(db,userId,request.requestId);
 const verify=(receipt:DeploymentCreationReceipt)=>{if(!matchesDeploymentCreation(receipt,request))throw new DeploymentCreationError(409,'creation_request_conflict');return receipt;};
 if(existing)return verify(existing);
 if(!await getConnection(db,userId,request.connectionId))throw new DeploymentCreationError(404,'connection_not_found');
 if(request.sourceIds)for(let offset=0;offset<request.sourceIds.length;offset+=50){const ids=request.sourceIds.slice(offset,offset+50);if((await getSourcesByIdsForUser(db,userId,ids)).length!==ids.length)throw new DeploymentCreationError(404,'source_not_found');}
 if(request.monitorIds){const owned=new Set((await listMonitors(db,userId)).map(m=>m.id));if(request.monitorIds.some(id=>!owned.has(id)))throw new DeploymentCreationError(404,'monitor_not_found');}
 const prepared=prepareDeploymentCreation(db,{userId,connectionId:request.connectionId,displayName:request.displayName,targetKind:request.targetKind,managed:false,sourceIds:request.sourceIds,monitorIds:request.monitorIds,externalId:request.fly?`fly:${request.fly.appName}:${request.fly.machineId}`:null,metadata:request.fly??null});
 try{await db.batch([
  db.prepare('INSERT INTO deployment_creation_receipts(user_id,request_id,request_json,deployment_id,created_at) VALUES (?,?,?,?,?)').bind(userId,request.requestId,canonicalConfigJson(request),prepared.id,Date.now()),prepared.statement,
 ]);}catch(error){const receipt=await readDeploymentCreation(db,userId,request.requestId);if(receipt)return verify(receipt);throw error;}
 const receipt=await readDeploymentCreation(db,userId,request.requestId);if(!receipt)throw new Error('Deployment creation receipt missing after commit');return verify(receipt);
}
