export interface ProviderOAuthState {state: string; userId: string; displayName: string; verifier: string; reconnectId?: string | null}
/** Signed state is still parsed as untrusted structure before database scope
 * checks or provider token exchange. */
export function readProviderOAuthState(json: string, expectedState: string): ProviderOAuthState | null {
 try {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string,unknown>;
  if (state.state !== expectedState || typeof state.userId !== "string" || !state.userId
    || typeof state.displayName !== "string" || !state.displayName
    || typeof state.verifier !== "string" || !state.verifier
    || (state.reconnectId !== undefined && state.reconnectId !== null && (typeof state.reconnectId !== "string" || !state.reconnectId))) return null;
  return state as unknown as ProviderOAuthState;
 } catch {return null;}
}
