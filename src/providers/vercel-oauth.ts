import type { VercelCredentials } from "@logtura/driver-vercel-logs";

const VERCEL_AUTHORIZE_URL = "https://vercel.com/oauth/authorize";
const VERCEL_TOKEN_URL = "https://api.vercel.com/login/oauth/token";
const VERCEL_CONNECT_SCOPES = "openid offline_access";

export interface VercelOAuthTokens {
  access_token: string;
  refresh_token?: string | null;
  id_token?: string | null;
  team_id?: string | null;
  user_id?: string | null;
}

export async function createVercelPkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const codeVerifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return {
    codeVerifier,
    codeChallenge: base64Url(new Uint8Array(digest)),
  };
}

export function buildVercelAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(VERCEL_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", VERCEL_CONNECT_SCOPES);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeVercelCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<VercelOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });
  const res = await fetch(VERCEL_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Vercel OAuth exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text) as Partial<VercelOAuthTokens>;
  if (!parsed.access_token) {
    throw new Error("Vercel OAuth exchange returned no access_token");
  }
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token ?? null,
    id_token: parsed.id_token ?? null,
    team_id: parsed.team_id ?? null,
    user_id: parsed.user_id ?? null,
  };
}

export function vercelCredentialsFromOAuth(
  tokens: VercelOAuthTokens,
): VercelCredentials {
  return { apiToken: tokens.access_token };
}

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
