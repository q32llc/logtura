import { parseOAuthTokens } from "./oauth-token";
import type { RailwayCredentials } from "@logtura/driver-railway-logs";

export const RAILWAY_OAUTH_AUTHORIZE =
  "https://backboard.railway.com/oauth/auth";
export const RAILWAY_OAUTH_TOKEN = "https://backboard.railway.com/oauth/token";
export const RAILWAY_OAUTH_SCOPES = "openid project:viewer offline_access";

export interface RailwayTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  scope?: string;
  token_type: string;
}

export async function generateRailwayPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64UrlEncode(raw);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function buildRailwayAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(RAILWAY_OAUTH_AUTHORIZE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", RAILWAY_OAUTH_SCOPES);
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeRailwayCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<RailwayTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  return railwayTokenRequest(input.clientId, input.clientSecret, body);
}

export async function refreshRailwayToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<RailwayTokenResponse> {
  return railwayTokenRequest(
    input.clientId,
    input.clientSecret,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  );
}

export function railwayCredentialsFromOAuth(
  tokens: RailwayTokenResponse,
): RailwayCredentials {
  return {
    apiToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function railwayTokenRequest(
  clientId: string,
  clientSecret: string,
  body: URLSearchParams,
): Promise<RailwayTokenResponse> {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(RAILWAY_OAUTH_TOKEN, {
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
    throw new Error(`Railway OAuth token request failed (${res.status})`);
  }
  return parseOAuthTokens(text, "Railway") as RailwayTokenResponse;
}
