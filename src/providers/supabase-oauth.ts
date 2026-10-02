import { parseOAuthTokens } from "./oauth-token";
/**
 * Supabase OAuth (Build-a-Supabase-Integration) helpers.
 *
 * Authorization: https://api.supabase.com/v1/oauth/authorize
 * Token:         https://api.supabase.com/v1/oauth/token  (Basic auth)
 *
 * The token exchange is RFC-6749 standard: POST form-urlencoded with
 * grant_type=authorization_code, code, redirect_uri, code_verifier
 * (PKCE) — and HTTP Basic with the client_id/secret.
 *
 * Tokens are short-lived. Treat `expires_in` as authoritative; the
 * caller stores it as a unix-ms expiry alongside the access + refresh
 * tokens in encrypted credentials.
 */

export const SUPABASE_OAUTH_AUTHORIZE = "https://api.supabase.com/v1/oauth/authorize";
export const SUPABASE_OAUTH_TOKEN = "https://api.supabase.com/v1/oauth/token";

export interface SupabaseTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

/** PKCE: generate a code_verifier (43-128 chars of [A-Z a-z 0-9 ._~-])
 *  and the S256 code_challenge (base64url of SHA-256(verifier)). */
export async function generatePkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64UrlEncode(raw);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(SUPABASE_OAUTH_AUTHORIZE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCodeForToken(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<SupabaseTokenResponse> {
  const basic = btoa(`${input.clientId}:${input.clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const res = await fetch(SUPABASE_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase token exchange failed (${res.status})`);
  }
  return parseOAuthTokens(text, "Supabase") as SupabaseTokenResponse;
}
