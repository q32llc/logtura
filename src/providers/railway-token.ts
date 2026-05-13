import type { RailwayCredentials } from "@logtura/driver-railway-logs";
import {
  type ConnectionRow,
  decryptConnectionCredentials,
  updateConnectionCredentials,
} from "../db";
import type { Env } from "../env";
import { refreshRailwayToken } from "./railway-oauth";

const REFRESH_SKEW_MS = 60_000;

export async function ensureFreshRailwayAccessToken(
  env: Env,
  conn: ConnectionRow,
): Promise<string> {
  const creds = await decryptConnectionCredentials<RailwayCredentials>(env, conn);
  if (!creds.refreshToken) return creds.apiToken;
  if (creds.expiresAt && creds.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return creds.apiToken;
  }
  if (!env.RAILWAY_CLIENT_ID || !env.RAILWAY_CLIENT_SECRET) {
    throw new Error("Railway OAuth client not configured; cannot refresh");
  }
  const body = await refreshRailwayToken({
    clientId: env.RAILWAY_CLIENT_ID,
    clientSecret: env.RAILWAY_CLIENT_SECRET,
    refreshToken: creds.refreshToken,
  });
  const next: RailwayCredentials = {
    ...creds,
    apiToken: body.access_token,
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  await updateConnectionCredentials(env.DB, env, conn.user_id, conn.id, {
    credentials: next,
  });
  return next.apiToken;
}
