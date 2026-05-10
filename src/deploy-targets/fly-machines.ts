/**
 * Thin client for Fly's Machines API. Just enough to create an app
 * and a single Vector machine. We use `timberio/vector` directly and
 * inject vector.yaml as a `config.files` entry — no per-customer image
 * build needed.
 *
 * Auth: tokens from the cli_session flow may carry `FlyV1 ` or `Bearer `
 * depending on prefix (`fm1r_…`, `fm2_…` use FlyV1; everything else
 * Bearer). flyctl handles this in fly-go/auth.go.
 */

const MACHINES_BASE = "https://api.machines.dev";
const REST_BASE = "https://api.fly.io";

export class FlyApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "FlyApiError";
  }
}

export function flyAuthHeader(token: string): string {
  for (const part of token.split(",")) {
    const prefix = part.split("_")[0];
    if (prefix === "fm1r" || prefix === "fm2") return `FlyV1 ${token}`;
  }
  return `Bearer ${token}`;
}

async function flyFetch(
  url: string,
  authHeader: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", authHeader);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  console.log("fly_api_request", {
    url,
    method: init.method ?? "GET",
    auth_scheme: authHeader.split(" ")[0] ?? "?",
    auth_header_len: authHeader.length,
  });
  return fetch(url, { ...init, headers });
}

/**
 * Build a FlyApiError with the response body captured + a structured
 * log line so worker tail / ops_event downstream can correlate failed
 * Fly calls with the request that triggered them.
 */
async function flyError(
  op: string,
  url: string,
  res: Response,
): Promise<FlyApiError> {
  const body = await res.text();
  console.warn("fly_api_error", {
    op,
    url,
    status: res.status,
    body: body.slice(0, 800),
  });
  return new FlyApiError(`${op} failed: ${res.status}`, res.status, body);
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
  return (await res.json()) as FlyApp;
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
      body: body.slice(0, 800),
    });
    throw new FlyApiError(`createFlyApp 422`, res.status, body);
  }
  throw await flyError("createFlyApp", url, res);
}

export interface FlyMachineFile {
  guest_path: string;
  /** raw_value MUST be base64-encoded utf-8. */
  raw_value: string;
}

export interface FlyMachineConfig {
  image: string;
  env?: Record<string, string>;
  files?: FlyMachineFile[];
  init?: { cmd?: string[]; entrypoint?: string[] };
  guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number };
  restart?: { policy?: "no" | "always" | "on-failure" };
}

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  config: FlyMachineConfig;
  private_ip?: string;
}

export async function listFlyMachines(
  authHeader: string,
  appName: string,
): Promise<FlyMachine[]> {
  const url = `${MACHINES_BASE}/v1/apps/${appName}/machines`;
  const res = await flyFetch(url, authHeader);
  if (!res.ok) throw await flyError("listFlyMachines", url, res);
  return (await res.json()) as FlyMachine[];
}

export async function createFlyMachine(
  authHeader: string,
  input: {
    appName: string;
    name: string;
    region: string;
    config: FlyMachineConfig;
  },
): Promise<FlyMachine> {
  const url = `${MACHINES_BASE}/v1/apps/${input.appName}/machines`;
  const res = await flyFetch(url, authHeader, {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      region: input.region,
      config: input.config,
    }),
  });
  if (!res.ok) throw await flyError("createFlyMachine", url, res);
  return (await res.json()) as FlyMachine;
}

export async function updateFlyMachine(
  authHeader: string,
  input: {
    appName: string;
    machineId: string;
    config: FlyMachineConfig;
  },
): Promise<FlyMachine> {
  const url = `${MACHINES_BASE}/v1/apps/${input.appName}/machines/${input.machineId}`;
  const res = await flyFetch(url, authHeader, {
    method: "POST",
    body: JSON.stringify({ config: input.config }),
  });
  if (!res.ok) throw await flyError("updateFlyMachine", url, res);
  return (await res.json()) as FlyMachine;
}

/** Transition a machine to `started`. Required after
 *  `updateFlyMachine` because the update endpoint leaves the
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
    console.warn("fly_start_412_soft_ok", { url, body: bodySnippet });
    return { ok: false, status: res.status, bodySnippet };
  }
  console.warn("fly_api_error", {
    op: "startFlyMachine",
    url,
    status: res.status,
    body: bodySnippet,
  });
  throw new FlyApiError(`startFlyMachine failed: ${res.status}`, res.status, body);
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
      body: bodyText.slice(0, 500),
    });
    throw new FlyApiError(
      `resolveFlyOrgSlug failed: ${res.status}`,
      res.status,
      bodyText,
    );
  }
  let data: {
    data?: {
      organizations?: { nodes?: Array<{ slug?: string } | null> };
    };
    errors?: Array<{ message?: string }>;
  };
  try {
    data = JSON.parse(bodyText);
  } catch (err) {
    console.warn("fly_resolve_org_slug_parse_error", {
      body: bodyText.slice(0, 500),
    });
    throw new Error("Fly GraphQL returned non-JSON");
  }
  if (data.errors && data.errors.length > 0) {
    console.warn("fly_resolve_org_slug_graphql_errors", {
      errors: data.errors,
      body: bodyText.slice(0, 500),
    });
    throw new Error(
      `Fly GraphQL errors: ${data.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const nodes = data.data?.organizations?.nodes ?? [];
  // Defensive: nodes may contain null entries when the viewer has
  // partial visibility into an org. Filter them out and surface the
  // raw shape if we end up with nothing usable, so we can see why.
  const slugs = nodes
    .filter((n): n is { slug?: string } => n != null)
    .map((n) => n.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  if (slugs.length === 0) {
    console.warn("fly_resolve_org_slug_empty", {
      body: bodyText.slice(0, 500),
    });
    throw new Error("Fly account returned no usable org slugs");
  }
  const personal = slugs.find((s) => s === "personal");
  return personal ?? slugs[0]!;
}

/** base64-encode a UTF-8 string (Workers-compatible). */
export function base64Encode(s: string): string {
  // btoa works on latin-1; convert to utf-8 bytes first.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++)
    bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
