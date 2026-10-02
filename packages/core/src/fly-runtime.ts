import { canonicalConfigJson } from "./config";
import { validateFlyMachine, immutableFlyImage, type FlyMachine, type FlyVolume, type FlyMachinePlan, type FlyMachineConfig } from "./fly";
import { verifyLoadedForwarder, type ForwarderRuntimeArtifact } from "./runtime";
import type { GeneratedBundle } from "./types";

export const FLY_RUNTIME_DIRECTORY="/var/lib/logtura";
function record(value:unknown):Record<string,unknown> {if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("Invalid Fly machine settings");return value as Record<string,unknown>;}
function list(value:unknown):Record<string,unknown>[] {if(value===undefined)return [];if(!Array.isArray(value))throw new Error("Invalid Fly machine settings");return value.map(record);}
function base64(content:string|Uint8Array):string {const bytes=typeof content==="string"?new TextEncoder().encode(content):content;let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
/** Exact generated runtime inputs shared by hosted and linked installations. */
export function flyBundleFiles(bundle: GeneratedBundle): {guest_path:string;raw_value:string;mode:number}[] {
  const seen = new Set<string>();
  for (const asset of bundle.runtimeAssets) {
    const path = `${asset.driverId}/${asset.path}`;
    if (!/^[a-zA-Z0-9_-]+$/.test(asset.driverId) || !asset.path || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) || path.split("/").some(part=>part==="" || part==="." || part==="..") || seen.has(path) || (typeof asset.content!=="string" && !(asset.content instanceof Uint8Array)) || (asset.mode!==undefined && (!Number.isSafeInteger(asset.mode) || asset.mode<0 || asset.mode>0o777))) throw new Error("Invalid Fly runtime asset");
    seen.add(path);
  }
  return [{guest_path:"/etc/vector/vector.yaml",raw_value:base64(bundle.vectorYaml),mode:0o400},
    ...bundle.runtimeAssets.map(asset=>({guest_path:`/opt/logtura/assets/${asset.driverId}/${asset.path}`,raw_value:base64(asset.content),mode:asset.mode??0o644}))];
}
/** Checkpoint storage belongs to this one machine. No cross-machine counter sharing.
 * Volume provisioning is an adapter operation and must precede instance issuance. */
export function validateFlyRuntimeVolume(machine:FlyMachine,volumes:FlyVolume[],requested?:string):string {
  const mounts=list(machine.config.mounts),overlaps=mounts.filter(mount=>typeof mount.path!=="string" || !mount.path.startsWith("/") || mount.path==="/" || mount.path===FLY_RUNTIME_DIRECTORY || FLY_RUNTIME_DIRECTORY.startsWith(`${mount.path}/`) || mount.path.startsWith(`${FLY_RUNTIME_DIRECTORY}/`));
  if(overlaps.length>1 || overlaps.some(mount=>mount.path!==FLY_RUNTIME_DIRECTORY || typeof mount.volume!=="string"))throw new Error("Fly checkpoint mount conflicts with existing storage");
  const existing=overlaps[0]?.volume as string|undefined;
  if(requested!==undefined && existing!==undefined && requested!==existing)throw new Error("Fly checkpoint volume conflicts with the existing mount");
  const id=requested??existing;
  if(!id)throw new Error("Linked apply requires --volume with an existing encrypted Fly volume for persistent checkpoints");
  const matches=volumes.filter(volume=>volume.id===id),volume=matches[0];
  if(matches.length!==1 || !volume || !volume.encrypted || volume.state!=="created" || volume.region!==machine.region || (volume.attached_machine_id!==null && volume.attached_machine_id!==machine.id) || mounts.some(mount=>mount.volume===id && mount.path!==FLY_RUNTIME_DIRECTORY))throw new Error("Fly checkpoint volume is unavailable or belongs to another machine");
  return id;
}
/** Public backend operation used by CLI/service adapters. Produces the private
 * provider request, not a claim that the runtime was installed or became ready. */
export async function buildFlyRuntimeConfig(options:{base:FlyMachineConfig;volume:string;image:string;artifact:ForwarderRuntimeArtifact;bundle:GeneratedBundle;environment?:Record<string,string>}):Promise<FlyMachineConfig> {
  const base=structuredClone(options.base),image=immutableFlyImage(options.image),files:Record<string,string|Uint8Array>={"vector.yaml":options.bundle.vectorYaml};
  const environment:Record<string,string>={};
  for(const variable of options.bundle.envVars){const value=variable.value??options.environment?.[variable.name];if(value===undefined || value==="")throw new Error("Fly runtime requires all generated environment values");environment[variable.name]=value;}
  for(const asset of options.bundle.runtimeAssets)files[`assets/${asset.driverId}/${asset.path}`]=asset.content;
  const artifact=await verifyLoadedForwarder(options.artifact,{files,environment,generatorVersion:options.artifact.generatorVersion,vectorVersion:options.artifact.vectorVersion,ready:true});
  // The runtime reader is bounded to 1 MiB; reject before contacting the provider.
  const descriptor=JSON.stringify(artifact);if(new TextEncoder().encode(descriptor).byteLength>1_048_576)throw new Error("Fly runtime artifact exceeds the runtime reader limit");
  if(!/^vol_[a-z0-9]+$/.test(options.volume))throw new Error("Invalid Fly checkpoint volume");
  if(!environment.LOGTURA_HEARTBEAT_TOKEN || artifact.document.heartbeat?.kind!=="logtura" || artifact.document.heartbeat.deploymentId!==artifact.deploymentId || artifact.document.heartbeat.appUrl!==artifact.service)throw new Error("Fly runtime reporting must match the linked deployment");
  if(list(base.containers).length || list(base.processes).length || list(base.volumes).length || (base.standbys!==undefined && (!Array.isArray(base.standbys) || base.standbys.length)) || base.schedule || base.auto_destroy)throw new Error("Linked apply requires one continuously running forwarder process");
  const installed=list(base.files).filter(file=>{if(typeof file.guest_path!=="string")throw new Error("Invalid Fly installed file");return !["/etc/vector/vector.yaml","/etc/vector/logtura-runtime.json"].includes(file.guest_path) && !file.guest_path.startsWith("/opt/logtura/assets/");});
  installed.push(...flyBundleFiles(options.bundle),{guest_path:"/etc/vector/logtura-runtime.json",raw_value:base64(descriptor),mode:0o400});
  const mounts=list(base.mounts);
  for(const mount of mounts) {
    if(typeof mount.path!=="string" || !/^\/(?:[^/\\\x00-\x1f\x7f]+)(?:\/[^/\\\x00-\x1f\x7f]+)*$/.test(mount.path) || mount.path.split("/").some(part=>part==="." || part==="..") || FLY_RUNTIME_DIRECTORY.startsWith(`${mount.path}/`) || mount.path.startsWith(`${FLY_RUNTIME_DIRECTORY}/`) || (mount.path===FLY_RUNTIME_DIRECTORY && mount.volume!==options.volume) || (mount.volume===options.volume && mount.path!==FLY_RUNTIME_DIRECTORY))throw new Error("Fly checkpoint mount conflicts with existing storage");
  }
  if(mounts.filter(mount=>mount.path===FLY_RUNTIME_DIRECTORY).length>1)throw new Error("Fly checkpoint mount conflicts with existing storage");
  if(!mounts.some(mount=>mount.path===FLY_RUNTIME_DIRECTORY))mounts.push({path:FLY_RUNTIME_DIRECTORY,volume:options.volume});
  const previousEnv={...(base.env===undefined?{}:record(base.env))};
  for(const name of ["NODE_OPTIONS","NODE_PATH","LD_PRELOAD","LD_LIBRARY_PATH"]){delete previousEnv[name];if(environment[name]!==undefined)throw new Error("Fly runtime environment overrides a reserved launch setting");}
  for(const [name,value] of Object.entries(environment))if(/^VECTOR_(CONFIG(?:_|$)|WATCH_CONFIG(?:_|$)|LOG(?:_|$)|DISABLE_ENV_VAR_INTERPOLATION$|NO_GRACEFUL_SHUTDOWN_LIMIT$|GRACEFUL_SHUTDOWN_LIMIT_SECS$)/.test(name) && !(name==="VECTOR_LOG" && value==="info"))throw new Error("Fly runtime environment overrides a reserved launch setting");
  const before=structuredClone(base),after={...before,image,env:{...previousEnv,...environment},files:installed,mounts,init:{entrypoint:["/opt/logtura/runtime/entrypoint.sh"],cmd:["--config","/etc/vector/vector.yaml"]},stop_config:{signal:"SIGTERM",timeout:"35s"},restart:{policy:"always"},metadata:{...(before.metadata===undefined?{}:record(before.metadata)),"logtura.instance":artifact.instance.instanceId,"logtura.revision":artifact.instance.revision}};
  canonicalConfigJson(after);return after;
}
/** Plans an update from an actual provider snapshot; creation uses the same
 * configuration builder without inventing a machine identity or version. */
export async function planFlyRuntime(options:{app:string;machine:FlyMachine;volume:string;image:string;artifact:ForwarderRuntimeArtifact;bundle:GeneratedBundle;environment?:Record<string,string>}):Promise<FlyMachinePlan> {
  const machine=validateFlyMachine(options.machine);
  const after=await buildFlyRuntimeConfig({...options,base:machine.config});
  return {app:options.app,machineId:machine.id,version:machine.instance_id,before:structuredClone(machine.config),after};
}
