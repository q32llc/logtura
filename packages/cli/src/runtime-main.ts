import { constants,openSync,readFileSync,closeSync,fstatSync,mkdirSync } from "node:fs";
import { dirname,resolve,join } from "node:path";
import { validateForwarderRuntimeArtifact,DeploymentReportingClient } from "@logtura/core";
import { runForwarderProcess } from "./runtime-process";

export async function forwarderRuntimeMain(argv=process.argv.slice(2)):Promise<number>{
 try{
  if(argv.length===1 && ["--help","-h"].includes(argv[0]!)){console.log("logt-forwarder --artifact <private.json> [--checkpoint <file>] [--config-directory <dir>] [--vector <binary>] [--interval-ms <n>] [--retry-ms <n>]");return 0;}
  const flags:Record<string,string>={};
  for(let i=0;i<argv.length;i+=2){const flag=argv[i],value=argv[i+1];if(!flag || !["--artifact","--checkpoint","--config-directory","--vector","--interval-ms","--retry-ms"].includes(flag) || !value || value.startsWith("--") || Object.hasOwn(flags,flag))throw new Error("Invalid forwarder runtime arguments");flags[flag]=value;}
  if(!flags["--artifact"])throw new Error("Forwarder runtime requires a private artifact file");
  const artifactPath=resolve(flags["--artifact"]),fd=openSync(artifactPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let value:unknown;
  try{const stat=fstatSync(fd);if(!stat.isFile() || stat.size>1_048_576)throw new Error("Invalid private forwarder artifact file");try{value=JSON.parse(readFileSync(fd,"utf8"));}catch{throw new Error("Invalid private forwarder artifact file");}}finally{closeSync(fd);}
  const artifact=await validateForwarderRuntimeArtifact(value),reporting=new DeploymentReportingClient({url:artifact.service,token:process.env.LOGTURA_HEARTBEAT_TOKEN??"",fetch});
  const checkpoint=resolve(flags["--checkpoint"]??join("/var/lib/logtura/reports",`${artifact.instance.instanceId}.json`));mkdirSync(dirname(checkpoint),{recursive:true,mode:0o700});
  const stop=new AbortController(),shutdown=()=>stop.abort();process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
  try{await runForwarderProcess({artifact,checkpoint,configDirectory:flags["--config-directory"]??dirname(artifactPath),vector:flags["--vector"],signal:stop.signal,intervalMs:flags["--interval-ms"]===undefined?undefined:Number(flags["--interval-ms"]),retryMs:flags["--retry-ms"]===undefined?undefined:Number(flags["--retry-ms"]),report:value=>reporting.reportApplied(artifact.deploymentId,value),diagnostics:chunk=>process.stderr.write(chunk),onResult:result=>console.log(JSON.stringify({event:"applied_report",...result}))});}finally{process.off("SIGTERM",shutdown);process.off("SIGINT",shutdown);}
  return 0;
 }catch{console.error("Forwarder runtime failed; retain private state for recovery");return 1;}
}
