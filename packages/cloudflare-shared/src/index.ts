/**
 * Cloudflare API token plumbing shared between cloudflare-* drivers.
 * Auth (verify, freshness) + the runtime env var spec. Form schemas
 * and FormData parsing live host-side in the SaaS connect adapter.
 */
import {
  type ConnectionRef,
  type DockerfileDep,
  type EnvVarSpec,
  type ProviderAccount,
  ProviderError,
} from "@logtura/core";

export const CF_BASE = "https://api.cloudflare.com/client/v4";

export interface CloudflareCredentials {
  apiToken: string;
}

interface CfResponse<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

interface CfTokenInfo {
  id: string;
  status: string;
}

interface CfAccount {
  id: string;
  name: string;
}

export async function cfFetch<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${CF_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json()) as CfResponse<T>;
  if (!res.ok || !json.success) {
    const msg =
      json.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
    throw new ProviderError(msg, res.status);
  }
  return json.result;
}

export async function verifyCfCredentials(
  creds: CloudflareCredentials,
): Promise<ProviderAccount[]> {
  await cfFetch<CfTokenInfo>("/user/tokens/verify", creds.apiToken);
  const accounts = await cfFetch<CfAccount[]>(
    "/accounts?per_page=50",
    creds.apiToken,
  );
  return accounts.map((a) => ({ id: a.id, name: a.name }));
}

export async function checkCfCredentialFreshness(
  creds: CloudflareCredentials,
): Promise<{ fresh: boolean; reason?: string; expiresAt?: number | null }> {
  interface VerifyInfo {
    id: string;
    status: string;
    expires_on?: string | null;
  }
  let info: VerifyInfo;
  try {
    info = await cfFetch<VerifyInfo>("/user/tokens/verify", creds.apiToken);
  } catch (err) {
    return {
      fresh: false,
      reason: err instanceof Error ? `verify failed: ${err.message}` : "verify failed",
      expiresAt: null,
    };
  }
  if (info.status !== "active") {
    return { fresh: false, reason: `status: ${info.status}`, expiresAt: null };
  }
  const expiresAt = info.expires_on ? Date.parse(info.expires_on) || null : null;
  if (expiresAt !== null) {
    const oneDay = 24 * 60 * 60 * 1000;
    if (expiresAt - Date.now() < oneDay) {
      return {
        fresh: false,
        reason: expiresAt < Date.now() ? "expired" : "expiring within 24 hours",
        expiresAt,
      };
    }
  }
  return { fresh: true, expiresAt };
}

/** Common runtime spec — both CF transports need the same API
 *  token + account id env vars. Each driver passes its own
 *  `helpUrl` because each documents its own required permission
 *  groups. */
export function cfRuntimeSpec(input: {
  helpUrl: string;
  extraDockerInstall?: string;
}): { envVars: EnvVarSpec[]; dockerfileDeps: DockerfileDep[] } {
  return {
    envVars: [
      {
        name: "CLOUDFLARE_API_TOKEN",
        description: "Cloudflare API token used by this source.",
        source: "credential",
        credentialPath: "apiToken",
        helpUrl: input.helpUrl,
      },
      {
        name: "CLOUDFLARE_ACCOUNT_ID",
        description: "Cloudflare account ID for the connected account",
        source: "external_account_id",
      },
    ],
    dockerfileDeps: input.extraDockerInstall
      ? [
          {
            install: input.extraDockerInstall,
            // jq is in the worker-tail exec pipeline
            // (`wrangler tail … | jq -c --unbuffered .`).
            aptPackages: ["curl", "ca-certificates", "gnupg", "jq"],
          },
        ]
      : [],
  };
}

export function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function shellQuoteCfWorkerName(s: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`Refusing to shell-interpolate suspicious worker name: ${s}`);
  }
  return s;
}

export type { ConnectionRef };
