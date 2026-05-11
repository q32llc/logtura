/**
 * Shared bits between the two Cloudflare source drivers
 * (`cloudflare-worker-tail` and `cloudflare-ai-gateway`). Each
 * driver is one transport / one event shape; what they have in
 * common is the auth surface (a Cloudflare API token) — token
 * verification, account listing, freshness check, env-var
 * declarations. Lives here so each driver doesn't fork the same
 * cfFetch helper.
 */
import {
  type ConnectionRef,
  type DockerfileDep,
  type EnvVarSpec,
  type FormField,
  type ProviderAccount,
  ProviderError,
} from "./types";

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

export const CF_FORM_FIELDS: readonly FormField[] = [
  {
    name: "api_token",
    label: "Paste the token Cloudflare gave you",
    type: "password",
    placeholder: "cfat_...",
    description:
      "After clicking Continue → Create Token in Cloudflare, copy the token and paste it here.",
    required: true,
  },
  {
    name: "account_id",
    label: "Account ID",
    type: "text",
    placeholder: "auto-detect from token if blank",
    description:
      "Leave blank to auto-detect the first account the token can access.",
    required: false,
  },
];

export function parseCfFormData(form: FormData): {
  credentials: CloudflareCredentials;
  explicitAccountId: string | null;
} {
  const apiToken = String(form.get("api_token") ?? "").trim();
  const accountId = String(form.get("account_id") ?? "").trim();
  if (!apiToken) {
    throw new ProviderError("Missing api_token", 400);
  }
  return {
    credentials: { apiToken },
    explicitAccountId: accountId || null,
  };
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
 *  token + account id env vars. Each driver returns this from its
 *  runtimeSpec(). `helpUrl` differs per driver because each
 *  documents its own required permission groups. */
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
            aptPackages: ["curl", "ca-certificates", "gnupg"],
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
