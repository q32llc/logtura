/**
 * Server-side Supabase OAuth token freshness.
 *
 * Supabase rotates refresh tokens on every refresh (empirically
 * verified — old refresh token is immediately invalidated). The SaaS
 * holds the authoritative refresh_token in encrypted credentials and
 * updates it after each refresh. Callers ask `ensureFreshAccessToken`
 * for a usable bearer token; the helper refreshes + writes back when
 * the stored one is near expiry.
 *
 * PAT-paste credentials (no `refreshToken` field) are passed through
 * unchanged — they don't expire and don't need rotation.
 */
import type { SupabaseCredentials } from "@logtura/supabase-shared";
import {
  type ConnectionRow,
  decryptConnectionCredentials,
  refreshConnectionCredentials,
  getConnection,
} from "../db";
import type { Env } from "../env";

const TOKEN_URL = "https://api.supabase.com/v1/oauth/token";
const REFRESH_SKEW_MS = 60_000;

export async function ensureFreshAccessToken(
  env: Env,
  conn: ConnectionRow,
): Promise<string> {
  const creds = await decryptConnectionCredentials<SupabaseCredentials>(env, conn);
  // PAT-paste path: no refresh metadata, token is the credential.
  if (!creds.refreshToken) return creds.pat;
  // OAuth path with valid cached access_token.
  if (creds.expiresAt && creds.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return creds.pat;
  }
  if (!env.SUPABASE_CLIENT_ID || !env.SUPABASE_CLIENT_SECRET) {
    throw new Error("Supabase OAuth client not configured; cannot refresh");
  }
  const basic = btoa(`${env.SUPABASE_CLIENT_ID}:${env.SUPABASE_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const next: SupabaseCredentials = {
    pat: body.access_token,
    // Supabase rotates — accept whatever they return; if absent (future
    // change), fall back to the existing one.
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  if(!await refreshConnectionCredentials(env.DB,env,conn,next)){
    const current=await getConnection(env.DB,conn.user_id,conn.id);if(!current || current.provider!==conn.provider)throw new Error("Connection changed during OAuth renewal");
    const latest=await decryptConnectionCredentials<SupabaseCredentials>(env,current);
    if(!latest.refreshToken || (latest.expiresAt && latest.expiresAt>Date.now()+REFRESH_SKEW_MS))return latest.pat;
    throw new Error("Credentials changed during OAuth renewal; retry");
  }
  return next.pat;
}
