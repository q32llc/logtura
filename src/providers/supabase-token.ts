import { parseOAuthTokens } from "./oauth-token";
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

/** Only fixed categories and HTTP status may cross into operational logs. */
export class SupabaseRefreshError extends Error {
  constructor(
    readonly reason: "oauth_not_configured" | "provider_rejected" | "invalid_response" | "network_error",
    readonly status?: number,
    readonly oauthError?: string,
  ) {
    super(reason === "oauth_not_configured"
      ? "Supabase OAuth client not configured; cannot refresh"
      : `Supabase refresh failed (${status ?? reason})`);
  }
}

function safeOAuthError(text: string): string | undefined {
  try {
    const code: unknown = JSON.parse(text)?.error;
    return typeof code === "string" && ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_request", "temporarily_unavailable"].includes(code)
      ? code : undefined;
  } catch { return undefined; }
}

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
    throw new SupabaseRefreshError("oauth_not_configured");
  }
  const basic = btoa(`${env.SUPABASE_CLIENT_ID}:${env.SUPABASE_CLIENT_SECRET}`);
  let res: Response;
  let text: string;
  try {
    res = await fetch(TOKEN_URL, {
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
    text = await res.text();
  } catch {
    throw new SupabaseRefreshError("network_error");
  }
  if (!res.ok) {
    throw new SupabaseRefreshError("provider_rejected", res.status, safeOAuthError(text));
  }
  let body: ReturnType<typeof parseOAuthTokens>;
  try { body = parseOAuthTokens(text, "Supabase", false); }
  catch { throw new SupabaseRefreshError("invalid_response", res.status); }
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
