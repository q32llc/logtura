import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import * as cp from "node:child_process";
import {main} from "../src/main";
import {readConfigDoc} from "../src/config";
vi.mock("node:child_process",{spy:true});
const roots:string[]=[];
let root:string,path:string;
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),"logt-cli-baseline-"));roots.push(root);path=join(root,"logt.yaml");
 vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"warn").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const directory of roots.splice(0))rmSync(directory,{recursive:true,force:true});});
const run=(...args:string[])=>main(["-c",path,...args]);
it("lists machine-readable provider capabilities without requiring or changing a config", async () => {
 expect(await run("providers", "list", "--json")).toBe(0);
 const providers=JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
 expect(providers.find((entry:any)=>entry.id==="railway-logs").selection.field).toBe("services");
 expect(providers.find((entry:any)=>entry.id==="fly-log-tail").credentials[0].env).toBe("FLY_API_TOKEN");
 expect(existsSync(path)).toBe(false);
 expect(await run("providers")).toBe(0);
 expect(await run("providers", "bad")).toBe(1);
 expect(await run("providers", "list", "extra")).toBe(1);
});
function config(token="fixture-token") {writeFileSync(path,JSON.stringify({providers:{fly:{provider:"fly",credentials:{api_token:token}}},sources:{apps:{source:"fly-log-tail",provider:"fly",apps:["fixture-app"]}},sinks:{},monitors:[]}));}
function spawn(status=0) {return vi.mocked(cp.spawnSync).mockReset().mockImplementation(()=>({status,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),pid:1,output:[],signal:null}));}
it("initializes once, scaffolds source defaults and chooses unique default identities",async()=>{
 expect(await run("init")).toBe(0);const initial=readFileSync(path,"utf8");expect(await run("init")).toBe(0);expect(readFileSync(path,"utf8")).toBe(initial);
 for(const id of ["cloudflare-worker-tail","cloudflare-ai-gateway","fly-log-tail","railway-logs","vercel-logs","supabase-edge-logs","custom-vector"])expect(await run("source","add",id)).toBe(0);
 expect(await run("source","add","fly-log-tail")).toBe(0);expect(await run("source","add","fly-log-tail")).toBe(0);
 const sources=readConfigDoc(path).sources as any;expect(sources["fly-log"].apps).toEqual([]);expect(sources["fly-log-2"].apps).toEqual([]);expect(sources["fly-log-3"].apps).toEqual([]);expect(sources["supabase-edge"].gateway).toBe(true);
 expect(await run("source","add","fly-log-tail","--name","fly","--provider","different")).toBe(0);expect((readConfigDoc(path).sources as any).fly.provider).toBe("different");
});
it("writes sink credentials privately, preserves existing secrets and supports explicit replacement",async()=>{
 await run("init");
 expect(await run("sink","add","webhook","alerts","--webhook=https://fixture.invalid/first")).toBe(0);
 expect(await run("sink","add","webhook","alerts","--webhook","https://fixture.invalid/second")).toBe(1);
 expect(readFileSync(join(root,".env"),"utf8")).toContain("https://fixture.invalid/first");
 expect(await run("sink","add","webhook","alerts","--webhook","https://fixture.invalid/second","--force")).toBe(0);
 for(const kind of ["slack","datadog_metrics","prometheus_remote_write"])expect(await run("sink","add",kind,kind)).toBe(0);
 expect(await run("sink","add","slack","channel","--webhook=https://fixture.invalid/slack")).toBe(0);
 expect(statSync(join(root,".env")).mode&0o777).toBe(0o600);expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("https://fixture.invalid/second");
 expect(await run("monitor","add","errors","alerts")).toBe(0);expect(await run("monitor","add","all","alerts","channel")).toBe(0);
 expect((readConfigDoc(path).monitors as any[]).map(m=>m.filter)).toEqual([["errors"],[]]);
});
it("renders/checks/writes environment templates and emits complete standalone artifacts",async()=>{
 config();const write=vi.spyOn(process.stdout,"write").mockImplementation(()=>true);
 expect(await run("env")).toBe(0);expect(String(write.mock.calls[0]?.[0])).toContain("FLY_API_TOKEN=fixture-token");
 expect(await run("env","--json")).toBe(0);expect(await run("env","--check")).toBe(0);
 const template=join(root,"template.env");expect(await run("env","--write",template)).toBe(0);expect(await run("env","--write",template)).toBe(0);
 expect(await run("bundle","-o",join(root,"bundle"))).toBe(0);expect(existsSync(join(root,"bundle","Dockerfile"))).toBe(true);expect(statSync(join(root,"bundle",".env")).mode&0o777).toBe(0o600);
 config("env:LOGT_FIXTURE_ABSENT");vi.stubEnv("LOGT_FIXTURE_ABSENT","");
 expect(await run("env","--check")).toBe(2);expect(await run("env","--write")).toBe(0);expect(await run("validate")).toBe(2);expect(await run("bundle","--output",join(root,"missing"))).toBe(2);
});
it("normalizes and hashes a local configuration in human and JSON output modes",async()=>{
 config();expect(await run("config","normalize")).toBe(0);expect(await run("config","normalize","-o",join(root,"normalized.yaml"),"--json")).toBe(0);
 expect(await run("config","hash")).toBe(0);expect(await run("config","hash","--json")).toBe(0);
 expect(await run("config","recover")).toBe(0);
});
it("runs standalone Fly deployment with generated defaults and keeps secret input off argv",async()=>{
 config();const execute=spawn();expect(await run("deploy","fly","-W","-o",join(root,"deploy"))).toBe(0);
 expect(execute.mock.calls.find(([,args])=>args?.[0]==="secrets")?.[2]?.input).toContain("fixture-token");expect(JSON.stringify(execute.mock.calls.map(([,args])=>args))).not.toContain("fixture-token");
 expect(readFileSync(join(root,"deploy","fly.toml"),"utf8")).toContain("primary_region = \"iad\"");
});
it("reports missing flyctl and failed deployment steps without treating them as success",async()=>{
 config();const execute=spawn(1);expect(await run("deploy","fly","-o",join(root,"deploy"))).toBe(1);expect(console.error).toHaveBeenCalledWith(expect.stringContaining("flyctl is required"));
 execute.mockImplementation((command,args)=>({status:args?.[0]==="deploy"?1:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),pid:1,output:[],signal:null}));expect(await run("deploy","fly","-o",join(root,"deploy"))).toBe(1);expect(console.error).toHaveBeenCalledWith(expect.stringContaining("flyctl deploy"));
});
it("validates Vector configuration with an external process and reports failure",async()=>{
 config();const execute=spawn();const temporary:string[]=[];
 execute.mockImplementation((command,args)=>{
  const file=String(args?.[1]);temporary.push(file);
  expect(command).toBe("vector");expect(readFileSync(file,"utf8")).toContain("fixture-app");expect(statSync(file).mode&0o777).toBe(0o600);
  return {status:temporary.length===1?0:1,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),pid:1,output:[],signal:null};
 });
 expect(await run("validate","--vector-validate")).toBe(0);expect(existsSync(temporary[0]!)).toBe(false);
 expect(await run("validate","--vector-validate")).toBe(1);expect(existsSync(temporary[1]!)).toBe(false);expect(temporary[0]).not.toBe(temporary[1]);
});
it.each([["source"],["source","add"],["sink"],["sink","add","slack"],["monitor"],["monitor","add"],["env"],["bundle"],["validate"],["deploy"],["deploy","other"],["config","unknown"],["init","extra"],["source","add","fly-log-tail","--unknown"],["env","--output"],["stats"],["stats","--metrics"],["stats","a","--metrics","b"]].map(args => ({args})))("rejects invalid arguments or absent config: $args",async({args})=>{
 expect(await run(...args)).toBe(1);expect(existsSync(path)).toBe(false);
});
