import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CLI_PERSISTENT_EXPIRY, hashCliSecret } from "../../src/cli-auth";
import { signCookie } from "../../src/crypto";
import { mockFetch, seedUser } from "./_setup";

type Device = {deviceCode:string;userCode:string;verificationUri:string;expiresIn:number;interval:number};
let requester=0;let requesterIp="";beforeEach(()=>{requesterIp=`203.0.113.${++requester}`;});
const url="http://localhost/api/cli";
async function json(path:string,body:unknown,headers:Record<string,string>={}) {return SELF.fetch(`${url}${path}`,{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":requesterIp,...headers},body:JSON.stringify(body),redirect:"manual"});}
async function start(label="Test terminal") {const response=await json("/device/start",{label});expect(response.status).toBe(200);return await response.json() as Device;}
async function approve(device:Device,cookie:string,decision=true) {return json(`/devices/${device.userCode}/decision`,{approve:decision},{cookie,origin:"http://localhost"});}
async function issue(cookie:string) {const device=await start();expect((await approve(device,cookie)).status).toBe(200);const poll=await json("/device/poll",{deviceCode:device.deviceCode});expect(poll.status).toBe(200);return {device,...await poll.json() as {token:string;expiresAt:number;scope:string}};}

describe("account CLI device flow",()=>{
  it("requires browser approval, delivers a retryable hashed credential and uses the website account",async()=>{
    const user=await seedUser();const device=await start();
    expect(device.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);expect(device.verificationUri).toContain(`/app/cli?code=${device.userCode}`);
    expect(device.interval).toBe(5);expect(device.expiresIn).toBe(600);
    const pending=await json("/device/poll",{deviceCode:device.deviceCode});expect(pending.status).toBe(202);
    expect((await pending.json() as {error:string}).error).toBe("authorization_pending");
    expect((await json("/device/poll",{deviceCode:device.deviceCode})).status).toBe(429);
    const lookup=await SELF.fetch(`${url}/devices/${device.userCode}`,{headers:{cookie:user.sessionCookie}});expect(lookup.status).toBe(200);
    expect(await lookup.json()).not.toHaveProperty("device_hash");
    expect((await approve(device,user.sessionCookie)).status).toBe(200);
    const poll=await json("/device/poll",{deviceCode:device.deviceCode});expect(poll.headers.get("cache-control")).toBe("no-store");
    const credential=await poll.json() as {token:string;expiresAt:number;scope:string};expect(credential.token).toMatch(/^lt_cli_[A-Za-z0-9_-]{43}$/);
    expect(credential.scope).toBe("account:read account:write");
    expect(await (await json("/device/poll",{deviceCode:device.deviceCode})).json()).toEqual(credential);
    const raw=await env.DB.prepare("SELECT * FROM cli_account_tokens WHERE user_id=?").bind(user.userId).first();
    expect(JSON.stringify(raw)).not.toContain(credential.token);expect(raw?.token_hash).toBe(await hashCliSecret(credential.token));
    const me=await SELF.fetch("http://localhost/api/me",{headers:{authorization:`Bearer ${credential.token}`}});expect((await me.json() as any).user.id).toBe(user.userId);
    expect((await SELF.fetch("http://localhost/api/connections",{headers:{authorization:`Bearer ${credential.token}`}})).status).toBe(200);
    const list=await SELF.fetch(`${url}/tokens`,{headers:{cookie:user.sessionCookie}});const data=await list.json() as any;expect(data.tokens).toHaveLength(1);expect(data.tokens[0]).not.toHaveProperty("token_hash");
  });
  it("does not grant reporting tokens account permissions or allow CLI credentials to approve devices",async()=>{
    const user=await seedUser();const credential=await issue(user.sessionCookie);const other=await start();
    expect((await SELF.fetch("http://localhost/api/connections",{headers:{authorization:"Bearer forwarder-reporting-token"},redirect:"manual"})).status).toBe(401);
    const headers={authorization:`Bearer ${credential.token}`,origin:"http://localhost"};
    expect((await json(`/devices/${other.userCode}/decision`,{approve:true},headers)).status).toBe(401);
    expect((await SELF.fetch(`${url}/tokens`,{headers})).status).toBe(401);
    expect((await SELF.fetch(`${url}/devices/${other.userCode}`,{headers})).status).toBe(401);
  });
  it("revokes credentials from the browser and cannot revive them through polling",async()=>{
    const user=await seedUser();const credential=await issue(user.sessionCookie);
    const row=await env.DB.prepare("SELECT id FROM cli_account_tokens WHERE user_id=?").bind(user.userId).first<{id:string}>();
    const revoke=await SELF.fetch(`${url}/tokens/${row!.id}`,{method:"DELETE",headers:{cookie:user.sessionCookie,origin:"http://localhost"}});expect(revoke.status).toBe(200);
    expect((await SELF.fetch("http://localhost/api/connections",{headers:{authorization:`Bearer ${credential.token}`}})).status).toBe(401);
    expect((await json("/device/poll",{deviceCode:credential.device.deviceCode})).status).toBe(403);
  });
  it("allows self logout, isolates accounts and denies double approval",async()=>{
    const user=await seedUser();const other=await seedUser();const credential=await issue(user.sessionCookie);
    expect((await approve(credential.device,other.sessionCookie)).status).toBe(409);
    expect((await SELF.fetch(`${url}/devices/${credential.device.userCode}`,{headers:{cookie:other.sessionCookie}})).status).toBe(404);
    const row=await env.DB.prepare("SELECT id FROM cli_account_tokens WHERE user_id=?").bind(user.userId).first<{id:string}>();
    await SELF.fetch(`${url}/tokens/${row!.id}`,{method:"DELETE",headers:{cookie:other.sessionCookie,origin:"http://localhost"}});
    expect((await SELF.fetch("http://localhost/api/connections",{headers:{authorization:`Bearer ${credential.token}`}})).status).toBe(200);
    expect((await json("/logout",{},{authorization:`Bearer ${credential.token}`})).status).toBe(200);
    expect((await SELF.fetch("http://localhost/api/me",{headers:{authorization:`Bearer ${credential.token}`}})).status).toBe(401);
  });
  it("enforces expiration, denial, session and Origin checks",async()=>{
    const user=await seedUser();const denied=await start();
    expect((await json(`/devices/${denied.userCode}/decision`,{approve:true})).status).toBe(401);
    expect((await json(`/devices/${denied.userCode}/decision`,{approve:true},{cookie:user.sessionCookie,origin:"https://wrong.test"})).status).toBe(403);
    expect((await json(`/devices/${denied.userCode}/decision`,{approve:"yes"},{cookie:user.sessionCookie,origin:"http://localhost"})).status).toBe(400);
    expect((await approve(denied,user.sessionCookie,false)).status).toBe(200);
    expect((await json("/device/poll",{deviceCode:denied.deviceCode})).status).toBe(403);
    const expired=await start();await env.DB.prepare("UPDATE cli_device_authorizations SET expires_at=0 WHERE device_hash=?").bind(await hashCliSecret(expired.deviceCode)).run();
    expect((await json("/device/poll",{deviceCode:expired.deviceCode})).status).toBe(410);
    expect((await SELF.fetch(`${url}/devices/${expired.userCode}`,{headers:{cookie:user.sessionCookie}})).status).toBe(404);
    const credential=await issue(user.sessionCookie);await env.DB.prepare("UPDATE cli_account_tokens SET expires_at=0 WHERE user_id=?").bind(user.userId).run();
    expect((await SELF.fetch("http://localhost/api/connections",{headers:{authorization:`Bearer ${credential.token}`}})).status).toBe(401);
  });
  it("bounds public requests and validates malformed inputs",async()=>{
    for(const label of [null,"","a".repeat(81),42]) expect((await json("/device/start",{label})).status).toBe(400);
    for(const deviceCode of [null,"",42,"x".repeat(43)]) expect((await json("/device/poll",{deviceCode})).status).toBe(400);
    for(let i=0;i<10;i++)await start();expect((await json("/device/start",{label:"excess"})).status).toBe(429);
  });
});

describe("CLI browser login continuation",()=>{
  it("returns to device approval after GitHub login and blocks open redirects",async()=>{
    for(const [target,expected] of [["/app/cli?code=ABCD-EFGH","/app/cli?code=ABCD-EFGH"],["https://evil.test","/app"],["//evil.test","/app"]]) {
      const start=await SELF.fetch(`http://localhost/login/github?return_to=${encodeURIComponent(target!)}`,{redirect:"manual"});
      const location=new URL(start.headers.get("location")!);const cookie=start.headers.get("set-cookie")!.split(";")[0]!;
      mockFetch("https://github.com/login/oauth/access_token",()=>Response.json({access_token:"test"}));mockFetch("https://api.github.com/user",()=>Response.json({id:123,login:"test",email:"fixture@example.com",name:"Test",avatar_url:null}));
      const finish=await SELF.fetch(`http://localhost/auth/github/callback?code=fixture&state=${location.searchParams.get("state")}`,{headers:{cookie},redirect:"manual"});
      expect(finish.status).toBe(303);expect(finish.headers.get("location")).toBe(expected);
    }
  });
  it("accepts in-flight legacy state cookies",async()=>{
    const signed=await signCookie("legacy-state",env.SESSION_SECRET);
    mockFetch("https://github.com/login/oauth/access_token",()=>Response.json({access_token:"test"}));mockFetch("https://api.github.com/user",()=>Response.json({id:123,login:"test",email:"fixture@example.com",name:"Test",avatar_url:null}));
    const finish=await SELF.fetch("http://localhost/auth/github/callback?code=fixture&state=legacy-state",{headers:{cookie:`logtura_oauth_state=${signed}`},redirect:"manual"});expect(finish.headers.get("location")).toBe("/app");
  });
});

it("runs the public client authorization protocol against workerd",async()=>{
  const {LogturaServiceClient,authorizeCliDevice}=await import("@logtura/core");
  const user=await seedUser();
  const fetchImpl:typeof fetch=(input,init)=>SELF.fetch(new Request(input as string,{...init,headers:new Headers({...Object.fromEntries(new Headers(init?.headers)),"cf-connecting-ip":requesterIp})}));
  const client=new LogturaServiceClient({url:"http://localhost",fetch:fetchImpl});
  const credential=await authorizeCliDevice(client,"Public client",{show:async device=>{expect((await approve(device as Device,user.sessionCookie)).status).toBe(200);},sleep:async()=>{throw new Error("approved flow should not sleep");}});
  const authenticated=new LogturaServiceClient({url:"http://localhost",token:credential.token,fetch:fetchImpl});
  expect((await authenticated.whoami()).id).toBe(user.userId);await authenticated.logout();
  await expect(authenticated.whoami()).rejects.toMatchObject({status:401});
});

it("rejects malformed JSON and unauthorized token management",async()=>{
 const user=await seedUser();const device=await start();
 for(const [path,headers] of [["/device/start",{}],["/device/poll",{}],[`/devices/${device.userCode}/decision`,{cookie:user.sessionCookie,origin:"http://localhost"}]]){
  expect((await SELF.fetch(`${url}${path}`,{method:"POST",headers:{"content-type":"application/json",...headers},body:"{bad"})).status).toBe(400);
 }
 expect((await SELF.fetch(`${url}/tokens`)).status).toBe(401);
 expect((await SELF.fetch(`${url}/tokens/missing`,{method:"DELETE"})).status).toBe(401);
 expect((await SELF.fetch(`${url}/tokens/missing`,{method:"DELETE",headers:{cookie:user.sessionCookie}})).status).toBe(403);
 expect((await json("/logout",{},{cookie:user.sessionCookie})).status).toBe(401);
 const issued=await issue(user.sessionCookie);const row=await env.DB.prepare("SELECT id FROM cli_account_tokens WHERE user_id=?").bind(user.userId).first<{id:string}>();
 expect((await SELF.fetch(`${url}/tokens/other`,{method:"DELETE",headers:{authorization:`Bearer ${issued.token}`}})).status).toBe(404);
 expect((await SELF.fetch(`${url}/tokens/${row!.id}`,{method:"DELETE",headers:{authorization:`Bearer ${issued.token}`}})).status).toBe(200);
});


describe("persistent local smoke-test access",()=>{
  it("requires a browser owner and explicit lifetime decision, remains revocable and hashed",async()=>{
    const user=await seedUser(),other=await seedUser(),credential=await issue(user.sessionCookie);
    const row=await env.DB.prepare("SELECT id FROM cli_account_tokens WHERE user_id=?").bind(user.userId).first<{id:string}>();
    const path=`/tokens/${row!.id}/persist`,headers={cookie:user.sessionCookie,origin:"http://localhost"};
    expect((await json(path,{persistent:true})).status).toBe(401);
    expect((await json(path,{persistent:true},{authorization:`Bearer ${credential.token}`,origin:"http://localhost"})).status).toBe(401);
    expect((await json(path,{persistent:true},{cookie:user.sessionCookie,origin:"https://wrong.test"})).status).toBe(403);
    expect((await json(path,{persistent:true},{cookie:other.sessionCookie,origin:"http://localhost"})).status).toBe(404);
    for(const body of [null,[],{}, {persistent:false},{persistent:"true"},{persistent:true,extra:1}])expect((await json(path,body,headers)).status).toBe(400);
    const malformed=await SELF.fetch(`${url}${path}`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:"{"});expect(malformed.status).toBe(400);
    for(let i=0;i<2;i++){const response=await json(path,{persistent:true},headers);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(await response.json()).toEqual({expiresAt:CLI_PERSISTENT_EXPIRY,scope:"account:read account:write"});}
    const raw=await env.DB.prepare("SELECT expires_at,token_hash FROM cli_account_tokens WHERE id=?").bind(row!.id).first();expect(raw?.expires_at).toBe(CLI_PERSISTENT_EXPIRY);expect(raw?.token_hash).toBe(await hashCliSecret(credential.token));
    expect((await SELF.fetch("http://localhost/api/me",{headers:{authorization:`Bearer ${credential.token}`}})).status).toBe(200);
    await SELF.fetch(`${url}/tokens/${row!.id}`,{method:"DELETE",headers});
    expect((await json(path,{persistent:true},headers)).status).toBe(404);
    expect((await SELF.fetch("http://localhost/api/me",{headers:{authorization:`Bearer ${credential.token}`}})).status).toBe(401);
  });
  it("cannot revive expired or nonexistent credentials",async()=>{
    const user=await seedUser();await issue(user.sessionCookie);const row=await env.DB.prepare("SELECT id FROM cli_account_tokens WHERE user_id=?").bind(user.userId).first<{id:string}>();
    await env.DB.prepare("UPDATE cli_account_tokens SET expires_at=0 WHERE id=?").bind(row!.id).run();
    for(const id of [row!.id,"missing"])expect((await json(`/tokens/${id}/persist`,{persistent:true},{cookie:user.sessionCookie,origin:"http://localhost"})).status).toBe(404);
  });
});
