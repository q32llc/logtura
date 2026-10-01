import { afterEach,describe,expect,it,vi } from "vitest";
import { mkdtempSync,readFileSync,rmSync,statSync,writeFileSync,existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountClient,accountFile,loginAccount,logoutAccount,readAccount,saveAccount } from "../src/account";
import { main } from "../src/main";
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function setup(){const dir=mkdtempSync(join(tmpdir(),"logt-account-"));dirs.push(dir);const path=join(dir,"profile","account.json");vi.stubEnv("LOGT_AUTH_FILE",path);vi.stubEnv("LOGT_SERVICE_TOKEN",undefined);vi.stubEnv("LOGT_SERVICE_URL",undefined);return path;}
function credential(){return {service:"https://fixture.test",token:"lt_cli_"+"T".repeat(43),scope:"account:read account:write",expiresAt:Date.now()+60_000};}
describe("CLI account storage",()=>{
 it("stores credentials atomically with private modes and validates before replacing",()=>{const path=setup();expect(readAccount()).toBeNull();const saved=credential();saveAccount(saved);expect(readAccount()).toEqual(saved);expect(statSync(path).mode&0o777).toBe(0o600);const before=readFileSync(path,"utf8");expect(()=>saveAccount({...credential(),token:"bad"})).toThrow("Invalid");expect(readFileSync(path,"utf8")).toBe(before);});
 it("uses XDG storage when no explicit auth file is selected",()=>{setup();vi.stubEnv("LOGT_AUTH_FILE",undefined);vi.stubEnv("XDG_CONFIG_HOME","/tmp/fixture-config");expect(accountFile()).toBe("/tmp/fixture-config/logtura/account.json");});
 it("requires authentication and isolates service origins",()=>{setup();expect(()=>accountClient()).toThrow("Sign in");saveAccount(credential());expect(accountClient().url).toBe("https://fixture.test");expect(()=>accountClient("https://other.test")).toThrow("Sign in");vi.stubEnv("LOGT_SERVICE_TOKEN",credential().token);expect(accountClient("https://other.test").url).toBe("https://other.test");});
 it("rejects expired and corrupted saved credentials",()=>{const path=setup();saveAccount(credential());const expired={...credential(),expiresAt:0};writeFileSync(path,JSON.stringify(expired));expect(()=>accountClient()).toThrow("expired");writeFileSync(path,JSON.stringify({token:"bad"}));expect(()=>readAccount()).toThrow("Invalid");});
 it("logs in through approval without printing the issued token",async()=>{const path=setup();const c=credential();const device={deviceCode:"D".repeat(43),userCode:"ABCD-EFGH",verificationUri:"https://fixture.test/app/cli?code=ABCD-EFGH",expiresIn:600,interval:5};const responses=[Response.json(device),Response.json(c),Response.json({user:{id:"usr_fixture",githubLogin:"fixture"}})];const show=vi.fn();await loginAccount({service:c.service,noBrowser:true,show,fetch:vi.fn(async()=>responses.shift()!),sleep:async()=>{throw new Error("unexpected sleep");}});expect(existsSync(path)).toBe(true);expect(show).toHaveBeenCalledWith(device.verificationUri,device.userCode);expect(readAccount()!.token).toBe(c.token);});
 it("preserves credentials on failed login and network revocation failure",async()=>{const path=setup();saveAccount(credential());await expect(loginAccount({service:"https://fixture.test",noBrowser:true,fetch:async()=>Response.json({error:"offline"},{status:503})})).rejects.toThrow();vi.stubGlobal("fetch",async()=>Response.json({error:"offline"},{status:503}));await expect(logoutAccount()).rejects.toThrow();expect(existsSync(path)).toBe(true);await logoutAccount({local:true});expect(existsSync(path)).toBe(false);});
 it("removes credentials after revocation or when the server already revoked them",async()=>{const path=setup();saveAccount(credential());vi.stubGlobal("fetch",async()=>Response.json({error:"invalid_account_token"},{status:401}));await logoutAccount();expect(existsSync(path)).toBe(false);});
 it("exposes whoami and logout commands with no credentials in output",async()=>{setup();saveAccount(credential());vi.stubGlobal("fetch",async()=>Response.json({user:{id:"usr_fixture",githubLogin:"fixture"}}));expect(await main(["--json","whoami"])).toBe(0);expect(await main(["logout","--local"])).toBe(0);expect(await main(["whoami"])).toBe(1);expect(await main(["login","--token","wrong-option"])).toBe(1);});
});

it("executes browser login, polling, whoami and revocation through local HTTP",async()=>{
 const path=setup();const dir=join(path,"..","..");const {createServer}=await import("node:http");const {writeFileSync}=await import("node:fs");
 const capture=join(dir,"browser-url");writeFileSync(join(dir,"xdg-open"),'#!/bin/sh\nprintf "%s" "$1" > "$BROWSER_CAPTURE"\n',{mode:0o755});
 vi.stubEnv("PATH",`${dir}:${process.env.PATH}`);vi.stubEnv("BROWSER_CAPTURE",capture);let polls=0;let revoked=false;let origin="";const c=credential();
 const server=createServer((req,res)=>{res.setHeader("content-type","application/json");let body:unknown;
  if(req.url==="/api/cli/device/start")body={deviceCode:"D".repeat(43),userCode:"ABCD-EFGH",verificationUri:`${origin}/app/cli?code=ABCD-EFGH`,expiresIn:600,interval:1};
  else if(req.url==="/api/cli/device/poll"){if(++polls===1){res.statusCode=202;body={error:"authorization_pending"};}else body=c;}
  else if(req.url==="/api/cli/logout"){revoked=true;body={ok:true};}
  else body={user:{id:"usr_fixture",githubLogin:"fixture"}};
  res.end(JSON.stringify(body));
 });await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{
  expect(await main(["login","--service",origin])).toBe(0);expect(readAccount()!.service).toBe(origin);expect(readFileSync(capture,"utf8")).toContain("/app/cli?code=ABCD-EFGH");
  expect(await main(["whoami"])).toBe(0);expect(await main(["logout"])).toBe(0);expect(revoked).toBe(true);expect(existsSync(path)).toBe(false);
  // A missing desktop browser leaves the printed link usable for manual approval.
  vi.stubEnv("PATH","");expect(await main(["login","--service",origin])).toBe(0);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it("rejects publicly readable credential files and invalid expiration/scope",async()=>{
 const path=setup();saveAccount(credential());const {chmodSync}=await import("node:fs");chmodSync(path,0o644);expect(()=>readAccount()).toThrow("must be private");chmodSync(path,0o600);
 expect(()=>saveAccount({...credential(),expiresAt:0})).toThrow("Invalid");expect(()=>saveAccount({...credential(),scope:"reporting"})).toThrow("Invalid");
 expect(()=>saveAccount({...credential(),expiresAt:Infinity})).toThrow("Invalid");
});

it("rejects invalid stored scopes, signs out expired credentials and keeps other service profiles",async()=>{
 const path=setup();saveAccount(credential());writeFileSync(path,JSON.stringify({...credential(),scope:"reporting"}));expect(()=>readAccount()).toThrow("Invalid");
 writeFileSync(path,JSON.stringify({...credential(),expiresAt:0}));vi.stubGlobal("fetch",async()=>Response.json({error:"invalid_account_token"},{status:401}));await logoutAccount();expect(existsSync(path)).toBe(false);await logoutAccount();
 saveAccount(credential());vi.stubEnv("LOGT_SERVICE_TOKEN",credential().token);vi.stubGlobal("fetch",async()=>Response.json({ok:true}));await logoutAccount({service:"https://other.test"});expect(existsSync(path)).toBe(true);
});
