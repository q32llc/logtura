/**
 * Connection-scoped tail tokens.
 *
 * The deployed forwarder's logtura-http-client binary uses one of
 * these to call back into the SaaS `/api/tail/supabase/token`
 * endpoint. Same shape as our session cookies — HMAC-signed JSON
 * blob with no expiry. Revocation is implicit: deleting the
 * connection invalidates every token signed for it, since the
 * endpoint resolves the connectionId on every request.
 *
 * Signed with SESSION_SECRET because the worker already has that
 * binding and it's not tied to a specific cookie surface.
 */
import { signCookie, verifyCookie } from "../crypto";

export interface TailTokenPayload {
  connectionId: string;
  userId: string;
}

export async function mintTailToken(
  payload: TailTokenPayload,
  secret: string,
): Promise<string> {
  return signCookie(JSON.stringify(payload), secret);
}

export async function verifyTailToken(
  token: string | undefined,
  secret: string,
): Promise<TailTokenPayload | null> {
  const json = await verifyCookie(token, secret);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<TailTokenPayload>;
    if (typeof parsed.connectionId !== "string" || typeof parsed.userId !== "string") {
      return null;
    }
    return { connectionId: parsed.connectionId, userId: parsed.userId };
  } catch {
    return null;
  }
}
