import {SELF} from "cloudflare:test";
import {expect} from "vitest";
import {reportLoadedForwarder,type FlyMachineConfig,type ForwarderRuntimeArtifact,type ForwarderReportCheckpoint} from "@logtura/core";

/** Verifies provider fixture bytes, then sends the public reporter's body to
 * the actual workerd API. This is not proof of a running Vector process. */
export async function acceptManagedRuntimeReport(runtime:ForwarderRuntimeArtifact,config:FlyMachineConfig,token:string){
 const files:Record<string,Uint8Array>={};
 for(const file of config.files as Array<{guest_path:string;raw_value:string}>){
  const name=file.guest_path==="/etc/vector/vector.yaml"?"vector.yaml":file.guest_path.startsWith("/opt/logtura/assets/")?`assets/${file.guest_path.slice(20)}`:null;
  if(name!==null)files[name]=Uint8Array.from(atob(file.raw_value),c=>c.charCodeAt(0));
 }
 let checkpoint:ForwarderReportCheckpoint|null=null;
 return reportLoadedForwarder({artifact:runtime,observed:{files,environment:config.env as Record<string,string>,generatorVersion:runtime.generatorVersion,vectorVersion:runtime.vectorVersion,ready:true},store:{load:async()=>checkpoint,save:async value=>{checkpoint=value;}},report:async body=>{
  const response=await SELF.fetch(`${runtime.service}/api/applied/${runtime.deploymentId}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
  expect(response.status).toBe(200);return (await response.json() as {accepted:boolean}).accepted;
 }});
}
