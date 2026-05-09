import {
  type ConnectionRef,
  type DiscoveredSource,
  type DockerfileDep,
  type EnvVarSpec,
  type FormField,
  type ProviderAccount,
  type ProviderDriver,
  ProviderError,
  type SourceBlock,
  type SourceRef,
} from "./types";

const CF_BASE = "https://api.cloudflare.com/client/v4";

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

interface CfWorkerScript {
  id: string;
  modified_on?: string;
}

interface CfAiGateway {
  id: string;
  collect_logs?: boolean;
}

export interface CloudflareCredentials {
  apiToken: string;
}

async function cfFetch<T>(
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

const FORM_FIELDS: readonly FormField[] = [
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

// Cloudflare's prefilled token-creation URL. Sets the right permission
// groups and a suggested name so the user just clicks through.
const PERMISSION_GROUPS = [
  { key: "workers_scripts", type: "read" },
  { key: "ai_gateway", type: "read" },
];

const TOKEN_TEMPLATE_URL = (() => {
  const base = "https://dash.cloudflare.com/profile/api-tokens";
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(PERMISSION_GROUPS),
    accountId: "*",
    zoneId: "all",
    name: "logtura",
  });
  return `${base}?${params.toString()}`;
})();

export const cloudflareDriver: ProviderDriver<CloudflareCredentials> = {
  id: "cloudflare",
  displayName: "Cloudflare",
  connectFlow: {
    kind: "external_token",
    url: TOKEN_TEMPLATE_URL,
    buttonLabel: "Connect with Cloudflare",
    buttonDescription:
      "Opens Cloudflare with the right permissions pre-selected. Click Continue → Create Token, then paste the token below.",
    pasteFieldName: "api_token",
    manualInstructions:
      "If you'd rather create the token yourself, go to dash.cloudflare.com/profile/api-tokens and create a custom token with Workers Scripts:Read and (optionally) AI Gateway:Read.",
  },
  formFields: FORM_FIELDS,

  parseFormData(form) {
    const apiToken = String(form.get("api_token") ?? "").trim();
    const accountId = String(form.get("account_id") ?? "").trim();
    if (!apiToken) {
      throw new ProviderError("Missing api_token", 400);
    }
    return {
      credentials: { apiToken },
      explicitAccountId: accountId || null,
    };
  },

  async verifyCredentials(creds): Promise<ProviderAccount[]> {
    // verify the token is valid first; nicer error than 403 from /accounts
    await cfFetch<CfTokenInfo>("/user/tokens/verify", creds.apiToken);
    const accounts = await cfFetch<CfAccount[]>(
      "/accounts?per_page=50",
      creds.apiToken,
    );
    return accounts.map((a) => ({ id: a.id, name: a.name }));
  },

  async discoverSources({ credentials, accountId }): Promise<DiscoveredSource[]> {
    const [workers, gateways] = await Promise.all([
      cfFetch<CfWorkerScript[]>(
        `/accounts/${accountId}/workers/scripts`,
        credentials.apiToken,
      ).catch((err) => {
        if (err instanceof ProviderError && err.status === 404) return [];
        throw err;
      }),
      cfFetch<CfAiGateway[]>(
        `/accounts/${accountId}/ai-gateway/gateways`,
        credentials.apiToken,
      ).catch((err) => {
        // 404 = account has never used AI Gateway. Treat as no gateways.
        if (err instanceof ProviderError && err.status === 404) return [];
        throw err;
      }),
    ]);

    const sources: DiscoveredSource[] = [];
    for (const w of workers) {
      sources.push({
        sourceKind: "cf_worker",
        externalId: w.id,
        displayName: w.id,
        metadata: { modified_on: w.modified_on ?? null },
      });
    }
    for (const g of gateways) {
      sources.push({
        sourceKind: "cf_ai_gateway",
        externalId: g.id,
        displayName: g.id,
        metadata: { collect_logs: g.collect_logs ?? null },
      });
    }
    return sources;
  },

  generateSourceBlock({ source }): SourceBlock {
    const key = `cf_${source.sourceKind.replace(/^cf_/, "")}_${safeKey(source.externalId)}`;
    if (source.sourceKind === "cf_worker") {
      const yaml = [
        `    type: exec`,
        `    command: ["sh", "-c", "wrangler tail ${shellQuote(source.externalId)} --format json --account-id $CLOUDFLARE_ACCOUNT_ID"]`,
        `    mode: streaming`,
        `    decoding:`,
        `      codec: json`,
      ].join("\n");
      return { key, yaml };
    }
    if (source.sourceKind === "cf_ai_gateway") {
      const yaml = [
        `    type: http_client`,
        `    endpoint: "https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways/${source.externalId}/logs"`,
        `    method: GET`,
        `    interval_secs: 30`,
        `    headers:`,
        `      authorization: "Bearer \${CLOUDFLARE_API_TOKEN}"`,
        `    decoding:`,
        `      codec: json`,
      ].join("\n");
      return { key, yaml };
    }
    throw new Error(`Unknown cloudflare source kind: ${source.sourceKind}`);
  },

  runtimeSpec(_connection: ConnectionRef): {
    envVars: EnvVarSpec[];
    dockerfileDeps: DockerfileDep[];
  } {
    return {
      envVars: [
        {
          name: "CLOUDFLARE_API_TOKEN",
          description: "API token used for wrangler tail and AI Gateway logs",
          source: "credential",
          credentialPath: "apiToken",
        },
        {
          name: "CLOUDFLARE_ACCOUNT_ID",
          description: "Cloudflare account ID for the connected account",
          source: "external_account_id",
        },
      ],
      dockerfileDeps: [
        {
          install:
            "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y --no-install-recommends nodejs && npm install -g wrangler@latest",
          aptPackages: ["curl", "ca-certificates", "gnupg"],
        },
      ],
    };
  },

  sourceKindLabel(kind) {
    if (kind === "cf_worker") return "Worker";
    if (kind === "cf_ai_gateway") return "AI Gateway";
    return kind;
  },
};

function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

function shellQuote(s: string): string {
  // wrangler accepts plain identifiers; reject anything weird up front.
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`Refusing to shell-interpolate suspicious worker name: ${s}`);
  }
  return s;
}

// Re-export the source ref type so call sites can import from one place.
export type { SourceRef };
