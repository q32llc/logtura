export type ResourceKey="destination"|"monitor"|"sink";
export interface RunResource {key:ResourceKey;requestId:string;id:string|null;phase:"planned"|"creating"|"created"|"deleting"|"deleted";}
export interface RunLedger {schemaVersion:1;baseUrl:string;userId:string;runId:string;status:"active"|"cleaned";baseline:{monitors:string[];destinations:string[];sinks:string[]};resources:RunResource[];}
export interface RunLedgerStore {read():Promise<RunLedger|null>;compareAndSwap(expected:RunLedger|null,next:RunLedger):Promise<boolean>;}
const idPattern=/^[a-zA-Z0-9_-]{1,128}$/;
export function resourceId(value:unknown):string {if(typeof value!=="string" || !idPattern.test(value))throw new Error("Invalid E2E resource identity");return value;}
export function targetOrigin(value:string):string {
 const url=new URL(value);if(!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname!=="/")throw new Error("E2E target must be a plain HTTP origin");return url.origin;
}
export function validateRunLedger(value:RunLedger):RunLedger {
 try{
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==7 || value.schemaVersion!==1 || targetOrigin(value.baseUrl)!==value.baseUrl || (typeof value.runId!=="string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(value.runId)) || !["active","cleaned"].includes(value.status))throw new Error();resourceId(value.userId);
  if(!value.baseline || Object.keys(value.baseline).length!==3)throw new Error();for(const key of ["monitors","destinations","sinks"] as const){const ids=value.baseline[key];if(!Array.isArray(ids) || ids.length>10000 || new Set(ids).size!==ids.length)throw new Error();ids.forEach(resourceId);}
  if(!Array.isArray(value.resources) || value.resources.length!==3 || value.resources.map(r=>r.key).join(",")!=="destination,monitor,sink")throw new Error();
  for(const r of value.resources){if(!r || Object.keys(r).length!==4 || (typeof r.requestId!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.requestId)) || !["planned","creating","created","deleting","deleted"].includes(r.phase) || r.id!==null && (typeof r.id!=="string" || !idPattern.test(r.id)) || r.phase==="planned" && r.id!==null || ["created","deleting"].includes(r.phase) && r.id===null || value.baseline[r.key==="destination"?"destinations":r.key==="monitor"?"monitors":"sinks"].includes(r.id??""))throw new Error();}
  if(new Set(value.resources.map(r=>r.requestId)).size!==3)throw new Error();
  if(value.status==="cleaned" && value.resources.some(r=>!["planned","deleted"].includes(r.phase)))throw new Error();return structuredClone(value);
 }catch{throw new Error("Invalid E2E run ledger; retain it for recovery");}
}
export function memoryRunLedger():RunLedgerStore {
 let state:RunLedger|null=null;return {read:async()=>state?structuredClone(state):null,compareAndSwap:async(expected,next)=>{if(JSON.stringify(expected)!==JSON.stringify(state))return false;state=validateRunLedger(next);return true;}};
}
