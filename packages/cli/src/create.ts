import {constants,existsSync,lstatSync,openSync,fstatSync,readFileSync,writeFileSync,renameSync,fsyncSync,closeSync,linkSync,rmSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeServiceUrl,validateDeploymentCreationRequest,validateDeploymentCreationReceipt,matchesDeploymentCreation,canonicalConfigJson,type DeploymentCreationRequest,type DeploymentCreationReceipt,type FlyMachinesClient,type LogturaServiceClient} from '@logtura/core';
import {createDeploymentLink,readDeploymentLink,deploymentStatus} from './deployment-link';
import {assertConfigDestination,assertNoPendingPush,assertTransactionClear,pendingCreationPath,deploymentLinkPath} from './file-transaction';
import {writePulledConfig} from './pull';
import {withPrivateDirectoryLock} from './private-lock';
export interface PendingDeploymentCreation {
 schemaVersion:1;config:string;service:string;accountId:string;request:DeploymentCreationRequest;
 phase:'prepared'|'dispatched'|'received'|'completed'|'abandoned';receipt:DeploymentCreationReceipt|null;
}
function flush(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function parent(path:string){if(process.platform!=='win32')flush(dirname(path));}
/** Private regular-file reader; never follows a symlink or blocks on a FIFO. */
export function readPendingDeploymentCreation(config:string):PendingDeploymentCreation|null {
 const path=pendingCreationPath(config);let fd:number;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Creation journal must be a private regular file');}
 try{
  const stat=fstatSync(fd);if(!stat.isFile() || stat.size>2_097_152 || (process.platform!=='win32' && (stat.mode&0o077)!==0))throw new Error();
  const p=JSON.parse(readFileSync(fd,'utf8')) as PendingDeploymentCreation;
  if(!p || typeof p!=='object' || Array.isArray(p) || Object.keys(p).length!==7 || Object.keys(p).some(k=>!['schemaVersion','config','service','accountId','request','phase','receipt'].includes(k)) || p.schemaVersion!==1 || p.config!==resolve(config) || normalizeServiceUrl(p.service)!==p.service || typeof p.accountId!=='string' || !p.accountId || !['prepared','dispatched','received','completed','abandoned'].includes(p.phase))throw new Error();
  p.request=validateDeploymentCreationRequest(p.request);
  if(['prepared','dispatched'].includes(p.phase)){if(p.receipt!==null)throw new Error();}
  else{p.receipt=validateDeploymentCreationReceipt(p.receipt);if(p.receipt.status!==(p.phase==='abandoned'?'deleted':'created') || !matchesDeploymentCreation(p.receipt,p.request))throw new Error();}
  return p;
 }catch{throw new Error('Invalid private creation journal; retain it for recovery');}finally{closeSync(fd);}
}
function save(p:PendingDeploymentCreation,initial=false){
 const path=pendingCreationPath(p.config),stage=`${path}.${randomUUID()}.tmp`;
 try{writeFileSync(stage,JSON.stringify(p)+'\n',{flag:'wx',mode:0o600});flush(stage);if(initial)linkSync(stage,path);else renameSync(stage,path);parent(path);}finally{rmSync(stage,{force:true});}
}
function archive(p:PendingDeploymentCreation,kind='created'):string {
 if(canonicalConfigJson(readPendingDeploymentCreation(p.config))!==canonicalConfigJson(p))throw new Error('Creation journal changed before archival');
 const source=pendingCreationPath(p.config),target=resolve(dirname(p.config),`.logtura-${kind}-${p.request.requestId}.json`);
 try{linkSync(source,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST' || !lstatSync(target).isFile() || (process.platform!=='win32' && (lstatSync(target).mode&0o077)!==0) || readFileSync(source,'utf8')!==readFileSync(target,'utf8'))throw error;}
 parent(target);if(canonicalConfigJson(readPendingDeploymentCreation(p.config))!==canonicalConfigJson(p))throw new Error('Creation journal changed before removal');rmSync(source);parent(source);return target;
}
/** Creates a hosted self-managed control-plane record and pulls/links it. It does
 * not deploy paid resources, upload secrets or mutate provider accounts. */
export async function createLinkedDeployment(client:LogturaServiceClient,config:string,options:{request?:Omit<DeploymentCreationRequest,'requestId'>;resume?:boolean;force?:boolean;abandon?:boolean;fly?:FlyMachinesClient}={}):Promise<{deploymentId:string;revision?:string;archive:string;abandoned?:true}> {
 config=resolve(config);assertConfigDestination(config);mkdirSync(dirname(config),{recursive:true,mode:0o700});
 return withPrivateDirectoryLock(resolve(dirname(config),'.logtura-create.lock'),async()=>{
  assertTransactionClear(config);let pending=readPendingDeploymentCreation(config);
  if(options.abandon && (options.resume || options.request || options.force))throw new Error('Choose creation recovery or creation options');
  if(pending && !options.resume && !options.abandon)throw new Error('Pending creation; run logt create --resume');
  if(!pending && (options.resume || options.abandon))throw new Error('No pending creation to recover');
  const user=await client.whoami();
  if(pending && (pending.service!==client.url || pending.accountId!==user.id))throw new Error('Creation account or origin does not match the journal');
  if(!pending){
   if(!options.request)throw new Error('Creation requires a connection and display name');
   assertNoPendingPush(config);
   for(const path of [config,deploymentLinkPath(config),resolve(dirname(config),'.env')]){try{if(!lstatSync(path).isFile())throw new Error('Creation requires regular file destinations');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
   if((existsSync(config) || existsSync(deploymentLinkPath(config))) && !options.force)throw new Error('Configuration exists; choose a new output or pass --force');
   const request=validateDeploymentCreationRequest({...options.request,requestId:randomUUID()});
   if(request.fly){if(!options.fly)throw new Error('Linking an existing Fly machine requires FLY_API_TOKEN');await options.fly.app(request.fly.appName);await options.fly.machine(request.fly.appName,request.fly.machineId);}
   pending={schemaVersion:1,config,service:client.url,accountId:user.id,request,phase:'prepared',receipt:null};save(pending,true);
  }else if(options.request && canonicalConfigJson({...options.request,requestId:pending.request.requestId})!==canonicalConfigJson(pending.request))throw new Error('Creation options conflict with the saved intent');
  const active=pending;
  const assertIntent=()=>{assertNoPendingPush(config,undefined,active.request.requestId);if(canonicalConfigJson(readPendingDeploymentCreation(config))!==canonicalConfigJson(active))throw new Error('Creation journal changed; retain it for recovery');};
  const guard=()=>{assertTransactionClear(config);assertIntent();};
  const transition=(phase:PendingDeploymentCreation['phase'],receipt=active.receipt)=>{guard();const next={...active,phase,receipt};save(next);Object.assign(active,next);};
  guard();
  const receipt=await client.getDeploymentCreation(active.request.requestId);
  guard();
  if(receipt && !matchesDeploymentCreation(receipt,active.request))throw new Error('Creation receipt differs from the saved intent');
  if(options.abandon){if(receipt?.status!=='deleted')throw new Error('Only a verified deleted creation can be abandoned');transition('abandoned',receipt);return {deploymentId:receipt.deployment.id,archive:archive(active,'abandoned-creation'),abandoned:true};}
  if(receipt?.status==='deleted')throw new Error('Created deployment was deleted; run logt create --abandon');
  if(active.receipt && (!receipt || canonicalConfigJson(receipt)!==canonicalConfigJson(active.receipt)))throw new Error('Created deployment receipt changed; retain its journal');
  if(!active.receipt){
   let acknowledged=receipt;
   if(!acknowledged){transition('dispatched');guard();acknowledged=await client.createDeployment(active.request);}
   if(acknowledged.status!=='created')throw new Error('Created deployment was deleted; run logt create --abandon');
   transition('received',acknowledged);
  }
  const accepted=active.receipt!;
  const linked=await readDeploymentLink(config);
  if(!options.force && (active.phase==='completed' || linked?.deployment.id===accepted.deployment.id)){
   const status=await deploymentStatus(config);
   if(!linked || linked.service!==client.url || linked.accountId!==user.id || linked.deployment.id!==accepted.deployment.id || !status.linked || status.changes.length || status.privateChanges.length)throw new Error('Locally committed creation changed; retain its journal');
  }else{
   guard();const exported=await client.pullDeploymentConfig(accepted.deployment.id,true),link=await createDeploymentLink(client.url,user.id,exported);
   guard();await writePulledConfig(exported,config,options.force??false,link,undefined,active.request.requestId,assertIntent);
  }
  transition('completed');const result=await readDeploymentLink(config);if(!result)throw new Error('Created deployment link missing');
  return {deploymentId:accepted.deployment.id,revision:result.revision,archive:archive(active)};
 },'Creation');
}
