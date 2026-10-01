import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { createSecretVersioner, diffDeploymentManifests, editDeploymentManifest, exportDeploymentManifest, hashConfigDocument, parseDeploymentManifest, type DeploymentManifest, type ManifestEdit } from "@logtura/core";
import { loadConfigFile, readConfigDoc, readConfigEnvironment } from "./config";
import { writePulledConfig } from "./pull";
import { accountClient } from "./account";

function readPrivateJson(path:string):unknown{
  const content=readFileSync(path,"utf8");try{return JSON.parse(content);}catch{throw new Error("Invalid JSON input file");}
}
function graph(path:string):DeploymentManifest{
  const document=readConfigDoc(path);
  if(document.kind!=="logtura.deployment")throw new Error("This command requires a portable deployment graph; run logt config export first");
  return document as unknown as DeploymentManifest;
}
async function save(result:{document:DeploymentManifest;secretValues:Record<string,string>},path:string,force:boolean):Promise<string>{
  const revision=await hashConfigDocument(result.document);
  await writePulledConfig({...result,revision,deployment:{id:"local",displayName:"Local configuration"}},path,force);
  return revision;
}
export async function editGraphFile(path:string,edits:ManifestEdit[]):Promise<string>{
  const result=await editDeploymentManifest(graph(path),readConfigEnvironment(path),edits,await createSecretVersioner(randomUUID()));
  return save(result,path,true);
}
export async function applyGraphEditFile(path:string,editFile:string):Promise<string>{
  const edits=readPrivateJson(editFile);
  if(!Array.isArray(edits))throw new Error("Edit file must contain a JSON array of operations");
  return editGraphFile(path,edits);
}
export async function exportGraphFile(path:string,output:string,force=false):Promise<string>{
  const parsed=loadConfigFile(path);if(parsed.missingEnv.length)throw new Error("Configuration export requires all referenced environment values");
  const document=readConfigDoc(path);const versioner=await createSecretVersioner(randomUUID());
  const result=document.kind==="logtura.deployment"?await editDeploymentManifest(document as unknown as DeploymentManifest,readConfigEnvironment(path),[],versioner):await exportDeploymentManifest(parsed.input,versioner);
  return save(result,output,force);
}
export async function diffGraphFiles(path:string,baseline:string){
  return diffDeploymentManifests(parseYaml(readFileSync(baseline,"utf8")) as DeploymentManifest,graph(path));
}
export async function diffRemoteGraph(path:string,deploymentId:string,service?:string){
  const remote=await accountClient(service).pullDeploymentConfig(deploymentId);
  return diffDeploymentManifests(remote.document,graph(path));
}
export async function selectGraphSource(path:string,connectionId:string,externalId:string,options:{kind?:string;name?:string;metadataFile?:string;id?:string}={}):Promise<string>{
  const doc=graph(path);const input=parseDeploymentManifest(doc).input;
  const connection=input.connections.find(c=>c.connection.id===connectionId);if(!connection)throw new Error("Connection not found in graph");
  const kinds=[...new Set(connection.selectedSources.map(s=>s.sourceKind))];const kind=options.kind??(kinds.length===1?kinds[0]:undefined);
  if(!kind)throw new Error("Source kind is ambiguous; pass --kind");
  const existing=connection.selectedSources.find(s=>s.externalId===externalId && s.sourceKind===kind);
  const value=options.metadataFile===undefined?undefined:readPrivateJson(options.metadataFile);
  if(value!==undefined && value!==null && (typeof value!=="object" || Array.isArray(value)))throw new Error("Source metadata must be a JSON object or null");
  const metadata=value as Record<string,unknown>|null|undefined;
  if(existing){
    if(options.id!==undefined && options.id!==existing.id)throw new Error("Existing selection keeps its identity");
    return editGraphFile(path,[{kind:"source.update",id:existing.id,patch:{...(options.name===undefined?{}:{displayName:options.name}),...(metadata===undefined?{}:{metadata})}}]);
  }
  return editGraphFile(path,[{kind:"source.add",connectionId,source:{id:options.id??`src_${randomUUID().replaceAll("-","")}`,externalId,displayName:options.name??externalId,sourceKind:kind,metadata:metadata??null}}]);
}
