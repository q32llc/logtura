import { mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,statSync,mkdirSync,readdirSync,symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateInput } from "@logtura/core";
import { afterEach,expect,it,vi } from "vitest";
import { createSecretVersioner,exportDeploymentManifest,hashConfigDocument,LogturaServiceClient,ServiceError,type DeploymentConfigCommit,type DeploymentConfigExport } from "@logtura/core";
import { prepareDeploymentPush,readPendingPush,pushDeploymentConfig } from "../src/push";
import { withPushLock,pushLockPath } from "../src/push-lock";
import { assertNoPendingPush,pendingPushPath,deploymentLinkPath } from "../src/file-transaction";
import { createDeploymentLink,readDeploymentLink,deploymentStatus } from "../src/deployment-link";
import { writePulledConfig } from "../src/pull";
import { editGraphFile } from "../src/graph";
import { writeEnvValues,readDotEnvFile } from "../src/local-env";
import { main } from "../src/main";
vi.mock("node:fs",{spy:true});const native=await vi.importActual<typeof fs>("node:fs");
const roots:string[]=[];afterEach(()=>{for(const name of ["rmSync","rmdirSync","readdirSync"] as const)vi.mocked(fs[name]).mockReset();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),"logtura-push-"));roots.push(root);const path=join(root,"logt.yaml"),exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[{connection:{id:"con_site",provider:"cloudflare-worker-tail",displayName:"Sites",externalAccountId:"account"},credentials:{apiToken:"private-original"},selectedSources:[{id:"src_site",externalId:"site",displayName:"Site",sourceKind:"cf_worker",metadata:null}]}],monitors:[]},await createSecretVersioner("service-private"));
 let current:DeploymentConfigExport={...exported,revision:await hashConfigDocument(exported.document),configurationVersion:3,desiredSequence:0,deployment:{id:"dep_site",displayName:"Existing"}};const link=await createDeploymentLink("https://service.test","usr_site",current);await writePulledConfig(current,path,false,link);
 let receipt:{requestId:string;result:DeploymentConfigCommit}|null=null;const requests:unknown[]=[],fetch=vi.fn(async(url,init)=>{
 const target=String(url);if(target.endsWith("/me"))return Response.json({user:{id:"usr_site",githubLogin:"site"}});
 if(target.includes("/receipts/"))return receipt?Response.json(receipt):Response.json({error:"receipt_not_found"},{status:404});
 if(init?.method==="PUT"){
 const body=JSON.parse(init.body as string);requests.push(body);expect(existsSync(pendingPushPath(path))).toBe(true);expect(statSync(pendingPushPath(path)).mode&0o777).toBe(0o600);
 const result={configurationVersion:4,sequence:1,document:body.document,revision:await hashConfigDocument(body.document),sourceAliases:{}};receipt={requestId:body.requestId,result};
 current={...current,document:result.document,revision:result.revision,configurationVersion:result.configurationVersion,desiredSequence:result.sequence,secretValues:{...current.secretValues,...body.secretValues}};
 return Response.json(result);
 }
 return Response.json(current);
 }) as unknown as typeof globalThis.fetch;
 const client=new LogturaServiceClient({url:"https://service.test",token:`lt_cli_${"T".repeat(43)}`,fetch});
 return {root,path,link,client,fetch,requests,get current(){return current;},set current(value){current=value;},get receipt(){return receipt;},set receipt(value){receipt=value;}};
}
it("pushes an offline site edit, persists its request first and atomically advances the linked baseline",async()=>{
 const f=await fixture();writeEnvValues(join(f.root,".env"),{UNRELATED:"never-upload"});await editGraphFile(f.path,[{kind:"source.add",connectionId:"con_site",source:{id:"src_new",externalId:"new-site",displayName:"New",sourceKind:"cf_worker",metadata:null}}]);
 const result=await pushDeploymentConfig(f.client,f.path);expect(result.result.sequence).toBe(1);expect(f.requests).toHaveLength(1);expect(f.requests[0]).not.toHaveProperty("secretValues");expect(JSON.stringify(f.requests)).not.toContain("never-upload");expect(JSON.stringify(f.requests)).not.toContain("private-original");expect(await readDeploymentLink(f.path)).toMatchObject({configurationVersion:4,desiredSequence:1});expect(await deploymentStatus(f.path)).toMatchObject({changes:[],privateChanges:[]});expect(existsSync(pendingPushPath(f.path))).toBe(false);expect(existsSync(pushLockPath(f.path))).toBe(false);expect(readDotEnvFile(join(f.root,".env")).get("UNRELATED")).toBe("never-upload");
});
it("requires explicit private upload, restamps hand-edited references and sends only changed payloads",async()=>{
 const f=await fixture(),ref=f.current.document.connections[0]!.credentials!;writeEnvValues(join(f.root,".env"),{[ref.env]:JSON.stringify({apiToken:"private-new"})},{force:true});
 await expect(pushDeploymentConfig(f.client,f.path)).rejects.toThrow("--upload-secrets");expect(f.requests).toHaveLength(0);expect(existsSync(pendingPushPath(f.path))).toBe(false);
 const preview=await prepareDeploymentPush(f.path,f.link,true);expect(preview.request.secretValues).toEqual({[ref.env]:JSON.stringify({apiToken:"private-new"})});expect(preview.request.document.connections[0]!.credentials!.version).not.toBe(ref.version);expect(readFileSync(f.path,"utf8")).toContain(ref.version);
 await pushDeploymentConfig(f.client,f.path,{uploadSecrets:true});expect(await deploymentStatus(f.path)).toMatchObject({privateChanges:[]});expect(JSON.stringify(f.requests)).not.toContain("private-original");
});
it("resumes a lost commit response from the receipt without sending another PUT",async()=>{
 const f=await fixture(),original=f.fetch;let dropped=false;
 const client=new LogturaServiceClient({url:f.client.url,token:`lt_cli_${"T".repeat(43)}`,fetch:async(url,init)=>{const response=await original(url,init);if(init?.method==="PUT" && !dropped){dropped=true;throw new Error("lost response");}return response;}});
 await expect(pushDeploymentConfig(client,f.path)).rejects.toThrow("lost response");const pending=await readPendingPush(f.path);expect(pending).not.toBeNull();expect(f.requests).toHaveLength(1);await expect(editGraphFile(f.path,[])).rejects.toThrow("Pending push");
 await expect(pushDeploymentConfig(client,f.path)).rejects.toThrow("--resume");await pushDeploymentConfig(client,f.path,{resume:true});expect(f.requests).toHaveLength(1);expect(existsSync(pendingPushPath(f.path))).toBe(false);
});
it("retries the exact durable intent after a failure before the service receives the write",async()=>{
 const f=await fixture();let fail=true;const client=new LogturaServiceClient({url:f.client.url,token:`lt_cli_${"T".repeat(43)}`,fetch:async(url,init)=>{if(init?.method==="PUT" && fail){fail=false;throw new Error("offline");}return f.fetch(url,init);}});
 await expect(pushDeploymentConfig(client,f.path)).rejects.toThrow("offline");const pending=(await readPendingPush(f.path))!;await pushDeploymentConfig(client,f.path,{resume:true});expect((f.requests[0] as any).requestId).toBe(pending.request.requestId);expect(f.requests).toHaveLength(1);
});
it("preserves local edits after a commit until the user explicitly accepts replacement",async()=>{
 const f=await fixture();let changed=false;const client=new LogturaServiceClient({url:f.client.url,token:`lt_cli_${"T".repeat(43)}`,fetch:async(url,init)=>{const response=await f.fetch(url,init);if(init?.method==="PUT" && !changed){changed=true;writeFileSync(f.path,readFileSync(f.path,"utf8").replace("Sites","Manual local edit"));}return response;}});
 await expect(pushDeploymentConfig(client,f.path)).rejects.toThrow("Local configuration changed");expect(readFileSync(f.path,"utf8")).toContain("Manual local edit");await expect(pushDeploymentConfig(client,f.path,{resume:true,acceptRemote:true})).rejects.toThrow("Local configuration changed");await pushDeploymentConfig(client,f.path,{resume:true,acceptRemote:true,force:true});expect(readFileSync(f.path,"utf8")).not.toContain("Manual local edit");
});
it("requires an explicit decision when remote configuration changes after commit",async()=>{
 const f=await fixture();let advanced=false;const client=new LogturaServiceClient({url:f.client.url,token:`lt_cli_${"T".repeat(43)}`,fetch:async(url,init)=>{const response=await f.fetch(url,init);if(init?.method==="PUT" && !advanced){advanced=true;const document=structuredClone(f.current.document);document.connections[0]!.connection.displayName="Website edit";f.current={...f.current,document,revision:await hashConfigDocument(document),configurationVersion:5};}return response;}});
 await expect(pushDeploymentConfig(client,f.path)).rejects.toThrow("Remote configuration changed");const result=await pushDeploymentConfig(client,f.path,{resume:true,acceptRemote:true});expect(result.acceptedRemote).toBe(true);expect(result.result.configurationVersion).toBe(5);expect(await readDeploymentLink(f.path)).toMatchObject({configurationVersion:5});
});
it("keeps unknown outcomes pending and allows accepting remote state after a definitive rejection",async()=>{
 const f=await fixture();const offline=new LogturaServiceClient({url:f.client.url,token:`lt_cli_${"T".repeat(43)}`,fetch:async(url,init)=>{if(init?.method==="PUT")throw new Error("offline");return f.fetch(url,init);}});
 await expect(pushDeploymentConfig(offline,f.path)).rejects.toThrow("offline");await expect(pushDeploymentConfig(offline,f.path,{resume:true,acceptRemote:true})).rejects.toThrow("uncertain");
 const conflict=new LogturaServiceClient({url:f.client.url,token:`lt_cli_${"T".repeat(43)}`,fetch:async(url,init)=>init?.method==="PUT"?Response.json({error:"configuration_changed"},{status:409}):f.fetch(url,init)});
 await expect(pushDeploymentConfig(conflict,f.path,{resume:true})).rejects.toBeInstanceOf(ServiceError);expect((await readPendingPush(f.path))!.rejected).toBe(true);expect((await pushDeploymentConfig(conflict,f.path,{resume:true,acceptRemote:true})).acceptedRemote).toBe(true);
});
it("refuses wrong origins/accounts, unlinked configurations and invalid resume/force options before sending writes",async()=>{
 const f=await fixture();await expect(pushDeploymentConfig(f.client,f.path,{resume:true})).rejects.toThrow("No pending");await expect(pushDeploymentConfig(f.client,f.path,{force:true})).rejects.toThrow("--resume --accept-remote");
 const foreign=new LogturaServiceClient({url:"https://foreign.test",fetch:vi.fn()});await expect(pushDeploymentConfig(foreign,f.path)).rejects.toThrow("origin");
 const wrong=new LogturaServiceClient({url:f.client.url,fetch:async()=>Response.json({user:{id:"usr_wrong",githubLogin:"wrong"}})});await expect(pushDeploymentConfig(wrong,f.path)).rejects.toThrow("account");
 rmSync(deploymentLinkPath(f.path));await expect(pushDeploymentConfig(f.client,f.path)).rejects.toThrow("Pull a hosted");expect(f.requests).toHaveLength(0);
});
it("rejects malformed or unsafe pending files and identifies pending state for shared configs",async()=>{
 const f=await fixture(),pending=await prepareDeploymentPush(f.path,f.link);expect(await readPendingPush(f.path)).toBeNull();
 for(const patch of [{schemaVersion:2},{config:"/tmp/foreign"},{request:{}},{request:{...pending.request,requestId:"bad"}},{snapshot:{}},{snapshot:{...pending.snapshot,fingerprints:{}}},{extra:true},{rejected:"yes"}]){writeFileSync(pendingPushPath(f.path),JSON.stringify({...pending,...patch}));await expect(readPendingPush(f.path)).rejects.toThrow("Invalid pending");}
 writeFileSync(pendingPushPath(f.path),"broken");await expect(readPendingPush(f.path)).rejects.toThrow("Invalid pending");rmSync(pendingPushPath(f.path));symlinkSync(f.path,pendingPushPath(f.path));await expect(readPendingPush(f.path)).rejects.toThrow("regular");
});
it("executes push through the CLI, blocks config mutations while pending and preserves read-only status",async()=>{
 const f=await fixture();vi.stubEnv("LOGT_SERVICE_TOKEN",`lt_cli_${"T".repeat(43)}`);vi.stubEnv("LOGT_SERVICE_URL",f.client.url);vi.stubGlobal("fetch",f.fetch);const output=vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});
 expect(await main(["-c",f.path,"push","--json"])).toBe(0);expect(JSON.parse(output.mock.calls.at(-1)![0]).result.sequence).toBe(1);expect(await main(["-c",f.path,"push","--service","https://wrong.test"])).toBe(1);expect(await main(["-c",f.path,"push","--local"])).toBe(1);
 const pending=await prepareDeploymentPush(f.path,(await readDeploymentLink(f.path))!);writeFileSync(pendingPushPath(f.path),JSON.stringify(pending));expect(await main(["-c",f.path,"source","remove","src_site"])).toBe(1);expect(await main(["-c",f.path,"config","status"])).toBe(0);vi.stubEnv("LOGT_SERVICE_URL","https://wrong.test");expect(await main(["-c",f.path,"push","--resume"])).toBe(1);
});
it("serializes pushes, recovers dead owner markers and refuses unsafe/unverifiable lock state",async()=>{
 const f=await fixture();await withPushLock(f.path,async()=>{await expect(withPushLock(f.path,async()=>{})).rejects.toThrow("still running");});
 mkdirSync(pushLockPath(f.path));writeFileSync(join(pushLockPath(f.path),"2147483647-00000000-0000-4000-8000-000000000001.owner"),"");expect(await withPushLock(f.path,async()=>"recovered")).toBe("recovered");
 mkdirSync(pushLockPath(f.path));expect(await withPushLock(f.path,async()=>"empty")).toBe("empty");
 mkdirSync(pushLockPath(f.path));writeFileSync(join(pushLockPath(f.path),"unknown"),"");await expect(withPushLock(f.path,async()=>{})).rejects.toThrow("Invalid push lock");rmSync(pushLockPath(f.path),{recursive:true});symlinkSync(f.root,pushLockPath(f.path));await expect(withPushLock(f.path,async()=>{})).rejects.toThrow("regular directory");
});

async function replace(f:Awaited<ReturnType<typeof fixture>>,input:GenerateInput){
 const exported=await exportDeploymentManifest(input,await createSecretVersioner("service-private"));f.current={...f.current,...exported,revision:await hashConfigDocument(exported.document)};f.link=await createDeploymentLink(f.client.url,"usr_site",f.current);await writePulledConfig(f.current,f.path,true,f.link);
}
it("selects metadata, destination, metrics and runtime uploads and updates every shared reference",async()=>{
 const f=await fixture();await replace(f,{providers:[],destinations:[],connections:[{connection:{id:"con_site",provider:"cloudflare-worker-tail",displayName:"Sites",externalAccountId:"account"},credentials:{apiToken:"private-original"},selectedSources:[{id:"src_site",externalId:"site",displayName:"Site",sourceKind:"cf_worker",metadata:{secret:"metadata"}}]},{connection:{id:"con_empty",provider:"cloudflare-worker-tail",displayName:"Empty",externalAccountId:null},selectedSources:[]}],monitors:[{monitor:{id:"mon_site",connectionId:"con_site",displayName:"Errors",filterSteps:[],enabled:true},sinks:[{sink:{id:"sink_site",filterSteps:[]},destination:{id:"dst_site",kind:"webhook",displayName:"Alerts"},destinationConfig:{url:"https://private.test/hook"}}]}],metrics:{kind:"destination",destination:{id:"dst_metric",kind:"datadog_metrics",displayName:"Metrics"},destinationConfig:{apiKey:"metric-private"}},runtimeEnv:{CUSTOM:"runtime-private"}});
 const doc=f.current.document,values=f.current.secretValues!;const keys=[doc.connections[0]!.selectedSources[0]!.metadata!.env,doc.monitors[0]!.sinks[0]!.destinationConfig.env,doc.metrics!.kind==="destination"?doc.metrics!.destinationConfig.env:"",doc.runtimeEnv!.env];
 for(const name of keys)writeEnvValues(join(f.root,".env"),{[name]:values[name]!.replace(/metadata|private/g,"updated")},{force:true});
 const pending=await prepareDeploymentPush(f.path,f.link,true);expect(Object.keys(pending.request.secretValues!).sort()).toEqual(keys.sort());expect(JSON.stringify(pending.request.secretValues)).not.toContain("private-original");
});
it.each(["supabase-edge-logs","railway-logs"])("refuses changed %s broker envelopes and permits raw replacements",async provider=>{
 const f=await fixture(),credentials=provider==="supabase-edge-logs"?{pat:"raw-pat",refreshToken:"refresh",tailTokenUrl:"https://service.test/tail"}:{apiToken:"https://service.test/api/tail/railway/token#broker",refreshToken:"refresh"};
 await replace(f,{providers:[],destinations:[],connections:[{connection:{id:"con_site",provider,displayName:"Account",externalAccountId:null},credentials,selectedSources:[]}],monitors:[]});const ref=f.current.document.connections[0]!.credentials!;
 writeEnvValues(join(f.root,".env"),{[ref.env]:JSON.stringify({...credentials,refreshToken:"changed"})},{force:true});await expect(prepareDeploymentPush(f.path,f.link,true)).rejects.toThrow("broker credentials");
 writeEnvValues(join(f.root,".env"),{[ref.env]:JSON.stringify(provider==="supabase-edge-logs"?{pat:"replacement",refreshToken:"refresh"}:{apiToken:"replacement",refreshToken:"refresh"})},{force:true});expect((await prepareDeploymentPush(f.path,f.link,true)).request.uploadSecrets).toBe(true);
});
it("recovers the crash window after local advancement but before pending deletion",async()=>{
 const f=await fixture();let fail=true;vi.spyOn(fs,"rmSync").mockImplementation((path,options)=>{if(path===pendingPushPath(f.path) && fail){fail=false;throw new Error("cleanup failed");}return native.rmSync(path,options);});
 await expect(pushDeploymentConfig(f.client,f.path)).rejects.toThrow("cleanup failed");expect(await readDeploymentLink(f.path)).toMatchObject({configurationVersion:4,desiredSequence:1});expect(await readPendingPush(f.path)).not.toBeNull();await pushDeploymentConfig(f.client,f.path,{resume:true});expect(f.requests).toHaveLength(1);expect(existsSync(pendingPushPath(f.path))).toBe(false);
});
it("covers pending guards without allowing a malformed file or foreign request to bypass them",async()=>{
 const f=await fixture();writeFileSync(pendingPushPath(f.path),"broken");expect(()=>assertNoPendingPush(f.path,"permit")).toThrow("Pending push");writeFileSync(pendingPushPath(f.path),"{}");expect(()=>assertNoPendingPush(f.path,"permit")).toThrow("Pending push");writeFileSync(pendingPushPath(f.path),JSON.stringify({request:{requestId:"other"}}));expect(()=>assertNoPendingPush(f.path,"permit")).toThrow("Pending push");rmSync(pendingPushPath(f.path));symlinkSync(f.path,pendingPushPath(f.path));expect(()=>assertNoPendingPush(f.path,"permit")).toThrow("Pending push");
});
it("fails safely for lock acquisition, verification, cleanup and ownership races",async()=>{
 const f=await fixture();await expect(withPushLock(join(f.root,"missing","logt.yaml"),async()=>{})).rejects.toMatchObject({code:"ENOENT"});
 mkdirSync(pushLockPath(f.path));writeFileSync(join(pushLockPath(f.path),"2147483647-00000000-0000-4000-8000-000000000001.owner"),"");const kill=vi.spyOn(process,"kill").mockImplementation(()=>{throw Object.assign(new Error("denied"),{code:"EPERM"});});await expect(withPushLock(f.path,async()=>{})).rejects.toThrow("Cannot verify");kill.mockRestore();rmSync(pushLockPath(f.path),{recursive:true});
 for(const entries of [["one","two"],["foreign"]]){vi.spyOn(fs,"readdirSync").mockReturnValue(entries as any);await expect(withPushLock(f.path,async()=>{})).rejects.toThrow("lock changed");vi.mocked(fs.readdirSync).mockReset();}
 vi.spyOn(fs,"rmdirSync").mockImplementation(()=>{throw Object.assign(new Error("busy"),{code:"EBUSY"});});await expect(withPushLock(f.path,async()=>{})).rejects.toThrow("busy");vi.mocked(fs.rmdirSync).mockReset();
 await expect(withPushLock(f.path,async()=>{writeFileSync(join(pushLockPath(f.path),"extra"),"");})).resolves.toBeUndefined();
});

it("requires uploads for revised/reassigned references and fails before persisting exhausted or missing values",async()=>{
 const f=await fixture(),doc=structuredClone(f.current.document);doc.connections[0]!.credentials!.version="manual-version";writeFileSync(f.path,JSON.stringify(doc));await expect(prepareDeploymentPush(f.path,f.link)).rejects.toThrow("--upload-secrets");expect((await prepareDeploymentPush(f.path,f.link,true)).request.uploadSecrets).toBe(true);
 doc.connections[0]!.credentials!.version=f.current.document.connections[0]!.credentials!.version;doc.connections[0]!.connection.id="con_changed";writeFileSync(f.path,JSON.stringify(doc));await expect(prepareDeploymentPush(f.path,f.link)).rejects.toThrow("--upload-secrets");
 await expect(prepareDeploymentPush(f.path,{...f.link,desiredSequence:Number.MAX_SAFE_INTEGER})).rejects.toThrow("cannot be advanced");
 writeEnvValues(join(f.root,".env"),{[doc.connections[0]!.credentials!.env]:""},{force:true});await expect(prepareDeploymentPush(f.path,f.link,true)).rejects.toThrow("all referenced");
});

it("validates pending request payloads, complete snapshots, counters and authorization before any retry",async()=>{
 const f=await fixture(),ref=f.current.document.connections[0]!.credentials!;writeEnvValues(join(f.root,".env"),{[ref.env]:JSON.stringify({apiToken:"private-new"})},{force:true});const pending=await prepareDeploymentPush(f.path,f.link,true);
 writeFileSync(pendingPushPath(f.path),JSON.stringify(pending));expect(await readPendingPush(f.path)).toEqual(pending);
 const changes=[{link:{}},{request:null},{request:{...pending.request,extra:true}},{request:{...pending.request,expectedConfigurationVersion:4}},{request:{...pending.request,expectedSequence:1}},{request:{...pending.request,uploadSecrets:false}},{request:{...pending.request,secretValues:[]}}, {request:{...pending.request,secretValues:1}}, {request:{...pending.request,secretValues:{UNRELATED:"private"}}},{request:{...pending.request,secretValues:{[ref.env]:""}}},{request:{...pending.request,secretValues:{[ref.env]:12}}},{request:{...pending.request,secretValues:{[ref.env]:"broken"}}},{request:{...pending.request,secretValues:{[ref.env]:JSON.stringify({apiToken:"tampered-private"})}}},{snapshot:{...pending.snapshot,extra:true}},{snapshot:{...pending.snapshot,fingerprints:[]}}, {snapshot:{...pending.snapshot,fingerprints:1}},{snapshot:{...pending.snapshot,fingerprints:{[ref.env]:"bad"}}}];
 for(const patch of changes){writeFileSync(pendingPushPath(f.path),JSON.stringify({...pending,...patch}));await expect(readPendingPush(f.path)).rejects.toThrow("Invalid pending");}
 writeFileSync(pendingPushPath(f.path),"null");await expect(readPendingPush(f.path)).rejects.toThrow("Invalid pending");
});
it.each(["missing","changed"])("preserves %s private values after local advancement and permits explicit forced recovery",async kind=>{
 const f=await fixture();let fail=true;vi.spyOn(fs,"rmSync").mockImplementation((path,options)=>{if(path===pendingPushPath(f.path) && fail){fail=false;throw new Error("cleanup failed");}return native.rmSync(path,options);});await expect(pushDeploymentConfig(f.client,f.path)).rejects.toThrow("cleanup failed");
 const ref=f.current.document.connections[0]!.credentials!;if(kind==="missing")writeFileSync(join(f.root,".env"),"");else writeEnvValues(join(f.root,".env"),{[ref.env]:JSON.stringify({apiToken:"manual-private"})},{force:true});
 await expect(pushDeploymentConfig(f.client,f.path,{resume:true})).rejects.toThrow("Local configuration changed");await pushDeploymentConfig(f.client,f.path,{resume:true,acceptRemote:true,force:true});expect(await deploymentStatus(f.path)).toMatchObject({privateChanges:[]});
});
it("accepts newer remote state after recovering a locally advanced commit",async()=>{
 const f=await fixture();let fail=true;vi.spyOn(fs,"rmSync").mockImplementation((path,options)=>{if(path===pendingPushPath(f.path) && fail){fail=false;throw new Error("cleanup failed");}return native.rmSync(path,options);});await expect(pushDeploymentConfig(f.client,f.path)).rejects.toThrow("cleanup failed");const document=structuredClone(f.current.document);document.connections[0]!.connection.displayName="Newer website";f.current={...f.current,document,revision:await hashConfigDocument(document),configurationVersion:5};expect((await pushDeploymentConfig(f.client,f.path,{resume:true,acceptRemote:true})).result.configurationVersion).toBe(5);
});
it("skips unsupported directory fsync on Windows and safely reports failed stale-lock replacement",async()=>{
 const f=await fixture();vi.stubGlobal("process",{...process,platform:"win32"});try{await pushDeploymentConfig(f.client,f.path);}finally{vi.unstubAllGlobals();}
 mkdirSync(pushLockPath(f.path));vi.spyOn(fs,"rmdirSync").mockImplementation(()=>{throw new Error("stale lock busy");});await expect(withPushLock(f.path,async()=>{})).rejects.toThrow("Push lock changed");
});
