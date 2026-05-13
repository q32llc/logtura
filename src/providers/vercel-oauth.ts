import type { VercelCredentials } from "@logtura/driver-vercel-logs";

const VERCEL_AUTHORIZE_URL = "https://vercel.com/oauth/authorize";
const VERCEL_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";

export interface VercelOAuthTokens {
  access_token: string;
  installation_id?: string | null;
  team_id?: string | null;
  user_id?: string | null;
}

export function buildVercelAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(VERCEL_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeVercelCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<VercelOAuthTokens> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
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
    installation_id: parsed.installation_id ?? null,
    team_id: parsed.team_id ?? null,
    user_id: parsed.user_id ?? null,
  };
}

export function vercelCredentialsFromOAuth(
  tokens: VercelOAuthTokens,
): VercelCredentials {
  return { apiToken: tokens.access_token };
}
