import type {
  ApiBundle,
  ApiConnection,
  ApiDeployTargetDriver,
  ApiDestination,
  ApiDestinationDriver,
  ApiJob,
  ApiMonitor,
  ApiProvider,
  ApiSinkRecord,
  ApiSource,
  ApiTargetBundle,
  ApiUser,
} from "../web/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok) {
    const data = json as { error?: string; message?: string } | null;
    throw new ApiError(
      data?.message ?? data?.error ?? `HTTP ${res.status}`,
      res.status,
      data?.error,
    );
  }
  return json as T;
}

export const api = {
  me: () => request<{ user: ApiUser | null }>("/me"),
  providers: () => request<{ providers: ApiProvider[] }>("/providers"),
  listConnections: () =>
    request<{ connections: ApiConnection[] }>("/connections"),
  createConnection: (form: FormData) =>
    request<{ connection: ApiConnection }>("/connections", {
      method: "POST",
      body: form,
    }),
  getConnection: (id: string) =>
    request<{
      connection: ApiConnection;
      sources: ApiSource[];
      latestDiscoveryJob: ApiJob | null;
    }>(`/connections/${id}`),
  setSourceSelections: (id: string, selectedSourceIds: string[]) =>
    request<{ sources: ApiSource[] }>(`/connections/${id}/sources`, {
      method: "POST",
      body: JSON.stringify({ selectedSourceIds }),
    }),
  rediscover: (id: string) =>
    request<{ job: ApiJob; deduped: boolean }>(
      `/connections/${id}/discover`,
      { method: "POST" },
    ),
  getJob: (id: string) => request<{ job: ApiJob }>(`/jobs/${id}`),
  deleteConnection: (id: string) =>
    request<{ ok: true }>(`/connections/${id}`, { method: "DELETE" }),
  getBundle: (id: string) => request<ApiBundle>(`/connections/${id}/bundle`),

  // ----- Destinations / Monitors / Sinks ------------------------------
  destinationDrivers: () =>
    request<{ drivers: ApiDestinationDriver[] }>("/destinations/drivers"),
  listDestinations: () =>
    request<{ destinations: ApiDestination[] }>("/destinations"),
  createDestination: (form: FormData) =>
    request<{ destination: ApiDestination }>("/destinations", {
      method: "POST",
      body: form,
    }),
  deleteDestination: (id: string) =>
    request<{ ok: true }>(`/destinations/${id}`, { method: "DELETE" }),

  listMonitors: () =>
    request<{ monitors: ApiMonitor[]; sinks: ApiSinkRecord[] }>("/monitors"),
  createMonitor: (body: {
    displayName: string;
    filterKind: string;
    filterConfig?: unknown;
    connectionId?: string | null;
    enabled?: boolean;
  }) =>
    request<{ monitor: ApiMonitor }>("/monitors", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateMonitor: (
    id: string,
    body: {
      displayName?: string;
      filterKind?: string;
      filterConfig?: unknown;
      connectionId?: string | null;
      enabled?: boolean;
    },
  ) =>
    request<{ monitor: ApiMonitor }>(`/monitors/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteMonitor: (id: string) =>
    request<{ ok: true }>(`/monitors/${id}`, { method: "DELETE" }),
  addSink: (
    monitorId: string,
    body: {
      destinationId: string;
      filterKind?: string | null;
      filterConfig?: unknown;
    },
  ) =>
    request<{ sink: ApiSinkRecord }>(`/monitors/${monitorId}/sinks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSink: (id: string) =>
    request<{ ok: true }>(`/sinks/${id}`, { method: "DELETE" }),

  // ----- Deploy targets ------------------------------------------------
  deployTargetDrivers: () =>
    request<{ drivers: ApiDeployTargetDriver[] }>("/deploy-targets/drivers"),
  getTargetBundle: (
    connectionId: string,
    target: string,
    name?: string,
    region?: string,
  ) => {
    const params = new URLSearchParams({ target });
    if (name) params.set("name", name);
    if (region) params.set("region", region);
    return request<ApiTargetBundle>(
      `/connections/${connectionId}/bundle?${params.toString()}`,
    );
  },
};
