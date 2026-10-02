import type { VercelCredentials } from "@logtura/driver-vercel-logs";

const VERCEL_INTEGRATIONS_URL = "https://vercel.com/integrations/";
const VERCEL_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";

export interface VercelOAuthTokens {
  access_token: string;
  installation_id?: string | null;
  team_id?: string | null;
  user_id?: string | null;
}

export function buildVercelInstallUrl(input: {
  slug: string;
  state: string;
}): string {
  const slug = input.slug.trim().replace(/^\/+|\/+$/g, "");
  const url = new URL(`${encodeURIComponent(slug)}/new`, VERCEL_INTEGRATIONS_URL);
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
    throw new Error(`Vercel OAuth exchange failed: ${res.status}`);
  }
  let parsed: Partial<VercelOAuthTokens> | null;
  try {parsed = JSON.parse(text) as Partial<VercelOAuthTokens> | null;} catch {throw new Error("Vercel OAuth response is not valid JSON");}
  if (!parsed || typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error("Vercel OAuth exchange returned no access_token");
  }
  for (const key of ["installation_id", "team_id", "user_id"] as const) {
    const value = parsed[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || !value)) throw new Error("Vercel OAuth response has invalid account fields");
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
