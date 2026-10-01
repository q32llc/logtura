import { env } from "cloudflare:test";
import { expect,it } from "vitest";
import { canonicalConfigJson,createSecretVersioner,type GenerateInput } from "@logtura/core";
import { exportHostedManifest } from "../../src/credential-intent";
import { createConnection,getConnection,refreshConnectionCredentials,updateConnectionCredentials,decryptConnectionCredentials } from "../../src/db";
import { readConfigurationVersion } from "../../src/config-version";
import { ensureFreshAccessToken } from "../../src/providers/supabase-token";
import { ensureFreshRailwayAccessToken } from "../../src/providers/railway-token";
import { mockFetch,seedUser } from "./_setup";

const cases=[{provider:"supabase-edge-logs",field:"pat",url:"https://api.supabase.com/v1/oauth/token",renew:ensureFreshAccessToken},{provider:"railway-logs",field:"apiToken",url:"https://backboard.railway.com/oauth/token",renew:ensureFreshRailwayAccessToken}];
const configured={...env,SUPABASE_CLIENT_ID:"client",SUPABASE_CLIENT_SECRET:"secret",RAILWAY_CLIENT_ID:"client",RAILWAY_CLIENT_SECRET:"secret"};
async function fixture(provider:string,credentials:Record<string,unknown>){
  const {userId}=await seedUser();const conn=await createConnection(env.DB,env,{userId,provider,displayName:"Account",externalAccountId:null,credentials});return {userId,conn};
}
it.each(cases)("keeps $provider OAuth intent stable through renewal and rotates on explicit replacement",async c=>{
  const {userId,conn}=await fixture(c.provider,{[c.field]:"old",refreshToken:"old-refresh",expiresAt:1});
  const version=await readConfigurationVersion(env.DB,userId),before=await getConnection(env.DB,userId,conn.id);expect(before!.credential_version).toMatch(/^[0-9a-f]{32}$/);
  mockFetch(c.url,async req=>{expect(new URLSearchParams(await req.text()).get("refresh_token")).toBe("old-refresh");return Response.json({access_token:"new",refresh_token:"new-refresh",expires_in:3600,token_type:"Bearer"});});
  expect(await c.renew(configured,before!)).toBe("new");
  const after=(await getConnection(env.DB,userId,conn.id))!;expect(after.credential_version).toBe(before!.credential_version);expect(after.credentials_refresh_nonce).toBeTruthy();expect(await readConfigurationVersion(env.DB,userId)).toBe(version);expect(await decryptConnectionCredentials(env,after)).toMatchObject({[c.field]:"new",refreshToken:"new-refresh"});
  expect(await refreshConnectionCredentials(env.DB,env,before!,{[c.field]:"stale-result"})).toBe(false);
  const replaced=await updateConnectionCredentials(env.DB,env,userId,conn.id,{credentials:{[c.field]:"replacement",refreshToken:"replacement-refresh"}});expect(replaced!.credential_version).not.toBe(after.credential_version);expect(await readConfigurationVersion(env.DB,userId)).toBeGreaterThan(version);
  expect(await refreshConnectionCredentials(env.DB,env,after,{[c.field]:"stale-result"})).toBe(false);expect(await decryptConnectionCredentials(env,replaced!)).toMatchObject({[c.field]:"replacement"});
});
it.each(cases)("passes through $provider PAT and cached OAuth tokens without writes",async c=>{
  for(const credentials of [{[c.field]:"pat"},{[c.field]:"pat",refreshToken:"refresh",expiresAt:Date.now()+120_000}]){
    const {userId,conn}=await fixture(c.provider,credentials),before=(await getConnection(env.DB,userId,conn.id))!,version=await readConfigurationVersion(env.DB,userId);
    expect(await c.renew(configured,before)).toBe("pat");expect(await getConnection(env.DB,userId,conn.id)).toEqual(before);expect(await readConfigurationVersion(env.DB,userId)).toBe(version);
  }
});
it.each(cases)("rejects unconfigured $provider renewal without writes",async c=>{
  const {userId,conn}=await fixture(c.provider,{[c.field]:"old",refreshToken:"refresh"}),before=(await getConnection(env.DB,userId,conn.id))!;await expect(c.renew({...env,SUPABASE_CLIENT_ID:undefined,RAILWAY_CLIENT_ID:undefined},before)).rejects.toThrow("OAuth client not configured");expect(await getConnection(env.DB,userId,conn.id)).toEqual(before);
});
it.each(cases)("uses a concurrent replacement instead of overwriting it during $provider renewal",async c=>{
  for(const replacement of [{[c.field]:"winner"},{[c.field]:"winner",refreshToken:"winner-refresh",expiresAt:Date.now()+120_000},{[c.field]:"winner",refreshToken:"winner-refresh",expiresAt:1},null]){
    const {userId,conn}=await fixture(c.provider,{[c.field]:"old",refreshToken:"old-refresh"}),before=(await getConnection(env.DB,userId,conn.id))!;
    mockFetch(c.url,async()=>{if(replacement)await updateConnectionCredentials(env.DB,env,userId,conn.id,{credentials:replacement});else await env.DB.prepare("DELETE FROM connections WHERE id=?").bind(conn.id).run();return Response.json({access_token:"loser",expires_in:3600,token_type:"Bearer"});});
    if(!replacement)await expect(c.renew(configured,before)).rejects.toThrow("Connection changed during OAuth renewal");
    else if(replacement.expiresAt===1)await expect(c.renew(configured,before)).rejects.toThrow("Credentials changed during OAuth renewal; retry");
    else expect(await c.renew(configured,before)).toBe("winner");
    const after=await getConnection(env.DB,userId,conn.id);if(after)expect(await decryptConnectionCredentials(env,after)).toEqual(replacement);
  }
});
it("CAS fences owner, provider and credential identity changes",async()=>{
  const {userId,conn}=await fixture("supabase-edge-logs",{pat:"old",refreshToken:"refresh"}),before=(await getConnection(env.DB,userId,conn.id))!;
  for(const altered of [{...before,user_id:"foreign"},{...before,provider:"railway-logs"},{...before,credential_version:"wrong"},{...before,credential_version:undefined}])expect(await refreshConnectionCredentials(env.DB,env,altered,{pat:"bad"})).toBe(false);
  expect(await getConnection(env.DB,userId,conn.id)).toEqual(before);
});
it("versions OAuth grant intent consistently for storage and rendered broker payloads",async()=>{
  const versioner=await createSecretVersioner(env.CREDENTIAL_ENCRYPTION_KEY);
  const input:GenerateInput={providers:[],destinations:[],connections:cases.map(c=>({connection:{id:c.provider,provider:c.provider,displayName:"Account",externalAccountId:null},selectedSources:[],credentials:{[c.field]:"raw",refreshToken:"raw-refresh"}})),monitors:[],runtimeEnv:{MANUAL:"private"}};
  const identities=new Map(cases.map(c=>[c.provider,"opaque-grant"])),raw=await exportHostedManifest(input,identities,versioner);
  const rendered=structuredClone(input);for(const c of rendered.connections)c.credentials={apiToken:"broker",refreshToken:"marker",tailToken:"broker",tailTokenUrl:"https://service.test/token"};
  const broker=await exportHostedManifest(rendered,identities,versioner);expect(broker.document).toEqual(raw.document);expect(broker.secretValues).not.toEqual(raw.secretValues);expect(canonicalConfigJson(raw.document)).not.toContain("opaque-grant");
  identities.set(cases[0]!.provider,"reconnected");expect((await exportHostedManifest(rendered,identities,versioner)).document).not.toEqual(raw.document);
  await expect(exportHostedManifest(input,new Map(),versioner)).rejects.toThrow("Missing stored OAuth credential identity");
  const pat=structuredClone(input);pat.connections[0]!.credentials={pat:"first"};pat.connections[1]!.credentials=undefined;
  const first=await exportHostedManifest(pat,new Map(),versioner);pat.connections[0]!.credentials={pat:"second"};expect((await exportHostedManifest(pat,new Map(),versioner)).document).not.toEqual(first.document);
});
