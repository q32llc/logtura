import { providerFamily, type ProviderDescriptor, type ProviderDriver } from "@logtura/core";
import { getProvider } from "./registry";
import { spawnSync } from "node:child_process";
import type { DiscoveredSource } from "@logtura/core";
import {
  verifyCfCredentials,
  type CloudflareCredentials,
} from "@logtura/cloudflare-shared";
import { cloudflareWorkerTailDriver } from "@logtura/driver-cloudflare-worker-tail";
import { cloudflareAiGatewayDriver } from "@logtura/driver-cloudflare-ai-gateway";
import { flyLogTailDriver } from "@logtura/driver-fly-log-tail";
import { railwayLogsDriver, getRailwayProjectTokenScope } from "@logtura/driver-railway-logs";
import { vercelLogsDriver } from "@logtura/driver-vercel-logs";
import { confirm, ask, askSecret, openBrowser } from "./prompt";
import type { CloudflarePermissionGroup } from "./source-metadata";

export interface ConnectOptions {
  quiet?: boolean;
  force?: boolean;
  token?: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectEnv {
  values: Map<string, string>;
}

export interface ConnectedProvider {
  skipped?: boolean;
  provider: string;
  providerName: string;
  displayName: string;
  accountId: string | null;
  envValues: Record<string, string>;
  sources: Array<{
    id: string;
    source: string;
    items: DiscoveredSource[];
    discoveryFailed?: true;
  }>;
}

export interface ProviderConnector {
  id: string;
  connect(input: {
    name: string;
    env: ConnectEnv;
    options: ConnectOptions;
  }): Promise<ConnectedProvider>;
}

export function getProviderConnector(provider: string): ProviderConnector | null {
  if (Object.hasOwn(CONNECTORS, provider)) return CONNECTORS[provider]!;
  const descriptor = providerFamily(provider);
  const driver = descriptor && getProvider(descriptor.id);
  return descriptor && driver && descriptor.credentials.some(field => field.env) ? tokenProviderConnector(descriptor, driver) : null;
}

const CONNECTORS: Record<string, ProviderConnector> = {
  cloudflare: cloudflareConnector(),
  fly: flyConnector(),
  railway: simpleTokenConnector({
    id: "railway",
    tokenEnv: "RAILWAY_API_TOKEN",
    tokenPage: "https://railway.com/account/tokens",
    verify: async (apiToken) => railwayLogsDriver.verifyCredentials({ apiToken }),
    resolveAccountId: async (apiToken, accountId) => {
      if (accountId.includes(":")) return accountId;
      const scope = await getRailwayProjectTokenScope(apiToken);
      return scope?.environmentId === accountId ? `${scope.projectId}:${accountId}` : `${accountId}:`;
    },
    discover: (apiToken, accountId) => railwayLogsDriver.discoverSources({ credentials: { apiToken }, accountId: accountId ?? "" }),
    sourceDrivers: ["railway-logs"],
  }),
  vercel: simpleTokenConnector({
    id: "vercel",
    tokenEnv: "VERCEL_API_TOKEN",
    tokenPage: "https://vercel.com/account/tokens",
    verify: async (apiToken) => vercelLogsDriver.verifyCredentials({ apiToken }),
    resolveAccountId: async (_token, _accountId, options) => options.accountId ?? null,
    discover: (apiToken, accountId) => vercelLogsDriver.discoverSources({ credentials: { apiToken }, accountId: accountId ?? "" }),
    sourceDrivers: ["vercel-logs"],
  }),
};

/** Generic single-token connector for contributed providers; no host switch. */
export function tokenProviderConnector(descriptor: ProviderDescriptor, driver: ProviderDriver): ProviderConnector {
  const field = descriptor.credentials.find(field => field.env);
  if (!field?.env) throw new Error(`Provider ${descriptor.id} needs a credential environment field`);
  return simpleTokenConnector({
    id: descriptor.family,
    tokenEnv: field.env,
    tokenPage: descriptor.tokenPage ?? "",
    verify: token => driver.verifyCredentials({ [field.runtime]: token }),
    discover: (token, accountId) => driver.discoverSources({ credentials: { [field.runtime]: token }, accountId: accountId ?? "" }),
    sourceDrivers: [driver.id],
  });
}

function cloudflareConnector(): ProviderConnector {
  return {
    id: "cloudflare",
    async connect({ name, env, options }) {
      let token: string;
      try {
        token = await acquireSecret({
        env,
        envName: "CLOUDFLARE_API_TOKEN",
        explicit: options.token,
        quiet: options.quiet,
        force: options.force,
        tokenPage: cloudflareTokenTemplateUrl(
          cloudflarePermissionGroups(options.metadata),
        ),
        prompt: "Paste Cloudflare API token: ",
      });
      } catch (err) {
        if (isSkippedSecret(err)) return skippedProvider("cloudflare", name);
        throw err;
      }
      const credentials: CloudflareCredentials = { apiToken: token };
      const accounts = await verifyCfCredentials(credentials);
      const accountId =
        options.accountId ??
        env.values.get("CLOUDFLARE_ACCOUNT_ID") ??
        (await chooseAccount(accounts, options.quiet));
      const displayName =
        accounts.find((a) => a.id === accountId)?.name ?? name;
      const envValues = {
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: accountId,
      };
      const sources = await Promise.all([
        discoverSafely("cloudflare-worker-tail", () =>
          cloudflareWorkerTailDriver.discoverSources({
            credentials,
            accountId,
          }),
        ),
        discoverSafely("cloudflare-ai-gateway", () =>
          cloudflareAiGatewayDriver.discoverSources({
            credentials,
            accountId,
          }),
        ),
      ]);
      return {
        provider: "cloudflare",
        providerName: name,
        displayName,
        accountId,
        envValues,
        sources,
      };
    },
  };
}

function flyConnector(): ProviderConnector {
  return {
    id: "fly",
    async connect({ name, env, options }) {
      let token: string | null;
      try {
        token = options.token || env.values.get("FLY_API_TOKEN") || process.env.FLY_API_TOKEN
          ? await acquireSecret({ env, envName: "FLY_API_TOKEN", explicit: options.token, quiet: options.quiet, force: options.force, prompt: "Paste Fly token: " })
          : shellOut("fly", ["auth", "token"]);
      } catch (err) {
        if (isSkippedSecret(err)) return skippedProvider("fly", name);
        throw err;
      }
      if (!token) {
        if (options.quiet) throw new Error("Fly token missing; run fly auth login or pass --token");
        console.log("No token, skipping FLY_API_TOKEN.");
        return skippedProvider("fly", name);
      }
      const accounts = await flyLogTailDriver.verifyCredentials({ apiToken: token });
      const accountId =
        options.accountId ??
        env.values.get("FLY_ORG") ??
        (await chooseAccount(accounts, options.quiet));
      const sources = [
        await discoverSafely("fly-log-tail", () =>
          flyLogTailDriver.discoverSources({
            credentials: { apiToken: token },
            accountId,
          }),
        ),
      ];
      return {
        provider: "fly",
        providerName: name,
        displayName: accountId,
        accountId,
        envValues: { FLY_API_TOKEN: token },
        sources,
      };
    },
  };
}

function simpleTokenConnector(input: {
  id: string;
  tokenEnv: string;
  tokenPage: string;
  verify: (token: string) => Promise<Array<{ id: string; name: string }>>;
  resolveAccountId?: (token: string, accountId: string, options: ConnectOptions) => Promise<string | null>;
  discover: (token: string, accountId: string | null) => Promise<DiscoveredSource[]>;
  sourceDrivers: string[];
}): ProviderConnector {
  return {
    id: input.id,
    async connect({ name, env, options }) {
      let token: string;
      try {
        token = await acquireSecret({
        env,
        envName: input.tokenEnv,
        explicit: options.token,
        quiet: options.quiet,
        force: options.force,
        tokenPage: input.tokenPage,
        prompt: `Paste ${input.id} token: `,
      });
      } catch (err) {
        if (isSkippedSecret(err)) return skippedProvider(input.id, name);
        throw err;
      }
      const accounts = await input.verify(token);
      const selectedAccountId =
        options.accountId ?? (await chooseAccount(accounts, options.quiet));
      const accountId = input.resolveAccountId ? await input.resolveAccountId(token, selectedAccountId, options) : selectedAccountId;
      return {
        provider: input.id,
        providerName: name,
        displayName: accounts.find((a) => a.id === selectedAccountId)?.name ?? name,
        accountId,
        envValues: { [input.tokenEnv]: token },
        sources: await Promise.all(input.sourceDrivers.map(source => discoverSafely(source, () => input.discover(token, accountId)))),
      };
    },
  };
}

function skippedProvider(provider: string, name: string): ConnectedProvider {
  return {
    skipped: true,
    provider,
    providerName: name,
    displayName: name,
    accountId: null,
    envValues: {},
    sources: [],
  };
}

async function acquireSecret(input: {
  env: ConnectEnv;
  envName: string;
  explicit?: string;
  quiet?: boolean;
  force?: boolean;
  tokenPage?: string;
  prompt: string;
}): Promise<string> {
  const existing = input.env.values.get(input.envName) ?? process.env[input.envName];
  if (input.explicit) {
    if (existing && existing !== input.explicit && !input.force) {
      if (input.quiet) {
        throw new Error(`${input.envName} already exists; pass --force to overwrite`);
      }
      const ok = await confirm(`${input.envName} already exists. Overwrite it?`, false);
      if (!ok) return existing;
    }
    return input.explicit;
  }
  if (existing) {
    if (input.quiet) return existing;
    const ok = await confirm(`Found ${input.envName} in .env/environment. Use it?`, true);
    if (ok) return existing;
  }
  if (input.quiet) throw new Error(`${input.envName} is missing`);
  if (input.tokenPage) {
    console.log(`Opening token page for ${input.envName}:`);
    console.log(input.tokenPage);
    openBrowser(input.tokenPage);
  }
  const pasted = (await askSecret(input.prompt)).trim();
  if (!pasted) {
    console.log(`No token, skipping ${input.envName}.`);
    throw new SkippedSecretError(input.envName);
  }
  return pasted;
}

class SkippedSecretError extends Error {
  constructor(envName: string) {
    super(`skipped ${envName}`);
    this.name = "SkippedSecretError";
  }
}

function isSkippedSecret(err: unknown): boolean {
  return err instanceof SkippedSecretError;
}

async function chooseAccount(
  accounts: Array<{ id: string; name: string }>,
  quiet?: boolean,
): Promise<string> {
  if (accounts.length === 0) throw new Error("provider returned no accounts");
  if (accounts.length === 1 || quiet) return accounts[0]!.id;
  console.log("Available accounts:");
  accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} (${a.id})`));
  const raw = await ask("Choose account [1]: ");
  const idx = raw.trim() ? Number(raw.trim()) - 1 : 0;
  return accounts[idx]?.id ?? accounts[0]!.id;
}

async function discoverSafely(
  source: string,
  fn: () => Promise<DiscoveredSource[]>,
): Promise<{ id: string; source: string; items: DiscoveredSource[]; discoveryFailed?: true }> {
  try {
    return { id: source, source, items: await fn() };
  } catch (err) {
    console.warn(
      `could not discover ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { id: source, source, items: [], discoveryFailed: true };
  }
}

function shellOut(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function cloudflareTokenTemplateUrl(groups?: CloudflarePermissionGroup[]): string {
  const permissionGroupKeys = groups?.length
    ? dedupeCloudflareGroups(groups)
    : [
    { key: "workers_scripts", type: "read" },
    { key: "workers_tail", type: "read" },
    { key: "ai_gateway", type: "read" },
      ];
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(permissionGroupKeys),
    accountId: "*",
    zoneId: "all",
    name: "logt",
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`;
}

function dedupeCloudflareGroups(
  groups: CloudflarePermissionGroup[],
): CloudflarePermissionGroup[] {
  const seen = new Set<string>();
  const out: CloudflarePermissionGroup[] = [];
  for (const g of groups) {
    const key = `${g.key}:${g.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

function cloudflarePermissionGroups(
  metadata: Record<string, unknown> | undefined,
): CloudflarePermissionGroup[] | undefined {
  const raw = metadata?.permissionGroups;
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((item): item is CloudflarePermissionGroup => {
    return (
      !!item &&
      typeof item === "object" &&
      "key" in item &&
      "type" in item &&
      typeof item.key === "string" &&
      (item.type === "read" || item.type === "edit")
    );
  });
}
