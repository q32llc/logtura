import { mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,readdirSync,symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it,vi } from "vitest";
import { createSecretVersioner,exportDeploymentManifest,hashConfigDocument } from "@logtura/core";
import { createDeploymentLink,validateDeploymentLink,readDeploymentLink,deploymentStatus,privateFingerprint,manifestReferences } from "../src/deployment-link";
import { writePulledConfig } from "../src/pull";
import { editGraphFile,exportGraphFile } from "../src/graph";
import { deploymentLinkPath } from "../src/file-transaction";
import { readDotEnvFile,writeEnvValues } from "../src/local-env";
import { main } from "../src/main";
vi.mock("node:fs",{spy:true});const native=await vi.importActual<typeof fs>("node:fs");
const roots:string[]=[];afterEach(()=>{vi.mocked(fs.renameSync).mockReset();vi.mocked(fs.openSync).mockReset();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function directory(){const root=mkdtempSync(join(tmpdir(),"logtura-link-"));roots.push(root);return root;}
async function fixture(){
 const root=directory(),path=join(root,"logt.yaml"),exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[{connection:{id:"con_site",provider:"cloudflare-worker-tail",displayName:"Sites",externalAccountId:"account"},credentials:{apiToken:"credential-private"},selectedSources:[{id:"src_site",externalId:"site",displayName:"Site",sourceKind:"cf_worker",metadata:{private:"source-private"}}]},{connection:{id:"con_empty",provider:"cloudflare-worker-tail",displayName:"Empty",externalAccountId:"empty"},selectedSources:[]}],monitors:[{monitor:{id:"mon_site",displayName:"Errors",connectionId:"con_site",enabled:true,filterSteps:[]},sinks:[{sink:{id:"sink_site",filterSteps:[]},destination:{id:"dst_site",kind:"webhook",displayName:"Alerts"},destinationConfig:{url:"https://destination-private.test/hook"}}]}],metrics:{kind:"destination",destination:{id:"dst_metrics",kind:"datadog_metrics",displayName:"Metrics"},destinationConfig:{apiKey:"metrics-private"}},runtimeEnv:{CUSTOM:"runtime-private"}},await createSecretVersioner("fixture-private"));
 const result={...exported,revision:await hashConfigDocument(exported.document),deployment:{id:"dep_site",displayName:"Existing forwarder"},configurationVersion:3,desiredSequence:0};
 const link=await createDeploymentLink("https://service.test/","usr_site",result);await writePulledConfig(result,path,false,link);return {root,path,result,link};
}
it("stores a private account/deployment baseline and only keyed fingerprints, separate from portable YAML",async()=>{
 const f=await fixture(),file=deploymentLinkPath(f.path);expect(statSync(file).mode&0o777).toBe(0o600);expect(await readDeploymentLink(f.path)).toEqual(f.link);expect(f.link.service).toBe("https://service.test");expect(f.link.document).toEqual(f.result.document);expect(Object.keys(f.link.fingerprints)).toHaveLength(5);
 const stored=readFileSync(file,"utf8");for(const secret of ["credential-private","source-private","destination-private.test","metrics-private","runtime-private"])expect(stored).not.toContain(secret);
 expect(readFileSync(f.path,"utf8")).not.toContain(f.link.privateKey);expect(await deploymentStatus(f.path)).toMatchObject({linked:true,configurationVersion:3,desiredSequence:0,changes:[],privateChanges:[]});
 const other=await createDeploymentLink("https://service.test","usr_site",f.result);expect(other.privateKey).not.toBe(f.link.privateKey);expect(other.fingerprints).not.toEqual(f.link.fingerprints);
});
it("keeps the hosted baseline through offline local edits and avoids copying the source link to a new export",async()=>{
 const f=await fixture(),original=readFileSync(deploymentLinkPath(f.path),"utf8");vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("offline");}));
 await editGraphFile(f.path,[{kind:"source.add",connectionId:"con_site",source:{id:"src_new",externalId:"new-site",displayName:"New",sourceKind:"cf_worker",metadata:null}}]);
 expect(readFileSync(deploymentLinkPath(f.path),"utf8")).toBe(original);const status=await deploymentStatus(f.path);expect(status).toMatchObject({linked:true,baselineRevision:f.result.revision,privateChanges:[]});expect(status.linked && status.changes.some(change=>change.id==="src_new")).toBe(true);
 const output=join(f.root,"copy.yaml");await exportGraphFile(f.path,output);expect(await readDeploymentLink(output)).toBeNull();expect(await deploymentStatus(output)).toEqual({linked:false});expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("detects manual private edits without exposing payloads and distinguishes revised graph references",async()=>{
 const f=await fixture(),ref=f.result.document.connections[0]!.credentials!;
 writeEnvValues(join(f.root,".env"),{[ref.env]:JSON.stringify({apiToken:"manual-private"})},{force:true});
 let status=await deploymentStatus(f.path);expect(status).toMatchObject({privateChanges:[{env:ref.env,kind:"changed",requiresVersionUpdate:true}]});expect(JSON.stringify(status)).not.toContain("manual-private");expect(JSON.stringify(status)).not.toContain(f.link.privateKey);expect(JSON.stringify(status)).not.toContain(f.link.fingerprints[ref.env]);
 await editGraphFile(f.path,[{kind:"connection.update",id:"con_site",patch:{},credentials:{apiToken:"edited-private"}}]);status=await deploymentStatus(f.path);expect(status).toMatchObject({privateChanges:[{env:ref.env,kind:"changed",requiresVersionUpdate:false}]});
});
it("treats JSON formatting as unchanged and detects process overrides, missing, added and removed references",async()=>{
 const f=await fixture(),ref=f.result.document.connections[0]!.credentials!;
 writeEnvValues(join(f.root,".env"),{[ref.env]:'{ "apiToken" : "credential-private" }'},{force:true});expect((await deploymentStatus(f.path)).linked).toBe(true);expect(await deploymentStatus(f.path)).toMatchObject({privateChanges:[]});
 vi.stubEnv(ref.env,JSON.stringify({apiToken:"process-private"}));expect(await deploymentStatus(f.path)).toMatchObject({privateChanges:[{env:ref.env,kind:"changed",requiresVersionUpdate:true}]});vi.unstubAllEnvs();
 writeEnvValues(join(f.root,".env"),{[ref.env]:""},{force:true});expect(await deploymentStatus(f.path)).toMatchObject({privateChanges:[{env:ref.env,kind:"missing",requiresVersionUpdate:false}]});
 const values=Object.fromEntries(readDotEnvFile(join(f.root,".env")));delete values[ref.env];writeFileSync(join(f.root,".env"),Object.entries(values).map(([name,value])=>`${name}=${JSON.stringify(value)}`).join("\n"));expect(await deploymentStatus(f.path)).toMatchObject({privateChanges:[{env:ref.env,kind:"missing",requiresVersionUpdate:false}]});
 writeEnvValues(join(f.root,".env"),{[ref.env]:f.result.secretValues[ref.env]!},{force:true});
 await editGraphFile(f.path,[{kind:"source.add",connectionId:"con_site",source:{id:"src_new",externalId:"new",displayName:"New",sourceKind:"cf_worker",metadata:{private:"new-private"}}},{kind:"source.remove",id:"src_site"}]);
 const status=await deploymentStatus(f.path);expect(status.linked && status.privateChanges.map(change=>change.kind).sort()).toEqual(["added","removed"]);expect(JSON.stringify(status)).not.toContain("new-private");
});
it("rejects invalid private JSON with a value-free error",async()=>{
 const f=await fixture(),ref=f.result.document.connections[0]!.credentials!;writeEnvValues(join(f.root,".env"),{[ref.env]:"invalid-private-payload"},{force:true});await expect(deploymentStatus(f.path)).rejects.toThrow("Referenced private payload must be JSON");expect(()=>privateFingerprint(f.link.privateKey,ref.env,"invalid-private-payload")).toThrow("must be JSON");
});
it("handles a graph without optional private references and requires complete export fences/payloads",async()=>{
 const root=directory(),path=join(root,"logt.yaml"),exported=await exportDeploymentManifest({providers:[],destinations:[],connections:[],monitors:[]},await createSecretVersioner("fixture")),result={...exported,revision:await hashConfigDocument(exported.document),configurationVersion:0,desiredSequence:0,deployment:{id:"dep_empty",displayName:""}};
 const link=await createDeploymentLink("http://localhost:8787","usr_empty",result);expect(manifestReferences(result.document).size).toBe(0);await writePulledConfig(result,path,false,link);expect(await deploymentStatus(path)).toMatchObject({privateChanges:[]});
 await expect(createDeploymentLink("https://service.test","usr_empty",{...result,configurationVersion:undefined})).rejects.toThrow("baselines");await expect(createDeploymentLink("https://service.test","usr_empty",{...result,desiredSequence:undefined})).rejects.toThrow("baselines");
 const f=await fixture();await expect(createDeploymentLink("https://service.test","usr_site",{...f.result,secretValues:{}})).rejects.toThrow("all referenced");
});
it("validates counter, identity, origin, schema, fingerprint and hash integrity before accepting private state",async()=>{
 const f=await fixture();
 for(const value of [null,[],{}, {...f.link,schemaVersion:2},{...f.link,service:"https://service.test/"},{...f.link,service:"https://service.test/path"},{...f.link,service:2},{...f.link,accountId:""},{...f.link,accountId:2},{...f.link,deployment:null},{...f.link,deployment:{id:"",displayName:""}},{...f.link,deployment:{id:"dep",displayName:2}},{...f.link,deployment:{...f.link.deployment,token:"private"}},{...f.link,configurationVersion:-1},{...f.link,configurationVersion:1.2},{...f.link,desiredSequence:-1},{...f.link,desiredSequence:1.2},{...f.link,privateKey:"bad"},{...f.link,privateKey:2},{...f.link,fingerprints:null},{...f.link,fingerprints:[]},{...f.link,fingerprints:{}},{...f.link,fingerprints:{...f.link.fingerprints,EXTRA:"a".repeat(64)}},{...f.link,fingerprints:{...f.link.fingerprints,[Object.keys(f.link.fingerprints)[0]!]:"bad"}},{...f.link,revision:"wrong"},{...f.link,document:{}},{...f.link,token:"private"}])await expect(validateDeploymentLink(value)).rejects.toThrow("Invalid deployment link");
 const copy=await validateDeploymentLink(f.link);copy.deployment.id="changed";expect(f.link.deployment.id).toBe("dep_site");
});
it("refuses malformed or symlink link files and reports unlinked configurations without network",async()=>{
 const root=directory(),path=join(root,"logt.yaml");expect(await readDeploymentLink(path)).toBeNull();expect(await deploymentStatus(path)).toEqual({linked:false});writeFileSync(deploymentLinkPath(path),"broken-private");await expect(readDeploymentLink(path)).rejects.toThrow("Invalid deployment link");rmSync(deploymentLinkPath(path));writeFileSync(path,"keep");symlinkSync(path,deploymentLinkPath(path));await expect(readDeploymentLink(path)).rejects.toThrow("regular");expect(readFileSync(path,"utf8")).toBe("keep");
});
it("rolls back manifest, environment and existing baseline when link installation fails",async()=>{
 const f=await fixture(),originals=[join(f.root,".env"),f.path,deploymentLinkPath(f.path)].map(path=>[path,readFileSync(path,"utf8")] as const),next={...f.result,configurationVersion:4,desiredSequence:1},link=await createDeploymentLink("https://service.test","usr_site",next);
 vi.spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(from).endsWith(".tmp") && to===deploymentLinkPath(f.path))throw new Error("link write failed");return native.renameSync(from,to);});
 await expect(writePulledConfig(next,f.path,true,link)).rejects.toThrow("link write failed");for(const [path,text] of originals)expect(readFileSync(path,"utf8")).toBe(text);expect(readdirSync(f.root)).toEqual([".env","logt.yaml","logt.yaml.logtura-link.json"]);
});
it("protects baseline identity and unsafe destinations before touching local files",async()=>{
 const f=await fixture(),before=readFileSync(f.path,"utf8");for(const patch of [{revision:"bad"},{deployment:{id:"dep_other",displayName:"Other"}},{configurationVersion:4},{desiredSequence:1}])await expect(writePulledConfig({...f.result,...patch},f.path,true,f.link)).rejects.toThrow();expect(readFileSync(f.path,"utf8")).toBe(before);
 rmSync(f.path);await expect(writePulledConfig(f.result,f.path,false,f.link)).rejects.toThrow("exists");await writePulledConfig(f.result,f.path,true,f.link);rmSync(deploymentLinkPath(f.path));symlinkSync(f.path,deploymentLinkPath(f.path));await expect(writePulledConfig(f.result,f.path,true,f.link)).rejects.toThrow("regular");
});
it("reports linked and unlinked state through CLI JSON without printing private keys",async()=>{
 const f=await fixture(),output=vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});expect(await main(["-c",f.path,"config","status","--json"])).toBe(0);expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({linked:true,accountId:"usr_site",configurationVersion:3});expect(String(output.mock.calls.at(-1)![0])).not.toContain(f.link.privateKey);
 expect(await main(["-c",join(f.root,"unlinked.yaml"),"config","status"])).toBe(0);expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({linked:false});expect(await main(["-c",f.path,"config","status","extra"])).toBe(1);
});

it("preserves a concurrent writer's newly created config when overwrite permission was checked before lock acquisition",async()=>{
 const f=await fixture(),path=join(f.root,"new.yaml"),journal=join(f.root,".logtura-transaction.json");
 vi.spyOn(fs,"openSync").mockImplementation((file,flags,mode)=>{if(file===journal && flags==="wx")writeFileSync(path,"concurrent writer's config");return native.openSync(file,flags,mode);});
 await expect(writePulledConfig(f.result,path,false)).rejects.toThrow("exists");expect(readFileSync(path,"utf8")).toBe("concurrent writer's config");expect(readFileSync(f.path,"utf8")).toContain("logtura.deployment");
});
