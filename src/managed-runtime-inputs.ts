import {canonicalConfigJson,validateForwarderRuntimeArtifact,verifyLoadedForwarder,type FlyMachineConfig,type ForwarderRuntimeArtifact} from "@logtura/core";
/** Reconstruct the exact private provider inputs from durable ciphertext. */
export async function validateManagedRuntime(config:FlyMachineConfig,deploymentId:string,configurationVersion:number):Promise<ForwarderRuntimeArtifact>{
 if(!Array.isArray(config.files))throw new Error("Invalid managed runtime files");
 const files:Record<string,Uint8Array>={};let descriptor:string|undefined;
 for(const file of config.files){
  if(!file || typeof file.guest_path!=="string" || typeof file.raw_value!=="string")throw new Error("Invalid managed runtime file");
  const name=file.guest_path==="/etc/vector/vector.yaml"?"vector.yaml":file.guest_path.startsWith("/opt/logtura/assets/")?`assets/${file.guest_path.slice(20)}`:null;
  if(name!==null || file.guest_path==="/etc/vector/logtura-runtime.json"){
   const bytes=Uint8Array.from(atob(file.raw_value),character=>character.charCodeAt(0));
   if(name!==null){if(Object.hasOwn(files,name))throw new Error("Duplicate managed runtime file");files[name]=bytes;}
   else {if(descriptor!==undefined || bytes.byteLength>1_048_576)throw new Error("Invalid managed runtime descriptor");descriptor=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
  }
 }
 if(descriptor===undefined)throw new Error("Managed runtime descriptor missing");
 const artifact=await validateForwarderRuntimeArtifact(JSON.parse(descriptor));
 const metadata=config.metadata as Record<string,unknown>|undefined;
 if(artifact.deploymentId!==deploymentId || artifact.instance.configurationVersion!==configurationVersion || metadata?.["logtura.instance"]!==artifact.instance.instanceId || metadata?.["logtura.revision"]!==artifact.instance.revision || canonicalConfigJson(config.init)!==canonicalConfigJson({entrypoint:["/opt/logtura/runtime/entrypoint.sh"],cmd:["--config","/etc/vector/vector.yaml"]}))throw new Error("Managed runtime identity or launch differs from the issued artifact");
 return verifyLoadedForwarder(artifact,{files,environment:config.env as Record<string,string>,generatorVersion:artifact.generatorVersion,vectorVersion:artifact.vectorVersion,ready:true});
}
