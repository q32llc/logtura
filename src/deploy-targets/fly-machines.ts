/** Service-side Fly bootstrap and legacy observation operations.
 * Managed machine creation/update/leases use the packaged public client. */

const MACHINES_BASE = "https://api.machines.dev";
const REST_BASE = "https://api.fly.io";

export class FlyApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "FlyApiError";
  }
}

export function flyAuthHeader(token: string): string {
  for (const part of token.split(",")) {
    const prefix = part.trim().split("_")[0];
    if (prefix === "fm1r" || prefix === "fm2") return `FlyV1 ${token}`;
  }
  return `Bearer ${token}`;
}

async function flyFetch(
  url: string,
  authHeader: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers();
  headers.set("authorization", authHeader);
  headers.set("accept", "application/json");
  if (init.body) {
    headers.set("content-type", "application/json");
  }
  console.log("fly_api_request", {
    url,
    method: init.method ?? "GET",
    auth_scheme: authHeader.split(" ")[0],
    auth_header_len: authHeader.length,
  });
  return fetch(url, { ...init, headers });
}

/**
 * Build a status-only FlyApiError with structured diagnostics so each
 * worker tail / ops_event record can correlate failed
 * Fly calls with the request that triggered them.
 */
async function flyError(
  op: string,
  url: string,
  res: Response,
): Promise<FlyApiError> {
  await res.body?.cancel();
  console.warn("fly_api_error", {
    op,
    url,
    status: res.status,
  });
  return new FlyApiError(`${op} failed: ${res.status}`, res.status);
}

async function readFlyJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error("Invalid Fly response");
  }
}

export interface FlyApp {
  name: string;
  organization: { slug: string };
  status?: string;
}

export async function getFlyApp(
  authHeader: string,
  appName: string,
): Promise<FlyApp | null> {
  const url = `${MACHINES_BASE}/v1/apps/${appName}`;
  const res = await flyFetch(url, authHeader);
  if (res.status === 404) return null;
  if (!res.ok) throw await flyError("getFlyApp", url, res);
  return await readFlyJson<FlyApp>(res);
}

export async function createFlyApp(
  authHeader: string,
  input: { appName: string; orgSlug: string },
): Promise<void> {
  const url = `${MACHINES_BASE}/v1/apps`;
  const res = await flyFetch(url, authHeader, {
    method: "POST",
    body: JSON.stringify({
      app_name: input.appName,
      org_slug: input.orgSlug,
    }),
  });
  if (res.status === 201 || res.status === 200) return;
  // Fly returns 422 with "name has already been taken" when the app
  // exists — we treat that as success here, since the caller checks
  // for existence first; this branch is just for the race.
  if (res.status === 422 || res.status === 409) {
    const body = await res.text();
    if (body.toLowerCase().includes("already")) return;
    console.warn("fly_api_error", {
      op: "createFlyApp",
      url,
      status: res.status,
    });
    throw new FlyApiError(`createFlyApp failed: ${res.status}`, res.status);
  }
  throw await flyError("createFlyApp", url, res);
}

export interface FlyMachineFile {
  guest_path: string;
  /** raw_value MUST be base64-encoded utf-8. */
  raw_value: string;
  mode?: number;
}

/** A health probe Fly runs from outside the container. `kind:
 *  informational` reports status without affecting LB routing — what
 *  we want for a single-machine forwarder where there's nothing to
 *  route to anyway. `kind: readiness` would also gate the LB pool. */
export interface MachineCheck {
  type: "tcp" | "http";
  port: number;
  /** Go duration string, e.g. "5s", "10s". */
  interval: string;
  timeout: string;
  /** Suppress checks for this long after machine start — gives the
   *  process time to bind its port without flapping critical. */
  grace_period?: string;
  kind?: "informational" | "readiness";
  /** HTTP-only fields. */
  method?: string;
  path?: string;
  protocol?: "http" | "https";
}

/** Status reported back by Fly on GET /machines/<id>. */
export interface MachineCheckStatus {
  name: string;
  status: "passing" | "warning" | "critical";
  output?: string;
  updated_at?: string;
}

/** Events emitted by the Fly machine state machine. Each entry has a
 *  `type` (start, exit, restart, launch, etc.) and a `timestamp` in
 *  unix-ms. We use exit events to detect crash-loops. */
export interface MachineEvent {
  id?: string;
  type: string;
  status?: string;
  source?: string;
  /** Unix milliseconds. */
  timestamp: number;
  request?: unknown;
}

export interface FlyMachineConfig {
  image: string;
  env?: Record<string, string>;
  files?: FlyMachineFile[];
  init?: { cmd?: string[]; entrypoint?: string[] };
  guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number };
  restart?: { policy?: "no" | "always" | "on-failure" };
  checks?: Record<string, MachineCheck>;
}

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  config: FlyMachineConfig;
  private_ip?: string;
  checks?: MachineCheckStatus[];
  events?: MachineEvent[];
}

export async function listFlyMachines(
  authHeader: string,
  appName: string,
): Promise<FlyMachine[]> {
  const url = `${MACHINES_BASE}/v1/apps/${appName}/machines`;
  const res = await flyFetch(url, authHeader);
  if (!res.ok) throw await flyError("listFlyMachines", url, res);
  return await readFlyJson<FlyMachine[]>(res);
}

/** Transition a machine to `started`. Required after
 *  a machine update because the update endpoint leaves the
 *  machine in its prior state. Returns whatever Fly says about the
 *  current state — wait_running is the source of truth for "is it
 *  actually running"; this call's job is just to nudge it. */
export async function startFlyMachine(
  authHeader: string,
  input: { appName: string; machineId: string },
): Promise<{ ok: boolean; status: number; bodySnippet: string }> {
  const url = `${MACHINES_BASE}/v1/apps/${input.appName}/machines/${input.machineId}/start`;
  const res = await flyFetch(url, authHeader, { method: "POST" });
  const body = await res.text();
  const bodySnippet = body.slice(0, 400);
  if (res.status === 200 || res.status === 201) {
    return { ok: true, status: res.status, bodySnippet };
  }
  // 412 is "precondition failed" — Fly returns this when the machine
  // can't be started right now (already starting, mid-update,
  // already started). Log + soft-succeed; wait_running will tell us
  // if the machine actually fails to reach `started`.
  if (res.status === 412) {
    console.warn("fly_start_412_soft_ok", { url, status: res.status });
    return { ok: false, status: res.status, bodySnippet };
  }
  console.warn("fly_api_error", {
    op: "startFlyMachine",
    url,
    status: res.status,
  });
  throw new FlyApiError(`startFlyMachine failed: ${res.status}`, res.status);
}

/**
 * Pick a Fly org slug for the connected token. The cli_session flow
 * doesn't return one directly, so we hit the GraphQL endpoint and
 * prefer "personal" when present (every account has one), falling
 * back to the first slug listed.
 *
 * NOTE: flyctl uses the TOP-LEVEL `organizations(admin: $admin)`
 * query, not `viewer.organizations`. The viewer path enforces a
 * field-level auth check that returns UNAUTHORIZED for cli_session
 * Macaroon tokens (the same tokens that work fine for app/machine
 * operations). Use the same query flyctl uses.
 */
export async function resolveFlyOrgSlug(authHeader: string): Promise<string> {
  const query = `query($admin: Boolean!) {
    organizations(admin: $admin) {
      nodes { slug }
    }
  }`;
  const res = await flyFetch(`${REST_BASE}/graphql`, authHeader, {
    method: "POST",
    body: JSON.stringify({ query, variables: { admin: false } }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    console.warn("fly_resolve_org_slug_http_error", {
      status: res.status,
    });
    throw new FlyApiError(
      `resolveFlyOrgSlug failed: ${res.status}`,
      res.status,
    );
  }
  const data = parseGraphql<{
    data?: { organizations?: { nodes?: Array<{slug?: string} | null> } };
  }>(bodyText);
  const nodes = data.data?.organizations?.nodes ?? [];
  if(!Array.isArray(nodes)) throw new Error("Invalid Fly organization inventory");
  // Defensive: nodes may contain null entries when the viewer has
  // partial visibility into an org. Filter them without logging provider data.
  const slugs = nodes
    .filter((n): n is { slug?: string } => n != null)
    .map((n) => n.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  if (slugs.length === 0) {
    console.warn("fly_resolve_org_slug_empty");
    throw new Error("Fly account returned no usable org slugs");
  }
  const personal = slugs.find((s) => s === "personal");
  return personal ?? slugs[0]!;
}

/** Read only the GraphQL envelope; upstream bodies and error messages can
 * contain credentials and must never be copied into exception text. */
function parseGraphql<T>(text: string): T {
  let value: unknown;
  try {value=JSON.parse(text);} catch {throw new Error("Fly GraphQL returned non-JSON");}
  if(!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Fly GraphQL response");
  const envelope=value as {errors?: unknown;data?: unknown};
  if(envelope.errors !== undefined && envelope.errors !== null && (!Array.isArray(envelope.errors) || envelope.errors.length)) throw new Error("Fly GraphQL request failed");
  if(envelope.data !== undefined && envelope.data !== null && (typeof envelope.data !== "object" || Array.isArray(envelope.data))) throw new Error("Invalid Fly GraphQL response");
  return value as T;
}

export interface FlyOrg {
  /** GraphQL Node ID — what `createLimitedAccessToken` wants. */
  id: string;
  /** URL-safe org name — what the user sees and what we store on the
   *  deploy_target row's external_account_id. */
  slug: string;
}

/** Fetch the orgs visible to the bound token, returning both slug and
 *  node id. `resolveFlyOrgSlug` is sufficient when we only need the
 *  slug at deploy time; the token-mint path needs the ID too. */
export async function listFlyOrgs(authHeader: string): Promise<FlyOrg[]> {
  const query = `query($admin: Boolean!) {
    organizations(admin: $admin) {
      nodes { id slug }
    }
  }`;
  const res = await flyFetch(`${REST_BASE}/graphql`, authHeader, {
    method: "POST",
    body: JSON.stringify({ query, variables: { admin: false } }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new FlyApiError(
      `listFlyOrgs failed: ${res.status}`,
      res.status,
    );
  }
  const data = parseGraphql<{data?: {organizations?: {nodes?: Array<{id?: string;slug?: string} | null>}}}>(bodyText);
  const out: FlyOrg[] = [];
  const nodes=data.data?.organizations?.nodes ?? [];
  if(!Array.isArray(nodes)) throw new Error("Invalid Fly organization inventory");
  for (const n of nodes) {
    if (n && typeof n.id === "string" && n.id && typeof n.slug === "string" && n.slug) {
      out.push({ id: n.id, slug: n.slug });
    }
  }
  return out;
}

/**
 * Mint a scoped child token via Fly's `createLimitedAccessToken`
 * GraphQL mutation. Profile strings come from fly-go: "deploy" (one
 * app), "deploy_organization" (one org, full perms), "litefs_cloud",
 * "machine_exec". For "read-only org" tokens, flyctl mints with
 * `deploy_organization` and then attenuates the resulting macaroon
 * client-side by appending a `Mask: ActionRead` caveat + recomputing
 * the HMAC chain. The Fly target adapter performs that attenuation before
 * storing a source credential; this helper only performs the mint request.
 *
 * Returns the FlyV1-formatted header string (`fm2_...,fm2_...`).
 */
export async function createLimitedAccessToken(
  authHeader: string,
  input: {
    name: string;
    organizationId: string;
    profile: "deploy" | "deploy_organization" | "litefs_cloud" | "machine_exec";
    profileParams?: Record<string, unknown>;
    /** Go duration string, e.g. "8760h". Default ~20 years matches
     *  flyctl's CLI default — we don't enforce shorter here because
     *  the credential is rotatable from the dashboard anyway. */
    expiry?: string;
  },
): Promise<string> {
  const mutation = `mutation CreateLimitedAccessToken(
    $input: CreateLimitedAccessTokenInput!
  ) {
    createLimitedAccessToken(input: $input) {
      limitedAccessToken { tokenHeader }
    }
  }`;
  const variables = {
    input: {
      name: input.name,
      organizationId: input.organizationId,
      profile: input.profile,
      profileParams: input.profileParams ?? {},
      expiry: input.expiry ?? "175200h", // 20 years
    },
  };
  const res = await flyFetch(`${REST_BASE}/graphql`, authHeader, {
    method: "POST",
    body: JSON.stringify({ query: mutation, variables }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new FlyApiError(
      `createLimitedAccessToken failed: ${res.status}`,
      res.status,
    );
  }
  const data=parseGraphql<{data?: {createLimitedAccessToken?: {limitedAccessToken?: {tokenHeader?: unknown}}}}>(bodyText);
  const tokenHeader =
    data.data?.createLimitedAccessToken?.limitedAccessToken?.tokenHeader;
  if (typeof tokenHeader !== "string" || !tokenHeader) {
    throw new Error("Fly returned no tokenHeader from createLimitedAccessToken");
  }
  return tokenHeader;
}
