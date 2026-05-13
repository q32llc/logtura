import type { QueueEnvelope } from "./jobs/types";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS_QUEUE: Queue<QueueEnvelope>;
  APP_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  // Optional — only set if the Slack destination driver should work.
  // The corresponding Slack app must register the redirect URI
  // <APP_URL>/api/destinations/slack/callback and request the
  // `incoming-webhook` scope.
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  // Optional — enables OAuth for the supabase-edge-logs provider.
  // When unset, the provider falls back to its PAT-paste flow.
  // The Supabase Integration must register the redirect URI
  // <APP_URL>/api/providers/supabase-edge-logs/callback and request
  // Read scopes for Projects, Edge Functions, and Analytics.
  SUPABASE_CLIENT_ID?: string;
  SUPABASE_CLIENT_SECRET?: string;
  // Optional — enables OAuth for the Vercel platform. The Vercel
  // app/integration should register
  // <APP_URL>/api/providers/vercel/callback.
  VERCEL_CLIENT_ID?: string;
  VERCEL_CLIENT_SECRET?: string;
  // Optional — silence-alert emails are sent via Postmark when these
  // are configured. Without them, the cron alerter still flips
  // status='crashed' but skips email.
  POSTMARK_API_KEY?: string;
  FROM_EMAIL?: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    user?: {
      id: string;
      githubLogin: string;
      email: string | null;
      name: string | null;
      avatarUrl: string | null;
    };
  };
};
