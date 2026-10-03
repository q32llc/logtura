import {memoryRunLedger,resourceId,targetOrigin,validateRunLedger,type RunLedger,type RunLedgerStore,type ResourceKey} from "./run-ledger";
/** Same black-box protocol against SELF, local workerd or an explicitly selected
 * remote test account. No database access or credentials enter the ledger. */
export interface LifecycleTarget {baseUrl:string;fetch:(request:Request)=>Promise<Response>;sessionCookie:string;expectedUserId:string;runId:string;ledger?:RunLedgerStore;afterCommit?:(state:RunLedger)=>Promise<void>;afterResponse?:(key:ResourceKey)=>Promise<void>;}
function protocol(target:LifecycleTarget){
 const origin=targetOrigin(target.baseUrl);resourceId(target.expectedUserId);
 if(!target.sessionCookie || /[\r\n]/.test(target.sessionCookie))throw new Error("Invalid E2E session credential");
 async function request(path:string,init:RequestInit={},status=200):Promise<any>{
  const headers=new Headers(init.headers);headers.set("cookie",target.sessionCookie);headers.set("origin",origin);
  const response=await target.fetch(new Request(new URL(path,origin),{...init,headers,cache:"no-store",redirect:"manual",credentials:"omit",signal:AbortSignal.timeout(20000)}));
  if(response.status!==status){await response.body?.cancel();throw new Error(`${init.method??"GET"} ${path}: expected ${status}, got ${response.status}`);}
  const reader=response.body?.getReader();if(!reader)throw new Error("Missing E2E response body");const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2097152){await reader.cancel();throw new Error("E2E response exceeds limit");}chunks.push(part.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new Error("Invalid E2E JSON response");}
 }
 async function account(){if((await request("/api/me")).user?.id!==target.expectedUserId)throw new Error("E2E account identity mismatch");}
 async function inventory(){
  const m=await request("/api/monitors"),d=await request("/api/destinations");
  for(const list of [m.monitors,m.sinks,d.destinations]){if(!Array.isArray(list) || list.length>10000 || new Set(list.map(r=>resourceId(r.id))).size!==list.length)throw new Error("Invalid E2E resource inventory");}
  return {monitors:m.monitors as any[],sinks:m.sinks as any[],destinations:d.destinations as any[]};
 }
 return {origin,request,account,inventory};
}
function names(runId:string){const prefix=`e2e-${runId}-`;return {destination:prefix+"webhook",monitor:prefix+"monitor",updated:prefix+"updated"};}
const json=(body:unknown,method="POST"):RequestInit=>({method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const check=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
/** Reconcile only dispatched intentions. Exact names and owned parent references
 * verify receipt identities; ambiguous matches, baseline IDs and renamed resources
 * cannot authorize deletion. Account identity is rechecked before each DELETE. */
export async function cleanupRoutingLifecycle(target:LifecycleTarget):Promise<void>{
 if(!target.ledger)throw new Error("A run ledger is required for cleanup");const store=target.ledger,p=protocol(target);let state=validateRunLedger((await store.read())!);
 if(state.baseUrl!==p.origin || state.userId!==target.expectedUserId || state.runId!==target.runId)throw new Error("E2E ledger target or account mismatch");
 const n=names(state.runId),failures:string[]=[];
 const save=async(next:RunLedger)=>{if(!await store.compareAndSwap(state,next))throw new Error("E2E run ledger changed; retain it for recovery");state=next;await target.afterCommit?.(structuredClone(state));};
 async function find(key:ResourceKey,inventory:Awaited<ReturnType<typeof p.inventory>>){
  const r=state.resources.find(r=>r.key===key)!;if(r.phase==="planned")return null;
  const list=key==="destination"?inventory.destinations:key==="monitor"?inventory.monitors:inventory.sinks;
  const eligible=(item:any)=>key==="destination"?item.displayName===n.destination:key==="monitor"?[n.monitor,n.updated].includes(item.displayName):item.monitorId===state.resources[1]!.id && item.destinationId===state.resources[0]!.id;
  const candidates=r.id===null?[]:list.filter(item=>item.id===r.id);
  if(candidates.length>1)throw new Error("E2E recovery identity is ambiguous");const candidate=candidates[0];
  if(candidate){const baseline=state.baseline[key==="destination"?"destinations":key==="monitor"?"monitors":"sinks"];if(!eligible(candidate) || baseline.includes(candidate.id))throw new Error("E2E resource ownership changed; retain the ledger");if(r.phase==="deleted")throw new Error("Deleted E2E identity reappeared; retain the ledger");}
  return candidate??null;
 }
 await p.account();
 // Fence every dispatched create before accepting absence as proof of cleanup.
 for(const key of ["destination","monitor","sink"] as const){
  const r=state.resources.find(r=>r.key===key)!;if(r.phase==="planned")continue;
  const {receipt}=await p.request(`/api/creation-requests/${r.requestId}?kind=${key}`,{method:"DELETE"});
  check(receipt?.requestId===r.requestId && receipt.kind===key && ["completed","cancelled","deleted"].includes(receipt.status),"Invalid E2E creation receipt");resourceId(receipt.resourceId);
  check(r.id===null || r.id===receipt.resourceId,"E2E receipt identity changed");
  check(receipt.status!=="cancelled" || r.id===null,"E2E cancellation contradicted creation");
  const next=structuredClone(state),resource=next.resources.find(r=>r.key===key)!;
  if(receipt.status==="cancelled")resource.phase="deleted";
  else {resource.id=receipt.resourceId;if(resource.phase==="creating")resource.phase="created";}
  await save(next);
 }
 for(const key of ["sink","monitor","destination"] as const){
  try{
   await p.account();const inventory=await p.inventory(),found=await find(key,inventory),r=state.resources.find(r=>r.key===key)!;if(r.phase==="planned")continue;
   if(found){if(key!=="sink")check(!inventory.sinks.some(s=>key==="monitor"?s.monitorId===found.id:s.destinationId===found.id),"E2E resource still has dependent routing; retain the ledger");const next=structuredClone(state);next.resources.find(r=>r.key===key)!.phase="deleting";await save(next);
    const path=key==="sink"?`/api/sinks/${encodeURIComponent(found.id)}`:`/api/${key==="monitor"?"monitors":"destinations"}/${encodeURIComponent(found.id)}`;
    await p.account();await p.request(path,{method:"DELETE"});check(!await find(key,await p.inventory()),"E2E cleanup did not remove resource");
    await p.request(path,{method:"DELETE"});
   }
   const {receipt}=await p.request(`/api/creation-requests/${r.requestId}?kind=${key}`,{method:"DELETE"});
   check(receipt?.requestId===r.requestId && receipt.kind===key && (r.id===null?receipt.status==="cancelled":receipt.resourceId===r.id && receipt.status==="deleted"),"E2E creation is not durably cancelled or deleted; retain the ledger");
   const next=structuredClone(state);next.resources.find(r=>r.key===key)!.phase="deleted";await save(next);
  }catch{failures.push(key);}
 }
 const after=await p.inventory();for(const key of ["monitors","destinations","sinks"] as const)check(state.baseline[key].every(id=>after[key].some(r=>r.id===id)),"Pre-existing E2E account resource was removed");
 if(failures.length)throw new Error(`E2E cleanup incomplete: ${failures.join(", ")}; retain the ledger`);
 await save({...state,status:"cleaned"});
}
export async function runRoutingLifecycle(target:LifecycleTarget):Promise<void>{
 if(!/^[a-zA-Z0-9_-]{8,80}$/.test(target.runId))throw new Error("Invalid E2E run ID");const store=target.ledger??memoryRunLedger(),p=protocol(target),n=names(target.runId);
 if(await store.read())throw new Error("E2E ledger already exists; use cleanup instead of rerunning creation");await p.account();
 check((await p.request("/api/creation-requests")).protocolVersion===1,"E2E target lacks durable creation fencing");
 const connections=await p.request("/api/connections"),deployments=await p.request("/api/deployments");
 check(Array.isArray(connections.connections) && connections.connections.length===0 && Array.isArray(deployments.deployments) && deployments.deployments.length===0,"Routing E2E requires a disposable account without connections or deployments");
 const baseline=await p.inventory();
 check(!baseline.monitors.some(r=>[n.monitor,n.updated].includes(r.displayName)) && !baseline.destinations.some(r=>r.displayName===n.destination),"E2E intent names already exist");
 let state:RunLedger={schemaVersion:1,baseUrl:p.origin,userId:target.expectedUserId,runId:target.runId,status:"active",baseline:{monitors:baseline.monitors.map(r=>r.id),destinations:baseline.destinations.map(r=>r.id),sinks:baseline.sinks.map(r=>r.id)},resources:(["destination","monitor","sink"] as const).map(key=>({key,requestId:crypto.randomUUID(),id:null,phase:"planned"}))};
 const save=async(next:RunLedger)=>{if(!await store.compareAndSwap(state,next))throw new Error("E2E run ledger changed; retain it for recovery");state=next;await target.afterCommit?.(structuredClone(state));};
 if(!await store.compareAndSwap(null,state))throw new Error("E2E ledger already exists; use cleanup");await target.afterCommit?.(structuredClone(state));let failure:unknown;
 async function create(key:ResourceKey,path:string,init:RequestInit){
  const next=structuredClone(state);next.resources.find(r=>r.key===key)!.phase="creating";await save(next);const headers=new Headers(init.headers);headers.set("X-Logtura-Request-Id",next.resources.find(r=>r.key===key)!.requestId);const result=await p.request(path,{...init,headers});await target.afterResponse?.(key);
  const object=result[key];resourceId(object?.id);check(key==="destination"?object.displayName===n.destination:key==="monitor"?object.displayName===n.monitor:object.monitorId===state.resources[1]!.id && object.destinationId===state.resources[0]!.id,"E2E creation response identity changed");const saved=structuredClone(state),resource=saved.resources.find(r=>r.key===key)!;resource.id=object.id;resource.phase="created";await save(saved);return object;
 }
 try{
  await p.request("/api/monitors",json({}),400);await p.request("/api/monitors/missing-e2e-monitor",json({displayName:n.monitor},"PUT"),404);
  const form=new FormData();form.set("kind","webhook");form.set("display_name",n.destination);form.set("url","https://example.invalid/logtura-e2e");const destination=await create("destination","/api/destinations",{method:"POST",body:form});check(destination.displayName===n.destination,"E2E destination name changed");
  const monitor=await create("monitor","/api/monitors",json({displayName:n.monitor,filterSteps:[{kind:"errors"}]}));check(monitor.displayName===n.monitor,"E2E monitor name changed");
  check((await p.inventory()).monitors.some(r=>r.id===monitor.id),"Created E2E monitor is missing");
  const sink=await create("sink",`/api/monitors/${encodeURIComponent(monitor.id)}/sinks`,json({destinationId:destination.id,filterSteps:[]}));
  await p.request(`/api/sinks/${encodeURIComponent(sink.id)}`,json({filterSteps:[{kind:"errors"}]},"PUT"));
  const updated=await p.request(`/api/monitors/${encodeURIComponent(monitor.id)}`,json({displayName:n.updated,enabled:false},"PUT"));check(updated.monitor.displayName===n.updated && updated.monitor.enabled===false,"E2E monitor update was not persisted");
 }catch(error){failure=error;}
 try{await cleanupRoutingLifecycle({...target,ledger:store});}catch{throw new Error("E2E cleanup incomplete; retain the run ledger",{cause:failure});}if(failure)throw failure;
}
