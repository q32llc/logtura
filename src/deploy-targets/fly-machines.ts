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
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", flyAuthHeader(token));
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

export interface FlyApp {
  name: string;
  organization: { slug: string };
  status?: string;
}

export async function getFlyApp(
  token: string,
  appName: string,
): Promise<FlyApp | null> {
  const res = await flyFetch(`${MACHINES_BASE}/v1/apps/${appName}`, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new FlyApiError(
      `getFlyApp failed: ${res.status}`,
      res.status,
      await res.text(),
    );
  }
  return (await res.json()) as FlyApp;
}

export async function createFlyApp(
  token: string,
  input: { appName: string; orgSlug: string },
): Promise<void> {
  const res = await flyFetch(`${MACHINES_BASE}/v1/apps`, token, {
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
    throw new FlyApiError(`createFlyApp 422`, res.status, body);
  }
  throw new FlyApiError(
    `createFlyApp failed: ${res.status}`,
    res.status,
    await res.text(),
  );
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
  token: string,
  appName: string,
): Promise<FlyMachine[]> {
  const res = await flyFetch(
    `${MACHINES_BASE}/v1/apps/${appName}/machines`,
    token,
  );
  if (!res.ok) {
    throw new FlyApiError(
      `listFlyMachines failed: ${res.status}`,
      res.status,
      await res.text(),
    );
  }
  return (await res.json()) as FlyMachine[];
}

export async function createFlyMachine(
  token: string,
  input: {
    appName: string;
    name: string;
    region: string;
    config: FlyMachineConfig;
  },
): Promise<FlyMachine> {
  const res = await flyFetch(
    `${MACHINES_BASE}/v1/apps/${input.appName}/machines`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        region: input.region,
        config: input.config,
      }),
    },
  );
  if (!res.ok) {
    throw new FlyApiError(
      `createFlyMachine failed: ${res.status}`,
      res.status,
      await res.text(),
    );
  }
  return (await res.json()) as FlyMachine;
}

export async function updateFlyMachine(
  token: string,
  input: {
    appName: string;
    machineId: string;
    config: FlyMachineConfig;
  },
): Promise<FlyMachine> {
  const res = await flyFetch(
    `${MACHINES_BASE}/v1/apps/${input.appName}/machines/${input.machineId}`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ config: input.config }),
    },
  );
  if (!res.ok) {
    throw new FlyApiError(
      `updateFlyMachine failed: ${res.status}`,
      res.status,
      await res.text(),
    );
  }
  return (await res.json()) as FlyMachine;
}

/**
 * Pick a Fly org slug for the connected token. The cli_session flow
 * doesn't return one directly, so we hit the GraphQL viewer endpoint
 * and prefer "personal" when present (every account has one), falling
 * back to the first slug listed.
 */
export async function resolveFlyOrgSlug(token: string): Promise<string> {
  const query = `query { viewer { organizations { nodes { slug } } } }`;
  const res = await flyFetch(`${REST_BASE}/graphql`, token, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new FlyApiError(
      `resolveFlyOrgSlug failed: ${res.status}`,
      res.status,
      await res.text(),
    );
  }
  const data = (await res.json()) as {
    data?: { viewer?: { organizations?: { nodes?: Array<{ slug: string }> } } };
  };
  const slugs =
    data.data?.viewer?.organizations?.nodes?.map((n) => n.slug) ?? [];
  if (slugs.length === 0) {
    throw new Error("Fly account has no organizations");
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
