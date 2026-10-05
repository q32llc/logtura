import {expect,it} from "vitest";
import {createServer} from "node:http";
import {mkdtempSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {exportDeploymentManifest,createSecretVersioner,hashConfigDocument,type FlyMachine,type DeploymentInstanceReceipt} from "@logtura/core";
import {createDeploymentLink} from "../src/deployment-link";
import {writePulledConfig} from "../src/pull";
import {pendingFlyApplyPath} from "../src/file-transaction";
import {image,indexImage,platformDigest,registryBody} from "./oci-fixture";
for(const boundary of ["intent-file","intent-parent","activation-cleared","archive-parent"]){
 it(`recovers a compiled CLI killed after ${boundary} fsync over real HTTP`,async()=>{
  const root=mkdtempSync(join(tmpdir(),"logt-apply-crash-")),config=join(root,"logt.yaml");let service="",revision="",document:unknown,exportedConfig:any,binding:any=null,receipt:DeploymentInstanceReceipt|null=null,updates=0,issuances=0;
  let machine:FlyMachine={id:"abc123",instance_id:"version1",state:"started",region:"ord",config:{image:"registry.test/old:latest",env:{ORIGINAL:"private-before"},mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}]},image_ref:{registry:"registry.test",repository:"old",digest:`sha256:${"b".repeat(64)}`}};
  const server=createServer(async(request,response)=>{
   try{
    let body="";for await(const part of request)body+=part;const path=new URL(request.url!,service).pathname;let result:unknown;
    if(path.startsWith("/registry/")){
     expect(request.headers.authorization).toBeUndefined();const content=registryBody(path.slice("/registry".length));expect(content).not.toBeNull();response.writeHead(200,{"content-type":"application/json"});response.end(content);return;
    }else if(path.startsWith("/fly/")){
     if(path.endsWith("/lease"))result=request.method==="DELETE"?null:{data:{nonce:"lease-private"}};
     else if(path.endsWith("/stop")){expect(existsSync(pendingFlyApplyPath(config))).toBe(true);machine.state="stopped";result=null;}
     else if(path.endsWith("/start")){machine.state="started";result=null;}
     else if(request.method==="POST"){
      expect(existsSync(pendingFlyApplyPath(config))).toBe(true);const intent=JSON.parse(readFileSync(pendingFlyApplyPath(config),"utf8")),input=JSON.parse(body);expect(input.config).toEqual(intent.plan.after);expect(input.current_version).toBe("version1");expect(request.headers["fly-machine-lease-nonce"]).toBe("lease-private");updates++;
      expect(input.skip_launch).toBe(true);expect(machine.state).toBe("stopped");machine={...machine,config:input.config,instance_id:"version2",image_ref:{registry:"registry.test",repository:"forwarder",digest:platformDigest}};result=machine;
     }else if(path.endsWith("/machines"))result=[machine];
     else if(path.endsWith("/volumes"))result=[{id:"vol_checkpoint",region:"ord",state:"created",encrypted:true,attached_machine_id:machine.id}];
     else if(path.endsWith("/abc123"))result=machine;
     else result={name:"app",organization:{slug:"personal"}};
    }else if(path.endsWith("/me"))result={user:{id:"usr_site",githubLogin:"site"}};
    else if(path.endsWith("/state"))result={state:{desired:{sequence:1,revision,document,configurationVersion:3},activeInstanceId:receipt?.instanceId??null,lastReportSequence:updates?1:0,stale:false,applied:updates?{sequence:1,revision,at:Date.now()}:null}};
    else if(path.endsWith("/fly-capabilities"))result={schemaVersion:1,features:["replacement","image-update"]};
    else if(path.endsWith("/fly-binding"))result={binding:null};
    else if(path.endsWith("/fly-bindings") && request.method==="POST"){binding={request:JSON.parse(body),configurationVersion:3};result=binding;}
    else if(path.includes("/fly-bindings/")){
     if(binding)result=binding;else{response.writeHead(404,{"content-type":"application/json"});response.end(JSON.stringify({error:"receipt_not_found"}));return;}
    }
    else if(path.endsWith("/config"))result={...exportedConfig,target:{...exportedConfig.target,imageDigest:platformDigest}};
    else if(request.method==="POST"){issuances++;const input=JSON.parse(body);receipt={requestId:input.requestId,instanceId:randomUUID(),sequence:1,configurationVersion:3,revision};result=receipt;}
    else if(receipt)result=receipt;
    else{response.writeHead(404,{"content-type":"application/json"});response.end(JSON.stringify({error:"receipt_not_found"}));return;}
    response.writeHead(result===null?204:200,{"content-type":"application/json"});response.end(result===null?undefined:JSON.stringify(result));
   }catch{response.writeHead(503);response.end();}
  });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));service=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
   const exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[{connection:{id:"con_site",provider:"cloudflare-worker-tail",displayName:"Site",externalAccountId:"account"},credentials:{apiToken:"private-source-token"},selectedSources:[]}],monitors:[],heartbeat:{kind:"logtura",deploymentId:"dep_site",appUrl:service},runtimeEnv:{LOGTURA_HEARTBEAT_TOKEN:"private-report-token"}},await createSecretVersioner("fixture"));document=exported.document;revision=await hashConfigDocument(document);
   const result={...exported,revision,configurationVersion:3,desiredSequence:1,deployment:{id:"dep_site",displayName:"Site"},target:{kind:"fly" as const,managed:false,imageDigest:null,fly:{appName:"app",machineId:"abc123",region:"ord",orgSlug:"personal"}}};exportedConfig=result;await writePulledConfig(result,config,false,await createDeploymentLink(service,"usr_site",result));
   const compiled=pathToFileURL(join(process.cwd(),"packages/cli/dist/main.js")).href;
   async function child(resume:boolean):Promise<{code:number|null;signal:string|null;stderr:string;stdout:string}>{
    const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const nativeFetch=fetch;globalThis.fetch=(input,init)=>{const url=String(input);return nativeFetch(url.startsWith('https://api.machines.dev/')?${JSON.stringify(service+"/fly/")}+url.slice('https://api.machines.dev/'.length):url.startsWith('https://registry.test/')?${JSON.stringify(service+"/registry/")}+url.slice('https://registry.test/'.length):input,init)};
      const {main}=await import(${JSON.stringify(compiled)});const original=fs.fsyncSync;
      fs.fsyncSync=(fd)=>{original(fd);if(${!resume}){const path=fs.readlinkSync('/proc/self/fd/'+fd),active=fs.existsSync(${JSON.stringify(pendingFlyApplyPath(config))}),activation=fs.existsSync(${JSON.stringify(join(root,".logtura-activation.json"))}),archive=fs.readdirSync(${JSON.stringify(root)}).some(name=>name.startsWith('.logtura-applied-'));
        if(${JSON.stringify(boundary)}==='intent-file' && path.includes('.logtura-apply.json.') && path.endsWith('.tmp') || path===${JSON.stringify(root)} && (${JSON.stringify(boundary)}==='intent-parent' && active && activation || ${JSON.stringify(boundary)}==='activation-cleared' && active && !activation && !archive || ${JSON.stringify(boundary)}==='archive-parent' && active && archive))process.kill(process.pid,'SIGKILL');}};syncBuiltinESMExports();
      process.exitCode=await main(${JSON.stringify(["-c",config,"deploy","fly","--image",indexImage,"--volume","vol_checkpoint","--wait-seconds","1","--json",...(resume?["--resume"]:[])])});`;
    const processChild=spawn(process.execPath,["--input-type=module","-e",script],{env:{...process.env,LOGT_AUTH_FILE:join(root,"missing-profile"),LOGT_SERVICE_TOKEN:`lt_cli_${"a".repeat(43)}`,LOGT_SERVICE_URL:service,LOGT_REGISTRY_TOKEN:"",FLY_API_TOKEN:"private-fly-token"},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";processChild.stdout.on("data",chunk=>stdout+=chunk);processChild.stderr.on("data",chunk=>stderr+=chunk);
    return new Promise((done,reject)=>{const timer=setTimeout(()=>{processChild.kill("SIGKILL");reject(new Error("Compiled apply fixture timed out"));},10_000);processChild.on("error",error=>{clearTimeout(timer);reject(error);});processChild.on("close",(code,signal)=>{clearTimeout(timer);done({code,signal,stderr,stdout});});});
   }
   const killed=await child(false);expect(killed.signal,killed.stderr).toBe("SIGKILL");expect(issuances).toBe(1);expect(updates).toBe(["intent-file","intent-parent"].includes(boundary)?0:1);
   const saved=existsSync(pendingFlyApplyPath(config))?JSON.parse(readFileSync(pendingFlyApplyPath(config),"utf8")):null;
   const resumed=await child(true);expect(resumed.code,resumed.stderr).toBe(0);expect(resumed.signal).toBeNull();const applied=JSON.parse(resumed.stdout);expect(applied.image).toBe(image);expect(applied.instanceId).toBe(receipt!.instanceId);expect(issuances).toBe(1);expect(updates).toBe(1);expect(existsSync(pendingFlyApplyPath(config))).toBe(false);
   const archive=JSON.parse(readFileSync(applied.rollbackFile,"utf8"));if(saved)expect(archive).toMatchObject(saved);expect(archive.rollback.image).toBe(`registry.test/old@sha256:${"b".repeat(64)}`);expect(resumed.stdout+resumed.stderr).not.toMatch(/private-before|private-report-token|private-source-token|private-fly-token/);
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true});}
 },15_000);
}
