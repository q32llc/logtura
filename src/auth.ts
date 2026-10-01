import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext, Env } from "./env";
import { newToken, signCookie, verifyCookie } from "./crypto";
import { getUserById, upsertGithubUser } from "./db";

import { findCliIdentity } from "./cli-auth";

const SESSION_COOKIE = "logtura_session";
const STATE_COOKIE = "logtura_oauth_state";

interface GitHubProfile {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

function authorizeUrl(env: Env, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set(
    "redirect_uri",
    `${env.APP_URL}/auth/github/callback`,
  );
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCode(env: Env, code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) {
    throw new Error(json.error ?? "GitHub token exchange missing token");
  }
  return json.access_token;
}

async function fetchProfile(token: string): Promise<GitHubProfile> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "logtura.dev",
    },
  });
  if (!res.ok) throw new Error(`GitHub profile fetch failed: ${res.status}`);
  const profile = (await res.json()) as GitHubProfile;
  if (!profile.id || !profile.login) {
    throw new Error("GitHub profile missing identity fields");
  }
  return profile;
}

async function fetchPrimaryEmail(token: string): Promise<string | null> {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "logtura.dev",
    },
  });
  if (!res.ok) return null;
  const emails = (await res.json()) as Array<{
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }>;
  return (
    emails.find((e) => e.primary && e.verified)?.email ??
    emails.find((e) => e.verified)?.email ??
    null
  );
}

export async function startGithubLogin(c: Context<AppContext>) {
  const env = c.env;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return c.text("GitHub OAuth not configured", 500);
  }
  const state = newToken();
  const returnTo = safeLoginReturn(c.req.query("return_to"), env.APP_URL);
  const signed = await signCookie(JSON.stringify({nonce: state, returnTo}), env.SESSION_SECRET);
  setCookie(c, STATE_COOKIE, signed, {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  return c.redirect(authorizeUrl(env, state), 303);
}

export async function finishGithubLogin(c: Context<AppContext>) {
  const env = c.env;
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expected = await verifyCookie(
    getCookie(c, STATE_COOKIE),
    env.SESSION_SECRET,
  );
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  let expectedState = expected;
  let returnTo = "/app";
  if (expected) {
    try {
      const payload = JSON.parse(expected) as {nonce?: unknown; returnTo?: unknown};
      expectedState = typeof payload.nonce === "string" ? payload.nonce : null;
      returnTo = safeLoginReturn(payload.returnTo, env.APP_URL);
    } catch { /* accept in-flight state cookies minted by the previous version */ }
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.redirect("/?error=oauth_state", 303);
  }
  const token = await exchangeCode(env, code);
  const profile = await fetchProfile(token);
  const email = profile.email ?? (await fetchPrimaryEmail(token));
  const user = await upsertGithubUser(env.DB, {
    githubId: String(profile.id),
    githubLogin: profile.login,
    email,
    name: profile.name,
    avatarUrl: profile.avatar_url,
  });
  const session = await signCookie(user.id, env.SESSION_SECRET);
  setCookie(c, SESSION_COOKIE, session, {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.redirect(returnTo, 303);
}

export function logout(c: Context<AppContext>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/", 303);
}

export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.get("user")) {await next();return;}
  if (c.req.header("authorization")) return c.json({error: "invalid_account_token"},401);
  const cookie = getCookie(c, SESSION_COOKIE);
  const userId = await verifyCookie(cookie, c.env.SESSION_SECRET);
  if (!userId) return c.redirect("/?error=auth_required", 303);
  const user = await getUserById(c.env.DB, userId);
  if (!user) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/?error=auth_required", 303);
  }
  c.set("user", {
    id: user.id,
    githubLogin: user.github_login,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
  });
  await next();
};

export const attachOptionalUser: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer lt_cli_")) {
    const identity = await findCliIdentity(c.env,authorization);
    if (!identity) return c.json({error:"invalid_account_token"},401);
    c.set("user", {id:identity.id,githubLogin:identity.github_login,email:identity.email,name:identity.name,avatarUrl:identity.avatar_url});
    c.set("authKind","cli");c.set("cliTokenId",identity.cli_token_id);
    await next();return;
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  const userId = await verifyCookie(cookie, c.env.SESSION_SECRET);
  if (userId) {
    const user = await getUserById(c.env.DB, userId);
    if (user) {
      c.set("authKind", "session");
      c.set("user", {
        id: user.id,
        githubLogin: user.github_login,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatar_url,
      });
    }
  }
  await next();
};

function safeLoginReturn(value: unknown, appUrl: string): string {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/app") || value.startsWith("//")) return "/app";
  const url = new URL(value, appUrl);
  if (url.origin !== new URL(appUrl).origin || !(url.pathname === "/app" || url.pathname.startsWith("/app/"))) return "/app";
  return url.pathname + url.search;
}
