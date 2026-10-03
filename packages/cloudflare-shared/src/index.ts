/**
 * Cloudflare API token plumbing shared between cloudflare-* drivers.
 * Auth (verify, freshness) + the runtime env var spec. Form schemas
 * and FormData parsing are intentionally outside these packages.
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
  expires_on?: string | null;
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
  const { info, account } = await verifyToken(creds);
  if (info.status !== "active") throw new ProviderError(`Token status: ${info.status}`, 401);
  if (account) return [account];
  const accounts = await cfFetch<CfAccount[]>(
    "/accounts?per_page=50",
    creds.apiToken,
  );
  return accounts.map((a) => ({ id: a.id, name: a.name }));
}

async function verifyToken(creds: CloudflareCredentials): Promise<{ info: CfTokenInfo; account?: ProviderAccount }> {
  // Account-owned tokens cannot authenticate at the user-token endpoint. Infer
  // the owning account from the same token, then verify at its documented API.
  // A single deadline bounds discovery and all verification probes together.
  const options = { signal: AbortSignal.timeout(60_000), redirect: "manual" as const };
  try {
    return { info: await cfFetch<CfTokenInfo>("/user/tokens/verify", creds.apiToken, options) };
  } catch (error) {
    if (!(error instanceof ProviderError) || ![401, 403].includes(error.status)) throw error;
  }
  const accounts = await cfFetch<CfAccount[]>("/accounts?per_page=50", creds.apiToken, options);
  if (!Array.isArray(accounts) || accounts.length > 50) throw new ProviderError("Invalid Cloudflare account inventory", 502);
  for (const account of accounts) {
    if (!/^[a-f0-9]{32}$/.test(account.id) || typeof account.name !== "string") throw new ProviderError("Invalid Cloudflare account identity", 502);
    try {
      const info = await cfFetch<CfTokenInfo>(`/accounts/${account.id}/tokens/verify`, creds.apiToken, options);
      return { info, account: { id: account.id, name: account.name } };
    } catch (error) {
      if (!(error instanceof ProviderError) || ![401, 403].includes(error.status)) throw error;
    }
  }
  throw new ProviderError("Token could not be verified for an accessible Cloudflare account", 401);
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
    info = (await verifyToken(creds)).info;
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
  const parsedExpiry = info.expires_on ? Date.parse(info.expires_on) : NaN;
  const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : null;
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
            // Some Cloudflare drivers still contribute shell-based
            // install steps; keep the shared base packages here.
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
