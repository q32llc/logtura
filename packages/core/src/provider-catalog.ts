/** Public, runtime-neutral onboarding metadata. No driver imports or secrets. */
export interface CredentialField {
  config: string;
  runtime: string;
  env?: string;
  optional?: boolean;
  /** Source-level identity fields override provider-level credentials. */
  sourceAliases?: readonly string[];
}

export interface ProviderDescriptor {
  id: string;
  family: string;
  package: string;
  displayName: string;
  aliases: readonly string[];
  credentials: readonly CredentialField[];
  accountEnv?: string;
  accountAliases?: readonly string[];
  tokenPage?: string;
  connectMetadata?: Record<string, unknown>;
  selection: {
    field: string;
    aliases?: readonly string[];
    sourceKind: string;
    mode: "all" | "list" | "both";
    codec?: "railway" | "supabase";
    defaults?: Record<string, unknown>;
  };
  runtime: "vector" | "bun" | "custom";
  recipe?: string;
  /** CLI auth specialization; simple token acquisition is the default. */
  connector?: "cloudflare" | "fly" | "railway" | "vercel";
}

const token = (env: string): CredentialField => ({ config: "api_token", runtime: "apiToken", env });
const cf = [token("CLOUDFLARE_API_TOKEN")];
export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  { id: "cloudflare-worker-tail", family: "cloudflare", package: "@logtura/driver-cloudflare-worker-tail", displayName: "Cloudflare Workers", aliases: ["workers", "cloudflare_workers"], credentials: cf, accountEnv: "CLOUDFLARE_ACCOUNT_ID", tokenPage: "https://dash.cloudflare.com/profile/api-tokens", connector: "cloudflare", connectMetadata: { permissionGroups: [{ key: "workers_scripts", type: "read" }, { key: "workers_tail", type: "read" }] }, selection: { field: "scripts", aliases: ["workers", "include", "sources"], sourceKind: "cf_worker", mode: "list" }, runtime: "vector", recipe: "cloudflare" },
  { id: "cloudflare-ai-gateway", family: "cloudflare", package: "@logtura/driver-cloudflare-ai-gateway", displayName: "Cloudflare AI Gateway", aliases: ["ai_gateway", "cloudflare_ai_gateway"], credentials: cf, accountEnv: "CLOUDFLARE_ACCOUNT_ID", tokenPage: "https://dash.cloudflare.com/profile/api-tokens", connector: "cloudflare", connectMetadata: { permissionGroups: [{ key: "ai_gateway", type: "read" }] }, selection: { field: "gateways", aliases: ["include", "sources"], sourceKind: "cf_ai_gateway", mode: "list" }, runtime: "vector", recipe: "cloudflare" },
  { id: "fly-log-tail", family: "fly", package: "@logtura/driver-fly-log-tail", displayName: "Fly.io", aliases: ["fly", "fly_apps"], credentials: [token("FLY_API_TOKEN")], connector: "fly", selection: { field: "apps", aliases: ["include", "sources"], sourceKind: "fly_app", mode: "list" }, runtime: "vector", recipe: "fly" },
  { id: "railway-logs", family: "railway", package: "@logtura/driver-railway-logs", displayName: "Railway", aliases: ["railway", "railway_logs"], credentials: [token("RAILWAY_API_TOKEN"), { config: "project_id", runtime: "projectId", optional: true, sourceAliases: ["project_id", "projectId"] }, { config: "environment_id", runtime: "environmentId", optional: true, sourceAliases: ["environment_id", "environmentId"] }], accountAliases: ["environment_id", "environmentId"], tokenPage: "https://railway.com/account/tokens", connector: "railway", selection: { field: "services", aliases: ["include", "sources"], sourceKind: "railway_service", mode: "list", codec: "railway" }, runtime: "bun", recipe: "railway" },
  { id: "supabase-edge-logs", family: "supabase", package: "@logtura/driver-supabase-edge-logs", displayName: "Supabase", aliases: ["edge", "supabase_edge"], credentials: [{ config: "pat", runtime: "pat", env: "SUPABASE_PAT" }], accountEnv: "SUPABASE_PROJECT_REF", tokenPage: "https://supabase.com/dashboard/account/tokens", selection: { field: "functions", aliases: ["include"], sourceKind: "supabase_edge_fn", mode: "both", codec: "supabase", defaults: { gateway: true } }, runtime: "vector", recipe: "supabase" },
  { id: "custom-vector", family: "custom-vector", package: "@logtura/custom-vector", displayName: "Custom Vector", aliases: [], credentials: [], selection: { field: "sources", sourceKind: "custom_vector", mode: "list" }, runtime: "custom" },
  { id: "vercel-logs", family: "vercel", package: "@logtura/driver-vercel-logs", displayName: "Vercel", aliases: ["vercel", "vercel_logs"], credentials: [token("VERCEL_API_TOKEN")], accountAliases: ["team_id", "teamId"], tokenPage: "https://vercel.com/account/tokens", connector: "vercel", selection: { field: "projects", aliases: ["include", "sources"], sourceKind: "vercel_project", mode: "list" }, runtime: "bun", recipe: "vercel" },
];

export function providerDescriptor(id: string, catalog = PROVIDER_CATALOG): ProviderDescriptor | null {
  return catalog.find(entry => entry.id === id) ?? null;
}

export function providerFamily(family: string, catalog = PROVIDER_CATALOG): ProviderDescriptor | null {
  return catalog.find(entry => entry.family === family) ?? null;
}

export function defaultSourceSelection(id: string, catalog = PROVIDER_CATALOG): Record<string, unknown> {
  const descriptor = providerDescriptor(id, catalog);
  return descriptor ? { [descriptor.selection.field]: [], ...descriptor.selection.defaults } : { sources: [] };
}

export function providerDefaultCredentials(family: string, catalog = PROVIDER_CATALOG): Record<string, unknown> {
  return Object.fromEntries((providerFamily(family, catalog)?.credentials ?? []).filter(field => field.env).map(field => [field.config, `env:${field.env}`]));
}

export function decodeProviderCredentials(family: string, config: Record<string, unknown>, resolve: (value: unknown) => unknown, catalog = PROVIDER_CATALOG): Record<string, unknown> {
  const raw = config.credentials && typeof config.credentials === "object" && !Array.isArray(config.credentials) ? config.credentials as Record<string, unknown> : {};
  const descriptor = providerFamily(family, catalog);
  if (!descriptor) return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, resolve(value)]));
  return Object.fromEntries(descriptor.credentials.map(field => {
    const value = resolve(raw[field.config] ?? config[field.config]);
    return [field.runtime, typeof value === "string" ? value : field.optional ? null : ""];
  }));
}

export function validateProviderCatalog(catalog: readonly ProviderDescriptor[]): void {
  const ids = new Set<string>(), aliases = new Set<string>();
  for (const descriptor of catalog) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(descriptor.id) || ids.has(descriptor.id)) throw new Error(`Invalid or duplicate provider id: ${descriptor.id}`);
    ids.add(descriptor.id);
    if (!descriptor.family || !descriptor.selection.field || !descriptor.selection.sourceKind) throw new Error(`Incomplete provider descriptor: ${descriptor.id}`);
    for (const alias of descriptor.aliases) {
      if (aliases.has(alias)) throw new Error(`Duplicate provider alias: ${alias}`);
      aliases.add(alias);
    }
    const fields = new Set<string>();
    for (const field of descriptor.credentials) {
      if (!field.config || !field.runtime || fields.has(field.config)) throw new Error(`Invalid credential field: ${descriptor.id}`);
      fields.add(field.config);
    }
  }
}
