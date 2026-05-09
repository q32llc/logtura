import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext, Env } from "./env";
import { newToken, signCookie, verifyCookie } from "./crypto";
import { getUserById, upsertGithubUser } from "./db";

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
  const signed = await signCookie(state, env.SESSION_SECRET);
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
  if (!code || !state || !expected || state !== expected) {
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
  return c.redirect("/app", 303);
}

export function logout(c: Context<AppContext>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/", 303);
}

export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
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
  const cookie = getCookie(c, SESSION_COOKIE);
  const userId = await verifyCookie(cookie, c.env.SESSION_SECRET);
  if (userId) {
    const user = await getUserById(c.env.DB, userId);
    if (user) {
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
