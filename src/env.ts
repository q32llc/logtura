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
