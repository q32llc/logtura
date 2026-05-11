/**
 * Shared Supabase Management API plumbing.
 *
 * Auth: Personal Access Token (PAT) from
 *   https://supabase.com/dashboard/account/tokens
 * sent as `Authorization: Bearer <token>` against
 *   https://api.supabase.com
 *
 * Today only `driver-supabase-edge-logs` consumes this, but the
 * postgres / auth / storage log surfaces all hang off the same PAT
 * + analytics endpoints — when a second supabase driver lands the
 * helpers stay here and the driver-side surface stays slim.
 */
import {
  type EnvVarSpec,
  type ProviderAccount,
  ProviderError,
} from "@logtura/core";

export const SB_BASE = "https://api.supabase.com";

export interface SupabaseCredentials {
  pat: string;
}

interface SbErrorBody {
  message?: string;
  error?: string;
}

/** Fetch helper that handles the Management API's two error shapes
 *  ({message: ...} on most endpoints, {error: ...} on a few) and
 *  surfaces a useful ProviderError on non-2xx. */
export async function sbFetch<T>(
  path: string,
  pat: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${SB_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${pat}`,
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as SbErrorBody;
      msg = body.message ?? body.error ?? msg;
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    throw new ProviderError(msg, res.status);
  }
  return JSON.parse(text) as T;
}

export interface SupabaseProject {
  id: string;
  name: string;
  /** 20-char project ref — what every log/management endpoint
   *  keys off. */
  ref: string;
  organization_id?: string;
  region?: string;
}

/** Hits GET /v1/projects to list every project the PAT can reach.
 *  The Management API doesn't offer a `/me` endpoint we can use
 *  for a separate "is the token valid?" probe — a successful
 *  project list IS the validity proof. */
export async function listSupabaseProjects(
  pat: string,
): Promise<SupabaseProject[]> {
  return sbFetch<SupabaseProject[]>("/v1/projects", pat);
}

export async function verifySupabaseCredentials(
  creds: SupabaseCredentials,
): Promise<ProviderAccount[]> {
  const projects = await listSupabaseProjects(creds.pat);
  if (projects.length === 0) {
    throw new ProviderError(
      "Supabase PAT has no visible projects",
      403,
    );
  }
  // accountId == project ref. The Management API is uniformly
  // keyed on `ref`, so storing it here lines up with every
  // downstream request the driver makes.
  return projects.map((p) => ({ id: p.ref, name: p.name }));
}

/** Runtime spec helper — every supabase-* driver needs the PAT and
 *  the project ref in the forwarder's env. `extraEnvVars` lets the
 *  caller add driver-specific envs alongside. */
export function sbRuntimeSpec(input: {
  helpUrl: string;
  extraEnvVars?: EnvVarSpec[];
}): { envVars: EnvVarSpec[]; dockerfileDeps: never[] } {
  return {
    envVars: [
      {
        name: "SUPABASE_PAT",
        description: "Supabase Personal Access Token used by this source.",
        source: "credential",
        credentialPath: "pat",
        helpUrl: input.helpUrl,
      },
      {
        name: "SUPABASE_PROJECT_REF",
        description: "Supabase project ref for the connected project.",
        source: "external_account_id",
      },
      ...(input.extraEnvVars ?? []),
    ],
    // Management-API drivers all use Vector's built-in http_client
    // source; no docker install needed.
    dockerfileDeps: [],
  };
}

/** Sanitize an externalId-like string for use as a Vector
 *  component key. Same pattern as cloudflare-shared's safeKey. */
export function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}
