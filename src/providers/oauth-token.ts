/** Validate consumed OAuth fields before persisting credentials. Provider bodies
 * never become exception messages: token endpoints may echo private material. */
export interface OAuthTokenFields {access_token: string; refresh_token?: string; expires_in: number; token_type?: string}
export function parseOAuthTokens(text: string, provider: string, requireTokenType = true): OAuthTokenFields {
 let parsed: unknown;
 try {parsed = JSON.parse(text);} catch {throw new Error(`${provider} OAuth token response is not valid JSON`);}
 if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${provider} OAuth token response missing or invalid token fields`);
 const value = parsed as Record<string, unknown>;
 if (typeof value.access_token !== "string" || !value.access_token
   || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0
   || (value.refresh_token !== undefined && (typeof value.refresh_token !== "string" || !value.refresh_token))
   || (requireTokenType && (typeof value.token_type !== "string" || !value.token_type))) throw new Error(`${provider} OAuth token response missing or invalid token fields`);
 return value as unknown as OAuthTokenFields;
}
