import type { RailwayCredentials } from "@logtura/driver-railway-logs";
import {
  type ConnectionRow,
  decryptConnectionCredentials,
  refreshConnectionCredentials,
  getConnection,
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
  if(!await refreshConnectionCredentials(env.DB,env,conn,next)){
    const current=await getConnection(env.DB,conn.user_id,conn.id);if(!current || current.provider!==conn.provider)throw new Error("Connection changed during OAuth renewal");
    const latest=await decryptConnectionCredentials<RailwayCredentials>(env,current);
    if(!latest.refreshToken || (latest.expiresAt && latest.expiresAt>Date.now()+REFRESH_SKEW_MS))return latest.apiToken;
    throw new Error("Credentials changed during OAuth renewal; retry");
  }
  return next.apiToken;
}
