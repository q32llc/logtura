import { Hono } from "hono";
import type { AppContext, Env } from "./env";
import { newId, newToken } from "./crypto";

const DEVICE_TTL = 10 * 60_000;
const TOKEN_TTL = 90 * 24 * 60 * 60_000;
// Keep the original numeric credential contract compatible with published CLIs.
// Year 9999 denotes access retained until revocation; ordinary grants stay 90 days.
export const CLI_PERSISTENT_EXPIRY = 253402300799999;
const POLL_INTERVAL = 5_000;
const encoder = new TextEncoder();

export async function hashCliSecret(secret: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,"0")).join("");
}

async function accountToken(deviceCode: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(`cli-device-v1:${deviceCode}`)));
  return `lt_cli_${btoa(String.fromCharCode(...digest)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}`;
}

function userCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = [...bytes].map(byte => alphabet[byte & 31]).join("");
  return `${code.slice(0,4)}-${code.slice(4)}`;
}
function cleanCode(value: string) {return value.toUpperCase().replace(/[^A-Z0-9]/g,"");}

interface DeviceRow {
  device_hash: string; user_code: string; label: string; expires_at: number;
  user_id: string | null; decision: "pending" | "approved" | "denied"; next_poll_at: number;
}

export async function findCliIdentity(env: Env, authorization: string) {
  if (!/^Bearer lt_cli_[A-Za-z0-9_-]{43}$/.test(authorization)) return null;
  const tokenHash = await hashCliSecret(authorization.slice(7));
  return env.DB.prepare(`SELECT u.*, t.id AS cli_token_id FROM cli_account_tokens t JOIN users u ON u.id=t.user_id
    WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`).bind(tokenHash,Date.now()).first<{
    id:string;github_login:string;email:string|null;name:string|null;avatar_url:string|null;cli_token_id:string;
  }>();
}

export function cliAuthorizationRoutes() {
  const routes = new Hono<AppContext>();
  routes.use("*", async (c,next) => {c.header("cache-control","no-store");await next();});
  routes.post("/device/start",async c => {
    const body = await c.req.json().catch(()=>null) as {label?:unknown}|null;
    if (!body || typeof body.label!=="string" || !body.label.trim() || body.label.length>80) return c.json({error:"invalid_label"},400);
    const now=Date.now(); const requester=await hashCliSecret(c.req.header("cf-connecting-ip") ?? "local");
    // Short-lived requests are indexed and bounded per requester. No account or
    // forwarder resources are touched by unauthenticated authorization traffic.
    await c.env.DB.prepare("DELETE FROM cli_device_authorizations WHERE expires_at<=?").bind(now).run();
    const code = newToken(); const deviceHash=await hashCliSecret(code); const visible=userCode();
    const result=await c.env.DB.prepare(`INSERT INTO cli_device_authorizations
      (device_hash,user_code,label,requester_hash,created_at,expires_at,next_poll_at)
      SELECT ?,?,?,?,?,?,0 WHERE (SELECT COUNT(*) FROM cli_device_authorizations WHERE requester_hash=? AND expires_at>?)<10`)
      .bind(deviceHash,cleanCode(visible),body.label.trim(),requester,now,now+DEVICE_TTL,requester,now).run();
    if (!result.meta.changes) return c.json({error:"too_many_authorizations"},429);
    return c.json({deviceCode:code,userCode:visible,verificationUri:`${c.env.APP_URL}/app/cli?code=${visible}`,expiresIn:DEVICE_TTL/1000,interval:POLL_INTERVAL/1000});
  });
  routes.post("/device/poll",async c => {
    const body=await c.req.json().catch(()=>null) as {deviceCode?:unknown}|null;
    if (!body || typeof body.deviceCode!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(body.deviceCode)) return c.json({error:"invalid_device_code"},400);
    const now=Date.now(); const deviceHash=await hashCliSecret(body.deviceCode);
    const device=await c.env.DB.prepare("SELECT * FROM cli_device_authorizations WHERE device_hash=?").bind(deviceHash).first<DeviceRow>();
    if (!device) return c.json({error:"invalid_device_code"},400);
    if (device.expires_at<=now) return c.json({error:"expired"},410);
    if (device.decision==="denied") return c.json({error:"access_denied"},403);
    if (device.decision==="pending") {
      const update=await c.env.DB.prepare("UPDATE cli_device_authorizations SET next_poll_at=? WHERE device_hash=? AND next_poll_at<=?")
        .bind(now+POLL_INTERVAL,deviceHash,now).run();
      if (!update.meta.changes) {c.header("retry-after","5");return c.json({error:"slow_down"},429);}
      return c.json({error:"authorization_pending"},202);
    }
    const token=await accountToken(body.deviceCode,c.env.SESSION_SECRET);
    const tokenHash=await hashCliSecret(token); const id=newId("cli");
    // Deterministic delivery makes a lost poll response safely retryable. A
    // revoked credential is never revived by polling its original device code.
    await c.env.DB.prepare(`INSERT INTO cli_account_tokens (id,user_id,token_hash,device_hash,label,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(device_hash) DO NOTHING`)
      .bind(id,device.user_id,tokenHash,deviceHash,device.label,now,now+TOKEN_TTL).run();
    const issued=await c.env.DB.prepare("SELECT expires_at,token_hash,revoked_at FROM cli_account_tokens WHERE device_hash=?")
      .bind(deviceHash).first<{expires_at:number;token_hash:string;revoked_at:number|null}>();
    if (!issued || issued.revoked_at!==null || issued.token_hash!==tokenHash || issued.expires_at<=now) return c.json({error:"access_denied"},403);
    return c.json({token,expiresAt:issued.expires_at,scope:"account:read account:write"});
  });

  // Approval, denial and token management require the existing browser session.
  // A CLI token cannot mint credentials or approve another device.
  routes.use("/devices/*",async(c,next)=>{
    if (!c.get("user") || c.get("authKind")!=="session") return c.json({error:"browser_session_required"},401);
    await next();
  });
  routes.get("/devices/:code",async c=>{
    const device=await c.env.DB.prepare("SELECT * FROM cli_device_authorizations WHERE user_code=?").bind(cleanCode(c.req.param("code"))).first<DeviceRow>();
    if (!device || device.expires_at<=Date.now()) return c.json({error:"not_found"},404);
    if (device.user_id && device.user_id!==c.get("user")!.id) return c.json({error:"not_found"},404);
    return c.json({userCode:c.req.param("code").toUpperCase(),label:device.label,expiresAt:device.expires_at,decision:device.decision,scope:"account:read account:write"});
  });
  routes.post("/devices/:code/decision",async c=>{
    if (c.req.header("origin")!==new URL(c.env.APP_URL).origin) return c.json({error:"invalid_origin"},403);
    const body=await c.req.json().catch(()=>null) as {approve?:unknown}|null;
    if (!body || typeof body.approve!=="boolean") return c.json({error:"invalid_decision"},400);
    const result=await c.env.DB.prepare(`UPDATE cli_device_authorizations SET decision=?,user_id=?
      WHERE user_code=? AND expires_at>? AND decision='pending'`)
      .bind(body.approve?"approved":"denied",c.get("user")!.id,cleanCode(c.req.param("code")),Date.now()).run();
    if (!result.meta.changes) return c.json({error:"not_found_or_decided"},409);
    return c.json({ok:true});
  });
  routes.get("/tokens",async c=>{
    if (!c.get("user") || c.get("authKind")!=="session") return c.json({error:"browser_session_required"},401);
    const rows=await c.env.DB.prepare("SELECT id,label,created_at,expires_at,revoked_at FROM cli_account_tokens WHERE user_id=? ORDER BY created_at DESC").bind(c.get("user")!.id).all();
    return c.json({tokens:rows.results});
  });
  routes.post("/tokens/:id/persist",async c=>{
    if (!c.get("user") || c.get("authKind")!=="session") return c.json({error:"browser_session_required"},401);
    if (c.req.header("origin")!==new URL(c.env.APP_URL).origin) return c.json({error:"invalid_origin"},403);
    const body=await c.req.json().catch(()=>null) as Record<string,unknown>|null;
    if (!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).length!==1 || body.persistent!==true) return c.json({error:"invalid_lifetime_request"},400);
    const result=await c.env.DB.prepare(`UPDATE cli_account_tokens SET expires_at=?
      WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`)
      .bind(CLI_PERSISTENT_EXPIRY,c.req.param("id"),c.get("user")!.id,Date.now()).run();
    if (!result.meta.changes) return c.json({error:"active_token_not_found"},404);
    return c.json({expiresAt:CLI_PERSISTENT_EXPIRY,scope:"account:read account:write"});
  });
  routes.delete("/tokens/:id",async c=>{
    if (!c.get("user")) return c.json({error:"auth_required"},401);
    if (c.get("authKind")==="cli" && c.req.param("id")!==c.get("cliTokenId")) return c.json({error:"not_found"},404);
    if (c.get("authKind")==="session" && c.req.header("origin")!==new URL(c.env.APP_URL).origin) return c.json({error:"invalid_origin"},403);
    await c.env.DB.prepare("UPDATE cli_account_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?").bind(Date.now(),c.req.param("id"),c.get("user")!.id).run();
    return c.json({ok:true});
  });
  routes.post("/logout",async c=>{
    if (c.get("authKind")!=="cli") return c.json({error:"cli_token_required"},401);
    await c.env.DB.prepare("UPDATE cli_account_tokens SET revoked_at=? WHERE id=?").bind(Date.now(),c.get("cliTokenId")).run();
    return c.json({ok:true});
  });
  return routes;
}
