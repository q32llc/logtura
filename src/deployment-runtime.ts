import { canonicalConfigJson } from "@logtura/core";
import { decryptSecret } from "./crypto";
import type { Env } from "./env";
export async function readDeploymentRuntime(env:Env,encrypted:ArrayBuffer|null|undefined):Promise<Record<string,string>>{
  if(!encrypted)return {};
  try{
    const value:unknown=JSON.parse(await decryptSecret(new Uint8Array(encrypted),env.CREDENTIAL_ENCRYPTION_KEY));
    if(!value || typeof value!=="object" || Array.isArray(value) || Object.values(value).some(v=>typeof v!=="string"))throw new Error();
    return JSON.parse(canonicalConfigJson(value)) as Record<string,string>;
  }catch{throw new Error("Invalid stored deployment runtime environment");}
}
