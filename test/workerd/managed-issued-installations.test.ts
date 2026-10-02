import {env} from "cloudflare:test";
import {expect,it} from "vitest";
import {FlyMachinesClient,type FlyMachineConfig} from "@logtura/core";
import {activateDeploymentInstance} from "../../src/deployment-configuration";
import {readDeploymentInstanceReceipt} from "../../src/deployment-instances";
import {prepareIssuedManagedInstall,bindInstalledManagedRuntime} from "../../src/managed-issued-installations";
import {prepareManagedInstall,readManagedInstall,executeManagedInstall} from "../../src/managed-installations";
import {validateManagedRuntime} from "../../src/managed-runtime-inputs";
import {mockFetch} from "./_setup";
import {managedIssuedFixture as fixture} from "./_managed-issued-fixture";
const image=`registry.test/forwarder@sha256:${"a".repeat(64)}`;

it("atomically activates a server instance, persists its receipt and encrypts the exact issued provider config",async()=>{
 const f=await fixture(),install=await f.prepare(),runtime=install.runtime!;expect(install.payload.schemaVersion).toBe(2);expect(await f.state()).toMatchObject({activeInstanceId:runtime.instance.instanceId,lastReportSequence:0,stale:false});
 expect(await readDeploymentInstanceReceipt(env.DB,f.userId,f.deployment.id,runtime.instance.requestId)).toEqual(runtime.instance);expect(install.payload.after).toMatchObject({image,mounts:[{path:"/var/lib/logtura",volume:"vol_checkpoint"}],stop_config:{signal:"SIGTERM",timeout:"35s"}});
 const cipher=await env.DB.prepare("SELECT CAST(payload_encrypted AS TEXT) AS payload FROM managed_installations WHERE id=?").bind(install.id).first<string>("payload");expect(cipher).not.toContain("private-source-token");expect(cipher).not.toContain(runtime.privateKey);
 expect((await f.prepare()).id).toBe(install.id);expect((await readManagedInstall(env,f.userId,f.deployment.id))!.runtime).toEqual(runtime);
 let created=false;mockFetch("https://api.machines.dev/",async req=>{
  const machine={id:"machine1",name:"forwarder",instance_id:"version1",state:"started",region:"ord",config:install.payload.after,image_ref:{registry:"registry.test",repository:"forwarder",digest:image.split("@")[1]}};
  if(new URL(req.url).pathname==="/v1/apps/app")return Response.json({name:"app",organization:{slug:"personal"}});
  if(req.method==="POST"){created=true;expect((await req.json() as {config:unknown}).config).toEqual(install.payload.after);return Response.json(machine);}return Response.json(created?[machine]:[]);
 });
 expect(await executeManagedInstall(env,install,new FlyMachinesClient({token:"private"}),new AbortController().signal)).toBe("machine1");
 const bound=await bindInstalledManagedRuntime(env,f.userId,f.deployment.id,install.id);expect(bound).toBe(f.version+1);expect(await f.state()).toMatchObject({stale:false,desired:{configurationVersion:bound,sequence:runtime.instance.sequence,revision:runtime.instance.revision}});
 expect(await readDeploymentInstanceReceipt(env.DB,f.userId,f.deployment.id,runtime.instance.requestId)).toEqual(runtime.instance);expect((await readManagedInstall(env,f.userId,f.deployment.id))!.runtime).toEqual(runtime);
 expect(await executeManagedInstall(env,install,new FlyMachinesClient({token:"private"}),new AbortController().signal)).toBe("machine1");expect(await bindInstalledManagedRuntime(env,f.userId,f.deployment.id,install.id)).toBe(bound);
});
it("rolls activation and receipt back when durable installation insertion fails",async()=>{
 const f=await fixture(),name=`fail_issued_${f.userId.replaceAll("-","")}`;
 await env.DB.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON managed_installations WHEN NEW.deployment_id='${f.deployment.id}' BEGIN SELECT RAISE(ABORT,'fixture_journal_write_failed'); END;`);
 try {await expect(f.prepare()).rejects.toThrow("fixture_journal_write_failed");expect(await f.state()).toMatchObject({activeInstanceId:null});expect(await env.DB.prepare("SELECT COUNT(*) FROM deployment_instance_receipts WHERE deployment_id=?").bind(f.deployment.id).first("COUNT(*)")).toBe(0);expect(await readManagedInstall(env,f.userId,f.deployment.id)).toBeNull();}
 finally {await env.DB.exec(`DROP TRIGGER ${name}`);}
 expect((await f.prepare()).runtime).toBeTruthy();
});
it("deduplicates concurrent issuance without leaving a superseded receipt or provider intent",async()=>{
 const f=await fixture(),installs=await Promise.all([f.prepare(),f.prepare()]);expect(installs[0]!.id).toBe(installs[1]!.id);expect(installs[0]!.runtime!.instance).toEqual(installs[1]!.runtime!.instance);
 expect(await env.DB.prepare("SELECT COUNT(*) FROM deployment_instance_receipts WHERE deployment_id=?").bind(f.deployment.id).first("COUNT(*)")).toBe(1);
});
it("refuses missing, stale and mismatched desired revisions before activation",async()=>{
 const absent=await fixture(false);await expect(absent.prepare()).rejects.toThrow("desired revision");
 const f=await fixture();await expect(prepareIssuedManagedInstall(env,{...f.input,document:{...f.input.document,monitors:[]},configurationVersion:f.version+1})).rejects.toThrow("desired revision");
 await env.DB.prepare("UPDATE deployments SET display_name='Changed' WHERE id=?").bind(f.deployment.id).run();await expect(f.prepare()).rejects.toThrow("desired revision");expect(await f.state()).toMatchObject({activeInstanceId:null});
 await expect(prepareIssuedManagedInstall(env,{...f.input,userId:"unowned"})).rejects.toThrow("Managed deployment not found");
});
it("retains conflicting legacy or different-target intent rather than replacing it",async()=>{
 const legacy=await fixture();await prepareManagedInstall(env,{...legacy.input,config:{image}});await expect(legacy.prepare()).rejects.toThrow("conflicts");
 const f=await fixture();await f.prepare();for(const change of [{app:"other"},{org:"other"},{region:"iad"}])await expect(prepareIssuedManagedInstall(env,{...f.input,...change})).rejects.toThrow("conflicts");
});
it("refuses dispatch after the issued instance or graph is superseded",async()=>{
 const f=await fixture(),install=await f.prepare(),client=new FlyMachinesClient({token:"private"});await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,f.version,install.runtime!.instance.instanceId);await expect(executeManagedInstall(env,install,client,new AbortController().signal)).rejects.toThrow("issued instance changed");
 const changed=await fixture(),old=await changed.prepare();await env.DB.prepare("UPDATE deployments SET display_name='Changed' WHERE id=?").bind(changed.deployment.id).run();await expect(executeManagedInstall(env,old,client,new AbortController().signal)).rejects.toThrow("issued instance changed");
});
it("validates the durable provider files, descriptor, identity, launch and private environment",async()=>{
 const f=await fixture(),install=await f.prepare(),config=install.payload.after,files=config.files as Array<{guest_path:string;raw_value:string}>;
 expect(await validateManagedRuntime({...config,files:[...files,{guest_path:"/etc/unrelated",raw_value:"a2VlcA=="}]},f.deployment.id,f.version)).toEqual(install.runtime);
 for(const changed of [{...config,files:null},{...config,files:[null]},{...config,files:[{guest_path:"bad"}]},{...config,files:files.filter(file=>file.guest_path!=="/etc/vector/logtura-runtime.json")},{...config,files:[...files,files.find(file=>file.guest_path==="/etc/vector/logtura-runtime.json")]},{...config,files:[...files,files.find(file=>file.guest_path==="/etc/vector/vector.yaml")]},{...config,metadata:{}},{...config,init:{cmd:["vector"]}},{...config,env:{}},{...config,files:files.map(file=>file.guest_path==="/etc/vector/vector.yaml"?{...file,raw_value:btoa("changed")}:file)}])await expect(validateManagedRuntime(changed as FlyMachineConfig,f.deployment.id,f.version)).rejects.toThrow();
 await expect(validateManagedRuntime(config,"foreign",f.version)).rejects.toThrow("identity");await expect(validateManagedRuntime(config,f.deployment.id,f.version+1)).rejects.toThrow("identity");
});
it("refuses target binding for uninstalled, unowned or superseded issued intent",async()=>{
 const f=await fixture(),install=await f.prepare();await expect(bindInstalledManagedRuntime(env,f.userId,f.deployment.id,install.id)).rejects.toThrow("not installed");await expect(bindInstalledManagedRuntime(env,"unowned",f.deployment.id,install.id)).rejects.toThrow("not installed");
 await env.DB.prepare("UPDATE managed_installations SET phase='installed',machine_id='machine1' WHERE id=?").bind(install.id).run();await activateDeploymentInstance(env.DB,f.userId,f.deployment.id,f.version,install.runtime!.instance.instanceId);await expect(bindInstalledManagedRuntime(env,f.userId,f.deployment.id,install.id)).rejects.toThrow("instance changed");
});
