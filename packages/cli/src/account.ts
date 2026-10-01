import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { authorizeCliDevice, LogturaServiceClient, normalizeServiceUrl, ServiceError, type AccountCredential } from "@logtura/core";

export interface StoredAccount extends AccountCredential {service:string;}
export function accountFile():string {return process.env.LOGT_AUTH_FILE??join(process.env.XDG_CONFIG_HOME??join(homedir(),".config"),"logtura","account.json");}
export function readAccount(path=accountFile()):StoredAccount|null {
  if(!existsSync(path))return null;
  if(process.platform!=="win32" && (statSync(path).mode&0o077)!==0)throw new Error(`Account credential file must be private: chmod 600 ${path}`);
  const data=JSON.parse(readFileSync(path,"utf8")) as StoredAccount;
  if(!/^lt_cli_[A-Za-z0-9_-]{43}$/.test(data.token) || !Number.isFinite(data.expiresAt) || data.scope!=="account:read account:write")throw new Error("Invalid saved Logtura account credential");
  return {token:data.token,scope:data.scope,expiresAt:data.expiresAt,service:normalizeServiceUrl(data.service)};
}
export function saveAccount(account:StoredAccount,path=accountFile()):void {
  const service=normalizeServiceUrl(account.service);
  if(!/^lt_cli_[A-Za-z0-9_-]{43}$/.test(account.token) || !Number.isFinite(account.expiresAt) || account.expiresAt<=Date.now() || account.scope!=="account:read account:write")throw new Error("Invalid Logtura account credential");
  mkdirSync(dirname(path),{recursive:true,mode:0o700});const temporary=`${path}.${randomUUID()}.tmp`;
  try{writeFileSync(temporary,JSON.stringify({token:account.token,scope:account.scope,expiresAt:account.expiresAt,service})+"\n",{flag:"wx",mode:0o600});renameSync(temporary,path);chmodSync(path,0o600);}
  finally{rmSync(temporary,{force:true});}
}
export function accountClient(service?:string,fetchImpl:typeof fetch=fetch,options:{allowExpired?:boolean}={}):LogturaServiceClient {
  const saved=readAccount();const url=normalizeServiceUrl(service??process.env.LOGT_SERVICE_URL??saved?.service??"https://logtura.com");
  const token=process.env.LOGT_SERVICE_TOKEN??(saved?.service===url?saved.token:undefined);
  if(!token)throw new Error("Sign in first with logt login");
  if(!options.allowExpired && !process.env.LOGT_SERVICE_TOKEN && saved!.expiresAt<=Date.now())throw new Error("Logtura account credential expired; run logt login");
  return new LogturaServiceClient({url,token,fetch:fetchImpl});
}
export async function loginAccount(options:{service?:string;label?:string;noBrowser?:boolean;fetch?:typeof fetch;sleep?:(milliseconds:number)=>Promise<void>;show?:(url:string,code:string)=>void}={}):Promise<void>{
  const client=new LogturaServiceClient({url:options.service??process.env.LOGT_SERVICE_URL??"https://logtura.com",fetch:options.fetch??fetch});
  const credential=await authorizeCliDevice(client,options.label??hostname(),{
    sleep:options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),
    show:device=>{(options.show??((url,code)=>console.log(`Open ${url}\nApproval code: ${code}`)))(device.verificationUri,device.userCode);
      if(!options.noBrowser)openBrowser(device.verificationUri);},
  });
  const user=await new LogturaServiceClient({url:client.url,token:credential.token,fetch:options.fetch??fetch}).whoami();
  saveAccount({...credential,service:client.url});console.log(`Signed in as ${user.githubLogin} at ${client.url}`);
}
export async function logoutAccount(options:{local?:boolean;service?:string}={}):Promise<void>{
  if(options.local){rmSync(accountFile(),{force:true});console.log("Removed local account credential");return;}
  const saved=readAccount();
  if(!saved && !process.env.LOGT_SERVICE_TOKEN){console.log("Already signed out");return;}
  const client=accountClient(options.service,fetch,{allowExpired:true});
  try{await client.logout();}catch(error){if(!(error instanceof ServiceError && error.status===401))throw error;}
  if(!saved || saved.service===client.url)rmSync(accountFile(),{force:true});
  console.log("Revoked CLI access and signed out");
}
function openBrowser(url:string):void {
  const command=process.platform==="darwin"?"open":process.platform==="win32"?"rundll32":"xdg-open";
  const args=process.platform==="win32"?["url.dll,FileProtocolHandler",url]:[url];
  const child=spawn(command,args,{stdio:"ignore",detached:true});child.on("error",()=>{});child.unref();
}
