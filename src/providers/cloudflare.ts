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

// Cloudflare's prefilled token-creation URL. We only include
// permission groups whose keys are confirmed working from the
// Cloudflare docs (workers_scripts). AI Gateway:Read is a real
// permission but its template-URL key isn't documented, so we ask the
// user to add that one manually if they use AI Gateway. Discovery
// soft-fails per resource, so a Workers-only token still yields a
// working pipeline.
const PERMISSION_GROUPS = [{ key: "workers_scripts", type: "read" }];

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
      "Opens Cloudflare with Workers Scripts:Read pre-selected. If you also want AI Gateway logs, click Add more in the form and pick AI Gateway:Read before continuing. Then click Continue → Create Token and paste the token below.",
    pasteFieldName: "api_token",
    manualInstructions:
      "If you'd rather create the token yourself, go to dash.cloudflare.com/profile/api-tokens and create a custom token with Workers Scripts:Read (required) and AI Gateway:Read (optional, only if you want to forward AI Gateway logs).",
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

  async checkCredentialFreshness(creds) {
    // Cloudflare's /user/tokens/verify returns status + optional
    // expires_on. We treat the token as stale when it's not active or
    // is within 24h of expiring — short enough that the user would
    // hit a runtime failure soon, long enough that we don't pester
    // them on every bundle fetch for a token good for another year.
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
        reason:
          err instanceof Error
            ? `verify failed: ${err.message}`
            : "verify failed",
        expiresAt: null,
      };
    }
    if (info.status !== "active") {
      return { fresh: false, reason: `status: ${info.status}`, expiresAt: null };
    }
    const expiresAt = info.expires_on
      ? Date.parse(info.expires_on) || null
      : null;
    if (expiresAt !== null) {
      const oneDay = 24 * 60 * 60 * 1000;
      if (expiresAt - Date.now() < oneDay) {
        return {
          fresh: false,
          reason:
            expiresAt < Date.now()
              ? "expired"
              : "expiring within 24 hours",
          expiresAt,
        };
      }
    }
    return { fresh: true, expiresAt };
  },

  async discoverSources({ credentials, accountId }): Promise<DiscoveredSource[]> {
    // Soft-fail per resource so a Workers-only token still produces
    // workers, and an AI-Gateway-only token still produces gateways.
    // Only hard-fail if both calls failed (the connection is then
    // genuinely useless and we want the user to know).
    const errors: { kind: string; error: ProviderError }[] = [];

    const tryList = async <T>(
      kind: string,
      path: string,
    ): Promise<T[]> => {
      try {
        return await cfFetch<T[]>(path, credentials.apiToken);
      } catch (err) {
        if (err instanceof ProviderError) {
          errors.push({ kind, error: err });
          return [];
        }
        throw err;
      }
    };

    const [workers, gateways] = await Promise.all([
      tryList<CfWorkerScript>(
        "Workers Scripts",
        `/accounts/${accountId}/workers/scripts`,
      ),
      tryList<CfAiGateway>(
        "AI Gateway",
        `/accounts/${accountId}/ai-gateway/gateways`,
      ),
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

    if (sources.length === 0 && errors.length === 2) {
      const summary = errors
        .map((e) => `${e.kind}: ${e.error.message}`)
        .join("; ");
      throw new ProviderError(
        `Could not list any log sources. Check that the token has Workers Scripts:Read for this account. (${summary})`,
        403,
      );
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
      return {
        key,
        yaml,
        normalize: { key: `${key}_norm`, yaml: workerNormalizeYaml(key) },
      };
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
      return {
        key,
        yaml,
        normalize: { key: `${key}_norm`, yaml: aiGatewayNormalizeYaml(key) },
      };
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
          // Same template URL the connect-flow uses; lets the bundle
          // UI offer "create a new one →" for rotation without
          // forcing the user to remember which scopes to set.
          helpUrl: TOKEN_TEMPLATE_URL,
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

/**
 * VRL that flattens a `wrangler tail --format json` event into the
 * uniform shape the rest of the pipeline expects:
 *   .message  — joined string of console.log + exception messages
 *   .level    — "error" | "info"
 *   .error    — bool
 *   .script   — Worker name
 *   .timestamp — original eventTimestamp (ms epoch)
 *
 * CF tail event shape (top-level): outcome, scriptName, exceptions[],
 * logs[{message[], level}], event, eventTimestamp.
 */
function workerNormalizeYaml(sourceKey: string): string {
  const vrl = [
    `.script = string(.scriptName) ?? "worker"`,
    `.timestamp = .eventTimestamp`,
    // length() on an array can't fail in VRL, so no trailing `?? 0`.
    // Vector rejects the unnecessary coalescing as a config error.
    `exc_count = length(array(.exceptions) ?? [])`,
    `outcome = string(.outcome) ?? "ok"`,
    `.error = exc_count > 0 || outcome != "ok"`,
    `.level = if .error { "error" } else { "info" }`,
    `parts = []`,
    `for_each(array(.logs) ?? []) -> |_, log| {`,
    `  for_each(array(log.message) ?? []) -> |_, m| {`,
    `    s = if is_string(m) { string!(m) } else { encode_json(m) }`,
    `    parts = push(parts, s)`,
    `  }`,
    `}`,
    `for_each(array(.exceptions) ?? []) -> |_, ex| {`,
    `  name = string(ex.name) ?? "Error"`,
    `  msg = string(ex.message) ?? ""`,
    `  parts = push(parts, name + ": " + msg)`,
    `}`,
    `.message = if length(parts) > 0 { join!(parts, " | ") } else { "" }`,
  ];
  return [
    "    type: remap",
    `    inputs: ["${sourceKey}"]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}

/**
 * AI Gateway log entries (from /accounts/.../ai-gateway/gateways/.../logs)
 * have a richer schema; normalize the parts that map cleanly. The
 * endpoint returns {result: [...]} so this VRL also handles array
 * unwrapping by keeping events as-is when they're already records.
 *
 * AI Gateway log shape: {id, success, status_code, request_*, model,
 * provider, response_status_code, ...}
 */
function aiGatewayNormalizeYaml(sourceKey: string): string {
  const vrl = [
    `.script = string(.provider) ?? "ai-gateway"`,
    `.timestamp = .created_at`,
    `success = bool(.success) ?? true`,
    `status = int(.status_code) ?? 200`,
    `.error = !success || status >= 500`,
    `.level = if .error { "error" } else { "info" }`,
    `model = string(.model) ?? "?"`,
    `.message = "ai_gateway " + model + " status=" + to_string(status)`,
  ];
  return [
    "    type: remap",
    `    inputs: ["${sourceKey}"]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}

// Re-export the source ref type so call sites can import from one place.
export type { SourceRef };
